# Transactional Outbox Pattern

This document describes the transactional outbox pattern implemented in LumenBazaar to prevent database state and asynchronous jobs from diverging when a process fails between committing a record and publishing its queue event.

## Overview

The outbox pattern ensures **exactly-once semantics** for event delivery by making database state mutations and event persistence atomic within a single transaction. Instead of directly publishing to queues after database commits (which creates a "commit-then-publish" vulnerability), events are persisted to an `outbox_events` table as part of the same transaction that creates the state change.

A separate **outbox relay worker** periodically claims batches of pending events, delivers them to handlers, and marks them as delivered only after confirmation. This design provides:

- **Atomicity**: State and event are committed or rolled back together
- **Durability**: Events are persisted, so no job is lost if the process crashes between commit and publish
- **Idempotency**: Consumers deduplicate on event ID, so redelivery doesn't cause duplicate side effects
- **Ordering**: Events for the same aggregate are delivered in order
- **Crash recovery**: Leased locks on claimed events expire, allowing other workers to reclaim them

## Event Types

The outbox tracks four aggregate types and their event types:

### Settlement Events
- **`settlement.confirmed`**: Recorded when a payment settlement succeeds
- **`settlement.reconciliation_enqueued`**: Triggers settlement reconciliation job when a settlement requires later confirmation

### Receipt Events
- **`receipt.status_changed`**: Notifies downstream systems (webhooks, notifications) when a receipt status changes

### Resource Events
- **`resource.indexed`**: Triggers resource indexing and search document creation when a resource is created or updated

### Catalog Events
- **`catalog.resource_cataloged`**: Tracks successful resource cataloging for audit and analytics

## Database Schema

### OutboxEvent Table

```sql
CREATE TABLE "OutboxEvent" (
  id TEXT PRIMARY KEY,
  aggregateType TEXT NOT NULL,        -- "settlement", "receipt", "resource", "catalog"
  aggregateId TEXT NOT NULL,          -- ID of the aggregate (settlement/receipt/resource/catalogEvent)
  eventType TEXT NOT NULL,            -- e.g., "settlement.confirmed"
  payloadVersion INT NOT NULL DEFAULT 1,
  payload JSONB NOT NULL,             -- Event data (allowlisted fields only, no secrets)
  status TEXT NOT NULL DEFAULT 'pending', -- "pending", "processing", "delivered", "dead"
  attemptCount INT NOT NULL DEFAULT 0,
  nextAttemptAt TIMESTAMP NOT NULL,
  lockedBy TEXT,                      -- Worker ID claiming the batch
  lockExpiresAt TIMESTAMP,            -- Lease expiry for crash recovery
  lastError TEXT,                     -- Truncated, redacted error message (max 500 chars)
  deliveredAt TIMESTAMP,              -- When status changed to "delivered"
  createdAt TIMESTAMP NOT NULL DEFAULT NOW(),
  updatedAt TIMESTAMP NOT NULL DEFAULT NOW(),

  UNIQUE (aggregateType, aggregateId, eventType, createdAt),
  INDEX (status, nextAttemptAt),      -- Relay query
  INDEX (status, createdAt),          -- Cleanup query
  INDEX (aggregateType, aggregateId),
  INDEX (lockedBy, lockExpiresAt)     -- Crash recovery
);
```

### ProcessedOutboxEvent Table

Idempotency tracking table: records which consumers have already processed each event.

```sql
CREATE TABLE "ProcessedOutboxEvent" (
  id TEXT PRIMARY KEY,
  outboxEventId TEXT NOT NULL UNIQUE,
  aggregateType TEXT NOT NULL,
  aggregateId TEXT NOT NULL,
  eventType TEXT NOT NULL,
  consumerId TEXT NOT NULL,           -- Handler that processed this event
  processedAt TIMESTAMP NOT NULL DEFAULT NOW(),

  UNIQUE (outboxEventId, consumerId), -- Idempotency key
  INDEX (aggregateType, aggregateId, consumerId)
);
```

## Writing Outbox Events

When a state mutation occurs in a database transaction, write an outbox event in the same transaction:

### Example: Settlement Confirmation

