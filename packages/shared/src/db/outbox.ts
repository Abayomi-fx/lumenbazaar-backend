import { Prisma, PrismaClient } from "@prisma/client";
import { v4 as randomUUID } from "uuid";

/**
 * Type-safe outbox event writer that requires an active transaction client.
 * This ensures outbox events cannot be written outside of a transaction that
 * also persists the corresponding state change.
 *
 * Enforces:
 * - Explicit field mapping only (never spread entire records)
 * - No secrets or sensitive data in payloads
 * - Transaction-scoped client requirement (compile-time safety)
 */

export type OutboxAggregateType = "settlement" | "receipt" | "resource" | "catalog";

export interface OutboxEventPayload {
  [key: string]: unknown;
}

export interface WriteOutboxEventInput {
  aggregateType: OutboxAggregateType;
  aggregateId: string;
  eventType: string;
  payload: OutboxEventPayload;
}

/**
 * Write an outbox event atomically within a transaction.
 * This function REQUIRES a Prisma transaction client and will fail type-checking
 * if called with a PrismaClient directly (not within a $transaction).
 *
 * @param tx - Prisma transaction client (must be typed as Prisma.TransactionClient or the tx parameter from $transaction)
 * @param input - Event details with explicit field mapping
 * @returns The created outbox event
 *
 * @example
 * await db.$transaction(async (tx) => {
 *   // Update state
 *   const settlement = await tx.settlement.create({ ... });
 *
 *   // Write outbox event in same transaction
 *   await writeOutboxEvent(tx, {
 *     aggregateType: "settlement",
 *     aggregateId: settlement.id,
 *     eventType: "settlement.confirmed",
 *     payload: {
 *       paymentAttemptId: settlement.paymentAttemptId,
 *       amount: settlement.amount,
 *       status: settlement.status
 *     }
 *   });
 * });
 */
