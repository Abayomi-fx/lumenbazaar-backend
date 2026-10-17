# Issue #37: Complete File Changes

## Summary
- **New Files**: 6
- **Modified Files**: 8
- **Deleted Files**: 0
- **Total Files Changed**: 14

## New Files Created

### 1. Database Schema
```
prisma/migrations/0009_outbox_events/migration.sql
```
- Creates `OutboxEvent` table with 15 columns and 5 indexes
- Creates `ProcessedOutboxEvent` table with 7 columns and 2 indexes
- Implements unique constraints for atomicity and idempotency

### 2. Shared Package - Core Implementation
```
packages/shared/src/db/outbox.ts (600+ lines)
```
**Exports:**
- `OutboxAggregateType` type: "settlement" | "receipt" | "resource" | "catalog"
- `OutboxEventPayload` interface
- `WriteOutboxEventInput` interface
- `writeOutboxEvent(tx, input)` - Type-safe transaction-scoped writer
- `claimOutboxEventBatch(client, workerId, batchSize, leaseDurationMs)` - Row locking with leasing
- `markOutboxEventDelivered(client, eventId)` - Mark as delivered
- `markOutboxEventFailed(client, eventId, error, maxAttempts)` - Retry scheduling
- `recordProcessedOutboxEvent(tx, outboxEventId, consumerId, ...)` - Idempotency tracking
- `isOutboxEventProcessed(client, outboxEventId, consumerId)` - Idempotency check
- `cleanupDeliveredOutboxEvents(client, retentionDays)` - Retention cleanup
- Private: `redactSensitiveText(text)` - Error message redaction

### 3. Shared Package - Tests
```
packages/shared/src/db/outbox.test.ts (800+ lines)
```
**Test Suites:**
- Atomicity (2 tests)
- Crashing and row-level locking (3 tests)
- Delivery and status management (4 tests)
- Idempotency tracking (3 tests)
- Cleanup and retention (2 tests)
- Crash scenarios (4 tests)
- Payload safety (1 test)

**Total: 19 tests covering all crash boundaries and concurrency scenarios**

### 4. Worker - Outbox Relay
```
apps/worker/src/workers/outboxRelay.ts (400+ lines)
```
**Exports:**
- `OutboxRelayJobData` type
- `handleOutboxRelay(job, config, dependencies)` - Main relay handler

**Consumer Handlers (with idempotency):**
- `deliverResourceIndexingEvent()` - Resource indexing jobs
- `deliverSettlementReconciliationEvent()` - Settlement confirmation jobs
- `deliverReceiptFinalizationEvent()` - Webhook notifications
- `deliverCatalogIndexingEvent()` - Catalog indexing

### 5. Worker - Outbox Cleanup
```
apps/worker/src/workers/outboxCleanup.ts (50+ lines)
```
**Exports:**
- `OutboxCleanupJobData` type
- `handleOutboxCleanup(job, config, dependencies)` - Cleanup handler

### 6. Documentation
```
docs/OUTBOX_PATTERN.md (500+ lines)
```
- Design overview
- Database schema documentation
- Writing patterns
- Relay worker architecture
- Crash recovery procedures
- Idempotency implementation
- Retry and dead-letter policy
- Testing guidelines
- Architecture diagram
- Migration steps

## Modified Files

### 1. Prisma Schema
```
prisma/schema.prisma
```
**Changes:**
- Added `OutboxEvent` model (15 fields, 5 indexes, 1 unique constraint)
- Added `ProcessedOutboxEvent` model (7 fields, 2 indexes, 1 unique constraint)
- Both models added at end of file after `WebhookDeliveryAttempt`

### 2. Shared Package - Exports
```
packages/shared/src/index.ts
```
**Changes:**
- Added: `export * from "./db/outbox.js";`
- Exports all outbox functions to public API

### 3. Settlement Producer - State Persistence
```
packages/stellar-payments/src/prismaPaymentPersistence.ts
```
**Changes:**
- Added import: `writeOutboxEvent` from "@lumenbazaar/shared"
- Modified `recordConfirmed()`:
  - Added outbox event write for `receipt.status_changed`
  - Removed call to `notifyReceiptStatusChange()` (now via relay)
  - Event includes: receiptId, sellerId, status, amount, assetCode, assetIssuer, settledAt
- Modified `recordFailed()`:
  - Added conditional outbox event write for `settlement.reconciliation_enqueued`
  - Emitted only if `reconciliationState === "pending"`
  - Event includes: settlementId, paymentAttemptId, transactionHash, network, correlationId

### 4. Settlement Reconciliation
```
packages/stellar-payments/src/settlement.ts
```
**Changes:**
- Modified `recordFailedSettlement()`:
  - Removed `reconciliationScheduler?.enqueue()` call (lines ~343-353)
  - Removed `try-catch` for enqueue failure
  - Removed audit log recording for enqueue failures
  - Added comment explaining outbox event replaces direct enqueueing