```typescript
import { writeOutboxEvent } from "@lumenbazaar/shared";

async recordConfirmed(input: ConfirmedPaymentStateInput) {
  const result = await this.client.$transaction(async (tx) => {
    // Create settlement and receipt
    const settlement = await tx.settlement.create({
      data: settlementData(input.settlement)
    });
    const receipt = await tx.receipt.create({
      data: receiptData(input.receipt)
    });

    // Write outbox event in same transaction
    await writeOutboxEvent(tx, {
      aggregateType: "receipt",
      aggregateId: receipt.id,
      eventType: "receipt.status_changed",
      payload: {
        receiptId: receipt.id,
        sellerId: receipt.sellerId,
        status: receipt.status,
        amount: receipt.amount,
        assetCode: receipt.assetCode,
        assetIssuer: receipt.assetIssuer,
        settledAt: receipt.settledAt
        // Note: No secrets, raw payment signatures, or authorization tokens
      }
    });

    return { settlement, receipt };
  });
  // Events are now durable; relay worker will pick them up
  return result;
}
```

### Payload Safety

Payloads must:
- Include **only allowlisted fields**. Never spread entire records.
- Exclude secrets, private keys, signed payloads, and authorization tokens.
- Be JSON-serializable.
- Use explicit field mapping for every value.

## Outbox Relay Worker

The outbox relay worker (`apps/worker/src/workers/outboxRelay.ts`) processes pending outbox events:

### How It Works

1. **Claim**: Selects pending events with `SELECT ... FOR UPDATE SKIP LOCKED`, setting `status = "processing"` and acquiring a lease (30-60 second expiry).
2. **Order**: Events are ordered by `aggregateType`, `aggregateId`, `createdAt` to maintain per-aggregate ordering.
3. **Deliver**: Routes each event to its consumer handler (resource indexing, settlement reconciliation, receipt finalization, catalog indexing).
4. **Deduplicate**: Checks if the event was already processed by this consumer using the `ProcessedOutboxEvent` table. If yes, skip to step 5.
5. **Confirm**: After consumer handler succeeds, writes a `ProcessedOutboxEvent` record (in same transaction as handler side effects).
6. **Mark Delivered**: Sets `status = "delivered"`, clears the lock, and sets `deliveredAt` timestamp.
7. **Retry or Dead-Letter**: On handler failure, increments `attemptCount`, schedules retry with exponential backoff (1s, 2s, 4s, ..., capped at 32s), and moves to dead-letter (`status = "dead"`) after 10 failed attempts.

### Crash Recovery

If the relay worker crashes:
- Claimed events remain locked with an expiry timestamp.
- When the lease expires, other workers can reclaim the rows via `SELECT ... FOR UPDATE SKIP LOCKED`.
- Re-delivery is safe because consumer handlers record a `ProcessedOutboxEvent` before marking delivered, so duplicates are deduplicated.

### Concurrency

- Row-level locking (`FOR UPDATE SKIP LOCKED`) prevents multiple workers from claiming the same event.
- Multiple relay workers can run in parallel on different rows.
- No shared state between workers except the database.

## Idempotency

Consumer handlers must implement idempotency:

1. Before processing an event, check `isOutboxEventProcessed(db, eventId, consumerId)`.
2. If already processed, skip handler execution and return success.
3. If not processed, execute the handler.
4. In the same transaction as handler side effects, call `recordProcessedOutboxEvent(tx, eventId, consumerId, ...)`.
5. If the transaction commits, mark the outbox event as delivered.
6. If the transaction rolls back (or crashes before marking delivered), the event remains in `processing` state, the lease expires, and the event is redelivered. The idempotency check prevents duplicate side effects.

## Retry and Dead-Letter Policy

- **Max Attempts**: 10 (configurable via `handleOutboxRelay` parameter `MAX_RETRY_ATTEMPTS`)
- **Backoff**: Exponential with jitter: 1s, 2s, 4s, 8s, 16s, 32s, 32s, 32s, 32s, 32s
- **Dead-Letter**: After 10 attempts, event moves to `status = "dead"` with `lastError` truncated and redacted.
- **Poison Events**: Malformed payloads or permanent handler errors move to dead-letter immediately (no retry).

## Retention Policy

Delivered outbox events are retained for **30 days** by default, then cleaned up by the `outboxCleanup` worker:

- Deletes `ProcessedOutboxEvent` records older than retention period.
- Deletes `OutboxEvent` records with `status = "delivered"` and `deliveredAt` older than retention period.
- **Dead-letter events are kept indefinitely** for inspection and manual requeue.

### Cleanup Job

Scheduled daily (or on-demand):

```typescript
import { handleOutboxCleanup } from "@lumenbazaar/shared";

// Run cleanup
const deletedCount = await handleOutboxCleanup(
  job,
  config,
  { db: prismaClient }
);
```

## Dead-Letter Inspection and Requeue

Dead-letter events require operator intervention:

```sql
-- View dead-letter events
SELECT * FROM "OutboxEvent"
WHERE status = 'dead'
ORDER BY createdAt DESC
LIMIT 20;

-- Inspect error
SELECT id, lastError, attemptCount, payload
FROM "OutboxEvent"
WHERE id = 'outbox_...'
AND status = 'dead';

-- Manual requeue (after fix)
UPDATE "OutboxEvent"
SET
  status = 'pending',
  attemptCount = 0,
  nextAttemptAt = NOW(),
  lastError = NULL
WHERE id = 'outbox_...'
AND status = 'dead';
```

An audit log entry should be recorded when manually requeueing to track who intervened and why.

## Testing

### Unit Tests

- **Atomicity**: State mutation and outbox insert commit or roll back together.
- **Crash Boundaries**: Test crash scenarios (before commit, after commit, after claim, after handoff, after marking delivered).
- **Idempotency**: Same event delivered twice produces one side effect.
- **Concurrency**: Multiple relay workers never double-process a row.
- **Poison Events**: Bounded retries, then dead-letter, without blocking subsequent events.
- **Retry Timing**: Exponential backoff with correct timing.
- **Producer Coverage**: Each settlement, receipt, resource, and catalog mutation emits exactly one outbox event.
- **Redaction**: Payloads and `lastError` contain no secrets.

### Integration Tests

Use a real database (e.g., `SHARED_DB_TEST_DATABASE_URL` for shared tests, `CATALOG_PERSISTENCE_TEST_DATABASE_URL` for catalog tests).

## Delivery Guarantee

**At-least-once**: Events are delivered at least once. Duplicates are deduplicated by consumer handlers.

**Not exactly-once**: The outbox pattern provides at-least-once, not exactly-once. Consumers must implement idempotency.

## Ordering Guarantee

**Per-aggregate**: Events for the same aggregate (same `aggregateType` and `aggregateId`) are delivered in order of creation (`createdAt`).

**No global ordering**: Events across different aggregates may be delivered in any order.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ Producer (e.g., Payment Settlement)                             │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  await db.$transaction(async (tx) => {                          │
│    const settlement = await tx.settlement.create(...);          │
│    const receipt = await tx.receipt.create(...);                │
│    await writeOutboxEvent(tx, {                                 │
│      aggregateType: "receipt",                                  │
│      aggregateId: receipt.id,                                   │
│      eventType: "receipt.status_changed",                       │
│      payload: {...}                                             │
│    });                                                           │
│  });                                                             │
│                                                                  │
│  // State and event are committed atomically                    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Database: OutboxEvent Table                                      │
├─────────────────────────────────────────────────────────────────┤
│ id | aggregateType | aggregateId | eventType | status | payload │
│ ── | ────────────  | ─────────── | ───────── | ────── | ─────── │
│ … | receipt       | receipt_123 | status... | pending| {...}   │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Outbox Relay Worker (Multiple instances OK)                     │
├─────────────────────────────────────────────────────────────────┤
│ 1. SELECT ... FOR UPDATE SKIP LOCKED (claim batch)              │
│ 2. For each event, route to consumer handler                    │
│ 3. Consumer handler:                                             │
│    - Check idempotency (ProcessedOutboxEvent)                   │
│    - Execute side effects (enqueue job, notify webhook, etc.)   │
│    - Record processed in same transaction                       │
│ 4. If success: UPDATE status = 'delivered'                      │
│ 5. If failure: Schedule retry with exponential backoff          │
│ 6. After 10 attempts: Move to dead-letter (status = 'dead')     │
└─────────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────────┐
│ Consumer Handlers                                                │
├─────────────────────────────────────────────────────────────────┤
│ - Resource Indexing Job (searches, discovery)                   │
│ - Settlement Reconciliation (blockchain confirmation)           │
│ - Receipt Finalization (webhook delivery)                       │
│ - Catalog Indexing (resource discovery)                         │
└─────────────────────────────────────────────────────────────────┘
```

## Migration Steps

When implementing the outbox pattern for a new event type:

1. Add Prisma model to `prisma/schema.prisma` (already done for `OutboxEvent` and `ProcessedOutboxEvent`).
2. Create migration (`prisma migrate dev`).
3. Write `writeOutboxEvent()` call in producer transaction.
4. Remove old "commit-then-publish" code (e.g., direct `queue.add()` calls).
5. Implement consumer handler in outbox relay worker.
6. Update producer test to verify outbox event is written.
7. Write outbox relay test for consumer handler.
8. Add idempotency check in consumer handler.

## References

- [Transactional Outbox Pattern](https://microservices.io/patterns/data/transactional-outbox.html)
- [Chris Richardson - Event Sourcing](https://microservices.io/patterns/data/event-sourcing.html)
- [Outbox Pattern in Practice](https://www.kamilgrzybek.com/design/the-outbox-pattern/)