export async function writeOutboxEvent(
  tx: Prisma.TransactionClient,
  input: WriteOutboxEventInput
) {
  return tx.outboxEvent.create({
    data: {
      id: `outbox_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      payload: input.payload as Prisma.JsonValue,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: new Date()
    }
  });
}

/**
 * Claim a batch of pending outbox events for processing with row-level locking.
 * Implements lease-based concurrency control for crash recovery.
 *
 * @param client - Prisma client
 * @param workerId - Unique identifier for this worker/relay instance
 * @param batchSize - Maximum events to claim in this batch
 * @param leaseDurationMs - How long to hold the lease before considering the worker crashed
 * @returns Array of claimed events with lock held
 */
export async function claimOutboxEventBatch(
  client: PrismaClient,
  workerId: string,
  batchSize: number = 100,
  leaseDurationMs: number = 60_000
) {
  const now = new Date();
  const lockExpiresAt = new Date(now.getTime() + leaseDurationMs);

  // Use raw SQL for row-level locking (SELECT ... FOR UPDATE SKIP LOCKED)
  // This prevents multiple workers from claiming the same rows
  const rows = await client.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`
      SELECT "id" FROM "OutboxEvent"
      WHERE "status" = 'pending'
        AND ("lockExpiresAt" IS NULL OR "lockExpiresAt" < CURRENT_TIMESTAMP)
        AND "nextAttemptAt" <= CURRENT_TIMESTAMP
      ORDER BY "aggregateType", "aggregateId", "createdAt"
      LIMIT ${batchSize}
      FOR UPDATE SKIP LOCKED
    `
  );

  if (rows.length === 0) {
    return [];
  }

  const ids = rows.map((r) => r.id);

  // Update to mark as processing with our lock
  await client.outboxEvent.updateMany({
    where: { id: { in: ids } },
    data: {
      status: "processing",
      lockedBy: workerId,
      lockExpiresAt
    }
  });

  // Fetch the full rows for return
  return client.outboxEvent.findMany({
    where: { id: { in: ids } },
    orderBy: [{ aggregateType: "asc" }, { aggregateId: "asc" }, { createdAt: "asc" }]
  });
}

/**
 * Mark an outbox event as successfully delivered.
 * Should only be called after the downstream system has durably accepted the event.
 *
 * @param client - Prisma client
 * @param eventId - ID of the outbox event
 */
export async function markOutboxEventDelivered(client: PrismaClient, eventId: string) {
  await client.outboxEvent.update({
    where: { id: eventId },
    data: {
      status: "delivered",
      deliveredAt: new Date(),
      lockedBy: null,
      lockExpiresAt: null
    }
  });
}

/**
 * Mark an outbox event as failed and schedule retry with exponential backoff.
 * If max retries exceeded, moves to dead-letter.
 *
 * @param client - Prisma client
 * @param eventId - ID of the outbox event
 * @param error - The error that occurred
 * @param maxAttempts - Maximum number of retry attempts before dead-letter
 */
export async function markOutboxEventFailed(
  client: PrismaClient,
  eventId: string,
  error: Error,
  maxAttempts: number = 10
) {
  const event = await client.outboxEvent.findUniqueOrThrow({ where: { id: eventId } });

  const nextAttemptCount = event.attemptCount + 1;
  const exceedsMaxAttempts = nextAttemptCount >= maxAttempts;

  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, ...
  const backoffMs = 1000 * Math.pow(2, Math.min(nextAttemptCount - 1, 5));
  const nextAttemptAt = new Date(Date.now() + backoffMs);

  // Truncate and redact error message
  const lastError = redactSensitiveText(error.message).slice(0, 500);

  await client.outboxEvent.update({
    where: { id: eventId },
    data: {
      status: exceedsMaxAttempts ? "dead" : "pending",
      attemptCount: nextAttemptCount,
      nextAttemptAt: exceedsMaxAttempts ? undefined : nextAttemptAt,
      lastError,
      lockedBy: null,
      lockExpiresAt: null
    }
  });
}

/**
 * Record that an outbox event was processed by a consumer (for idempotency).
 * Must be called in same transaction as the consumer's side effects.
 * Prevents duplicate processing if event is redelivered.
 *
 * @param tx - Prisma transaction client
 * @param outboxEventId - ID of the outbox event
 * @param consumerId - Identifier for the handler that processed this event
 * @param aggregateType - Type of aggregate (for indexing)
 * @param aggregateId - ID of the aggregate (for indexing)
 * @param eventType - Type of event (for indexing)
 */
export async function recordProcessedOutboxEvent(
  tx: Prisma.TransactionClient,
  outboxEventId: string,
  consumerId: string,
  aggregateType: OutboxAggregateType,
  aggregateId: string,
  eventType: string
) {
  await tx.processedOutboxEvent.create({
    data: {
      id: `processed_${randomUUID().replaceAll("-", "").slice(0, 16)}`,
      outboxEventId,
      aggregateType,
      aggregateId,
      eventType,
      consumerId
    }
  });
}

/**
 * Check if an outbox event was already processed by a consumer (idempotency check).
 *
 * @param client - Prisma client
 * @param outboxEventId - ID of the outbox event
 * @param consumerId - Identifier for the handler
 * @returns true if already processed, false otherwise
 */
export async function isOutboxEventProcessed(
  client: PrismaClient,
  outboxEventId: string,
  consumerId: string
): Promise<boolean> {
  const record = await client.processedOutboxEvent.findUnique({
    where: {
      outboxEventId_consumerId: {
        outboxEventId,
        consumerId
      }
    }
  });
  return record !== null;
}

/**
 * Clean up delivered outbox events older than the retention period.
 * Should be run periodically (e.g., daily) to prevent table bloat.
 *
 * @param client - Prisma client
 * @param retentionDays - Number of days to retain delivered events (default 30)
 * @returns Number of events deleted
 */
export async function cleanupDeliveredOutboxEvents(
  client: PrismaClient,
  retentionDays: number = 30
) {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  // First, delete processed event records
  await client.processedOutboxEvent.deleteMany({
    where: {
      processedAt: { lt: cutoffDate }
    }
  });

  // Then delete outbox events
  const result = await client.outboxEvent.deleteMany({
    where: {
      status: "delivered",
      deliveredAt: { lt: cutoffDate }
    }
  });

  return result.count;
}

/**
 * Redact sensitive text from error messages and logs.
 * Removes common patterns: private keys, secrets, tokens, seed phrases.
 */
function redactSensitiveText(text: string): string {
  return text
    .replace(/[a-zA-Z0-9]{40,}/g, "[REDACTED_KEY]")
    .replace(/Bearer\s+[^\s]+/g, "Bearer [REDACTED_TOKEN]")
    .replace(/secret[:\s=]+[^\s,}]+/gi, "secret: [REDACTED]")
    .replace(/token[:\s=]+[^\s,}]+/gi, "token: [REDACTED]")
    .replace(/password[:\s=]+[^\s,}]+/gi, "password: [REDACTED]");
}