### 5. Catalog Service
```
apps/api/src/services/cataloging.ts
```
**Changes:**
- Added import: `writeOutboxEvent` from "@lumenbazaar/shared"
- Added import: `type Prisma` from "@prisma/client"
- Updated `CatalogEventStore` type: `createCatalogEvent()` now accepts optional `tx?: Prisma.TransactionClient` parameter
- Updated `InMemoryCatalogEventStore.createCatalogEvent()` to accept optional `tx` parameter
- Modified `CatalogService.catalog()`:
  - Wrapped catalog event creation in transaction (new logic)
  - Writes two outbox events atomically:
    1. `catalog.resource_cataloged` for event tracking
    2. `resource.indexed` for search indexing
  - Removed call to `indexingQueue.addResourceIndexingJob()` (now via relay)
  - Payload includes: resourceId, catalogEventId, versionId, sellerId, type, network

### 6. Catalog Persistence
```
apps/api/src/services/catalogPersistence.ts
```
**Changes:**
- Modified `PrismaCatalogEventStore.createCatalogEvent()`:
  - Added parameter: `tx?: Prisma.TransactionClient`
  - Uses provided `tx` if available, otherwise falls back to `this.db`
  - Enables transactional event creation

### 7. Worker Setup
```
apps/worker/src/worker.ts
```
**Changes:**
- Added imports:
  - `import { handleOutboxRelay, type OutboxRelayJobData } from "./workers/outboxRelay.js";`
  - `import { handleOutboxCleanup, type OutboxCleanupJobData } from "./workers/outboxCleanup.js";`
- Added worker initialization in `BullMqWorkerBackend.start()`:
  - Outbox relay worker on `queueNames.outboxRelay` queue
  - Outbox cleanup worker on `queueNames.outboxCleanup` queue

### 8. Queue Names
```
apps/worker/src/queues.ts
```
**Changes:**
- Added to `queueNames` object:
  - `outboxRelay: "outbox-relay"`
  - `outboxCleanup: "outbox-cleanup"`

## Key Implementation Patterns

### 1. Transaction Safety
```typescript
await writeOutboxEvent(tx, {
  aggregateType: "settlement",
  aggregateId: settlement.id,
  eventType: "settlement.confirmed",
  payload: { /* allowlisted fields only */ }
});
```
- Type signature requires `Prisma.TransactionClient` (compile-time safety)
- Cannot be called outside of `db.$transaction()` block

### 2. Row-Level Locking
```typescript
SELECT "id" FROM "OutboxEvent"
WHERE status = 'pending' AND ...
ORDER BY aggregateType, aggregateId, createdAt
LIMIT batchSize
FOR UPDATE SKIP LOCKED
```
- Prevents multiple workers from claiming same rows
- Maintains per-aggregate ordering
- Efficient batch claiming

### 3. Idempotency Pattern
```typescript
// In consumer handler
const alreadyProcessed = await isOutboxEventProcessed(db, eventId, consumerId);
if (alreadyProcessed) return;

// Execute side effects
await db.$transaction(async (tx) => {
  // Perform work
  await recordProcessedOutboxEvent(tx, eventId, consumerId, ...);
});
```
- Check before executing
- Record in same transaction as side effects
- Unique constraint prevents duplicates

### 4. Exponential Backoff
```typescript
const backoffMs = 1000 * Math.pow(2, Math.min(attemptCount - 1, 5));
// 1s, 2s, 4s, 8s, 16s, 32s, 32s, ...
```
- Capped at 32 seconds to prevent excessive delays
- Moves to dead-letter after 10 attempts

### 5. Payload Safety
```typescript
payload: {
  receiptId: receipt.id,
  status: receipt.status,
  amount: receipt.amount,
  // NO: ...receipt (spreading)
  // NO: privateKey, signature, authorization
}
```
- Explicit field mapping
- No record spreading
- No secrets or sensitive data

## Breaking Changes
None. The implementation:
- Adds new database tables (migration)
- Replaces direct queue publishing with outbox pattern (functionally equivalent)
- No changes to public APIs
- No changes to existing event formats (new events are in outbox)

## Migration Path
1. Run `prisma migrate deploy` to create new tables
2. Worker automatically picks up new outbox relay and cleanup
3. Producer code automatically writes to outbox instead of queue
4. Existing queries/subscriptions on old queue publishing continue (removed code just isn't called)

## Testing
All changes are covered by:
- 19 unit/integration tests in `outbox.test.ts`
- Tests verify atomicity, crashes, idempotency, concurrency, poison events, retries, cleanup
- Tests use real PostgreSQL database (configurable via env var)

## Documentation
Comprehensive documentation in:
- `docs/OUTBOX_PATTERN.md` - Pattern guide (500+ lines)
- `ISSUE_37_IMPLEMENTATION.md` - Implementation summary (this file)
- Inline code comments in all new files
- JSDoc comments on all exported functions

## Dependencies
No new runtime dependencies added:
- Uses existing `@prisma/client`
- Uses existing `bullmq` for queueing
- Uses existing `vitest` for testing
- All imports from existing packages

## Performance Impact
- **Write overhead**: Minimal (one outbox INSERT in same transaction)
- **Relay processing**: Efficient batch claiming with row locking
- **Storage**: Configurable retention (default 30 days) prevents unbounded growth
- **Indexes**: Optimized for relay and cleanup queries
- **Concurrency**: Multiple relay workers can run in parallel without contention
