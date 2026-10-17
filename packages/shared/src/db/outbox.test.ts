import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  writeOutboxEvent,
  claimOutboxEventBatch,
  markOutboxEventDelivered,
  markOutboxEventFailed,
  recordProcessedOutboxEvent,
  isOutboxEventProcessed,
  cleanupDeliveredOutboxEvents,
  type OutboxAggregateType
} from "./outbox.js";

const databaseUrl = process.env.SHARED_DB_TEST_DATABASE_URL;
const describe_ = databaseUrl === undefined ? describe.skip : describe;

describe_("Outbox pattern", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = new PrismaClient({
      datasources: { db: { url: databaseUrl } }
    });
    await client.outboxEvent.deleteMany();
    await client.processedOutboxEvent.deleteMany();
  });

  afterEach(async () => {
    await client.outboxEvent.deleteMany();
    await client.processedOutboxEvent.deleteMany();
    await client.$disconnect();
  });

  describe("Atomicity", () => {
    it("writes outbox event atomically with state mutation inside transaction", async () => {
      const result = await client.$transaction(async (tx) => {
        // Simulate a state mutation
        const testData = await (tx as any).seller.create({
          data: {
            displayName: "Test Seller",
            walletAddress: "GAAA",
            domain: "test.example"
          }
        });

        // Write outbox event in same transaction
        const event = await writeOutboxEvent(tx as any, {
          aggregateType: "settlement",
          aggregateId: "settlement_123",
          eventType: "settlement.confirmed",
          payload: { sellerId: testData.id, amount: "100.0000000" }
        });

        return { testData, event };
      });

      // Both should exist
      expect(result.testData.id).toBeDefined();
      expect(result.event.id).toBeDefined();

      // Verify outbox event exists
      const event = await client.outboxEvent.findUnique({
        where: { id: result.event.id }
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe("pending");
      expect(event?.aggregateType).toBe("settlement");
      expect(event?.eventType).toBe("settlement.confirmed");
    });

    it("rolls back outbox event when transaction fails", async () => {
      try {
        await client.$transaction(async (tx) => {
          // Write outbox event
          await writeOutboxEvent(tx as any, {
            aggregateType: "settlement",
            aggregateId: "settlement_fail",
            eventType: "settlement.confirmed",
            payload: { amount: "100.0000000" }
          });

          // Force transaction failure
          throw new Error("Simulated failure");
        });
      } catch {
        // Expected
      }

      // Outbox event should not exist
      const events = await client.outboxEvent.findMany({
        where: { aggregateId: "settlement_fail" }
      });
      expect(events).toHaveLength(0);
    });

    it("prevents duplicate events for same aggregate transition", async () => {
      const aggregateId = "resource_123";
      const eventType = "resource.indexed";
      const createdAt = new Date();

      // Write first event
      await client.$transaction(async (tx) => {
        await writeOutboxEvent(tx as any, {
          aggregateType: "resource",
          aggregateId,
          eventType,
          payload: { versionId: "v1" }
        });
      });

      // Try to write duplicate event with same aggregate and type (should fail due to unique constraint)
      let duplicateWriteFailed = false;
      try {
        await client.$transaction(async (tx) => {
          await writeOutboxEvent(tx as any, {
            aggregateType: "resource",
            aggregateId,
            eventType,
            payload: { versionId: "v2" } // Different version but same aggregate+type
          });
        });
      } catch (error) {
        duplicateWriteFailed = true;
      }

      // Unique constraint should prevent duplicate
      expect(duplicateWriteFailed).toBe(true);
    });
  });

  describe("Claiming and row-level locking", () => {
    it("claims pending events with lease", async () => {
      // Create some pending events
      await client.outboxEvent.createMany({
        data: [
          {
            id: "event_1",
            aggregateType: "settlement",
            aggregateId: "agg_1",
            eventType: "settlement.confirmed",
            payload: {},
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: new Date()
          },
          {
            id: "event_2",
            aggregateType: "settlement",
            aggregateId: "agg_2",
            eventType: "settlement.confirmed",
            payload: {},
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: new Date()
          },
          {
            id: "event_3",
            aggregateType: "receipt",
            aggregateId: "agg_3",
            eventType: "receipt.finalized",
            payload: {},
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: new Date()
          }
        ]
      });

      // Claim batch as worker 1
      const workerId1 = "worker-1";
      const claimed1 = await claimOutboxEventBatch(client, workerId1, 10, 60_000);

      expect(claimed1).toHaveLength(3);
      expect(claimed1[0].status).toBe("processing");
      expect(claimed1[0].lockedBy).toBe(workerId1);
      expect(claimed1[0].lockExpiresAt).toBeDefined();

      // Second worker cannot claim same events (they are locked)
      const workerId2 = "worker-2";
      const claimed2 = await claimOutboxEventBatch(client, workerId2, 10, 60_000);
      expect(claimed2).toHaveLength(0);
    });

    it("reclaims events after lease expires", async () => {
      // Create event with expired lease
      const expiredLockTime = new Date(Date.now() - 1000); // 1 second ago
      await client.outboxEvent.create({
        data: {
          id: "event_expired",
          aggregateType: "settlement",
          aggregateId: "agg_expired",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "crashed-worker",
          lockExpiresAt: expiredLockTime,
          attemptCount: 0,
          nextAttemptAt: new Date()
        }
      });

      // New worker can claim the expired lock
      const workerId = "recovery-worker";
      const claimed = await claimOutboxEventBatch(client, workerId, 10, 60_000);

      expect(claimed).toHaveLength(1);
      expect(claimed[0].lockedBy).toBe(workerId);
      expect(claimed[0].id).toBe("event_expired");
    });

    it("respects batch size limit", async () => {
      // Create 5 events
      await client.outboxEvent.createMany({
        data: Array.from({ length: 5 }, (_, i) => ({
          id: `event_${i}`,
          aggregateType: "settlement",
          aggregateId: `agg_${i}`,
          eventType: "settlement.confirmed",
          payload: {},
          status: "pending",
          attemptCount: 0,
          nextAttemptAt: new Date()
        }))
      });

      // Claim with batch size of 2
      const claimed = await claimOutboxEventBatch(client, "worker", 2, 60_000);

      expect(claimed).toHaveLength(2);
    });

    it("maintains per-aggregate ordering", async () => {
      // Create events for same aggregate in reverse order
      await client.outboxEvent.createMany({
        data: [
          {
            id: "event_agg1_2",
            aggregateType: "settlement",
            aggregateId: "agg_1",
            eventType: "settlement.reconciliation_enqueued",
            payload: {},
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: new Date(),
            createdAt: new Date(Date.now() + 2000)
          },
          {
            id: "event_agg1_1",
            aggregateType: "settlement",
            aggregateId: "agg_1",
            eventType: "settlement.confirmed",
            payload: {},
            status: "pending",
            attemptCount: 0,
            nextAttemptAt: new Date(),
            createdAt: new Date(Date.now() + 1000)
          }
        ]
      });

      const claimed = await claimOutboxEventBatch(client, "worker", 10, 60_000);

      // Should be ordered by aggregateId then createdAt
      expect(claimed[0].id).toBe("event_agg1_1"); // First created
      expect(claimed[1].id).toBe("event_agg1_2"); // Second created
    });
  });

  describe("Delivery and status management", () => {
    it("marks event as delivered and clears lock", async () => {
      const eventId = "event_deliver_1";
      await client.outboxEvent.create({
        data: {
          id: eventId,
          aggregateType: "settlement",
          aggregateId: "agg_1",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "worker",
          lockExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 0,
          nextAttemptAt: new Date()
        }
      });

      await markOutboxEventDelivered(client, eventId);

      const event = await client.outboxEvent.findUnique({ where: { id: eventId } });
      expect(event?.status).toBe("delivered");
      expect(event?.deliveredAt).toBeDefined();
      expect(event?.lockedBy).toBeNull();
      expect(event?.lockExpiresAt).toBeNull();
    });

    it("marks event as failed with exponential backoff retry", async () => {
      const eventId = "event_fail_1";
      await client.outboxEvent.create({
        data: {
          id: eventId,
          aggregateType: "settlement",
          aggregateId: "agg_1",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "worker",
          lockExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 1,
          nextAttemptAt: new Date()
        }
      });

      const error = new Error("Delivery failed: connection timeout");
      await markOutboxEventFailed(client, eventId, error, 10);

      const event = await client.outboxEvent.findUnique({ where: { id: eventId } });
      expect(event?.status).toBe("pending"); // Not dead yet
      expect(event?.attemptCount).toBe(2); // Incremented
      expect(event?.nextAttemptAt).toBeGreaterThan(new Date()); // Future retry time
      expect(event?.lastError).toContain("connection timeout");
      expect(event?.lockedBy).toBeNull();
    });

    it("moves event to dead-letter after max retries", async () => {
      const eventId = "event_dead_1";
      await client.outboxEvent.create({
        data: {
          id: eventId,
          aggregateType: "settlement",
          aggregateId: "agg_1",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "worker",
          lockExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 9, // Already at 9 attempts
          nextAttemptAt: new Date()
        }
      });

      const error = new Error("Handler threw permanent error");
      await markOutboxEventFailed(client, eventId, error, 10);

      const event = await client.outboxEvent.findUnique({ where: { id: eventId } });
      expect(event?.status).toBe("dead"); // Moved to dead-letter
      expect(event?.attemptCount).toBe(10); // Max attempts reached
      expect(event?.lastError).toContain("Handler threw permanent error");
      expect(event?.nextAttemptAt).toEqual(event?.updatedAt); // No more retries scheduled
    });

    it("redacts sensitive data from error messages", async () => {
      const eventId = "event_redact_1";
      await client.outboxEvent.create({
        data: {
          id: eventId,
          aggregateType: "settlement",
          aggregateId: "agg_1",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "worker",
          lockExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 0,
          nextAttemptAt: new Date()
        }
      });

      const sensitiveError = new Error(
        'Failed to deliver: got secret "[SENSITIVE_API_KEY]" from env'
      );
      await markOutboxEventFailed(client, eventId, sensitiveError, 10);

      const event = await client.outboxEvent.findUnique({ where: { id: eventId } });
      expect(event?.lastError).not.toContain("[SENSITIVE");
      expect(event?.lastError).toContain("[REDACTED");
    });
  });

  describe("Idempotency tracking", () => {
    it("records processed event for idempotency", async () => {
      const outboxEventId = "event_123";
      const consumerId = "consumer.settlement";
      const aggregateType = "settlement" as OutboxAggregateType;
      const aggregateId = "agg_123";
      const eventType = "settlement.confirmed";

      await client.$transaction(async (tx) => {
        await recordProcessedOutboxEvent(tx as any, outboxEventId, consumerId, aggregateType, aggregateId, eventType);
      });

      const record = await client.processedOutboxEvent.findUnique({
        where: {
          outboxEventId_consumerId: {
            outboxEventId,
            consumerId
          }
        }
      });

      expect(record).toBeDefined();
      expect(record?.aggregateType).toBe(aggregateType);
      expect(record?.aggregateId).toBe(aggregateId);
      expect(record?.eventType).toBe(eventType);
    });

    it("checks if event was already processed", async () => {
      const outboxEventId = "event_idempotent";
      const consumerId = "consumer.receipt";

      // Initially not processed
      const notProcessed = await isOutboxEventProcessed(client, outboxEventId, consumerId);
      expect(notProcessed).toBe(false);

      // Record as processed
      await client.processedOutboxEvent.create({
        data: {
          id: "processed_1",
          outboxEventId,
          consumerId,
          aggregateType: "receipt",
          aggregateId: "receipt_123",
          eventType: "receipt.finalized"
        }
      });

      // Now it's processed
      const isProcessed = await isOutboxEventProcessed(client, outboxEventId, consumerId);
      expect(isProcessed).toBe(true);
    });

    it("prevents duplicate processing by same consumer via unique constraint", async () => {
      const outboxEventId = "event_dedup";
      const consumerId = "consumer.resource";

      // First processing succeeds
      await client.processedOutboxEvent.create({
        data: {
          id: "processed_1",
          outboxEventId,
          consumerId,
          aggregateType: "resource",
          aggregateId: "resource_123",
          eventType: "resource.indexed"
        }
      });

      // Second processing fails due to unique constraint
      let duplicateInsertFailed = false;
      try {
        await client.processedOutboxEvent.create({
          data: {
            id: "processed_2",
            outboxEventId,
            consumerId,
            aggregateType: "resource",
            aggregateId: "resource_123",
            eventType: "resource.indexed"
          }
        });
      } catch {
        duplicateInsertFailed = true;
      }

      expect(duplicateInsertFailed).toBe(true);
    });
  });

  describe("Cleanup and retention", () => {
    it("deletes delivered events older than retention period", async () => {
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

      // Create events: some old, some recent
      await client.outboxEvent.createMany({
        data: [
          {
            id: "old_delivered_1",
            aggregateType: "settlement",
            aggregateId: "agg_1",
            eventType: "settlement.confirmed",
            payload: {},
            status: "delivered",
            deliveredAt: new Date(cutoffDate.getTime() - 1000), // Older than cutoff
            attemptCount: 1,
            nextAttemptAt: new Date()
          },
          {
            id: "recent_delivered_1",
            aggregateType: "settlement",
            aggregateId: "agg_2",
            eventType: "settlement.confirmed",
            payload: {},
            status: "delivered",
            deliveredAt: new Date(cutoffDate.getTime() + 1000), // Newer than cutoff
            attemptCount: 1,
            nextAttemptAt: new Date()
          },
          {
            id: "pending_old_1",
            aggregateType: "settlement",
            aggregateId: "agg_3",
            eventType: "settlement.confirmed",
            payload: {},
            status: "pending",
            deliveredAt: null,
            attemptCount: 0,
            nextAttemptAt: new Date()
          }
        ]
      });

      // Create processed event record for old delivered event
      await client.processedOutboxEvent.create({
        data: {
          id: "processed_1",
          outboxEventId: "old_delivered_1",
          consumerId: "consumer",
          aggregateType: "settlement",
          aggregateId: "agg_1",
          eventType: "settlement.confirmed",
          processedAt: new Date(cutoffDate.getTime() - 1000)
        }
      });

      // Cleanup delivered events older than 30 days
      const deletedCount = await cleanupDeliveredOutboxEvents(client, 30);

      expect(deletedCount).toBe(1); // Only old_delivered_1 deleted

      // Verify old delivered event was deleted
      const oldEvent = await client.outboxEvent.findUnique({
        where: { id: "old_delivered_1" }
      });
      expect(oldEvent).toBeNull();

      // Verify recent delivered event still exists
      const recentEvent = await client.outboxEvent.findUnique({
        where: { id: "recent_delivered_1" }
      });
      expect(recentEvent).toBeDefined();

      // Verify pending event still exists
      const pendingEvent = await client.outboxEvent.findUnique({
        where: { id: "pending_old_1" }
      });
      expect(pendingEvent).toBeDefined();

      // Verify processed event record was also cleaned
      const processedRecord = await client.processedOutboxEvent.findUnique({
        where: { id: "processed_1" }
      });
      expect(processedRecord).toBeNull();
    });

    it("does not delete dead-letter events", async () => {
      const cutoffDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

      await client.outboxEvent.create({
        data: {
          id: "dead_old",
          aggregateType: "settlement",
          aggregateId: "agg_dead",
          eventType: "settlement.confirmed",
          payload: {},
          status: "dead",
          deliveredAt: null,
          lastError: "Poison event - malformed payload",
          attemptCount: 10,
          nextAttemptAt: new Date(cutoffDate.getTime() - 1000),
          createdAt: new Date(cutoffDate.getTime() - 1000)
        }
      });

      const deletedCount = await cleanupDeliveredOutboxEvents(client, 30);

      expect(deletedCount).toBe(0); // Dead letter not deleted

      const event = await client.outboxEvent.findUnique({
        where: { id: "dead_old" }
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe("dead");
    });
  });

  describe("Crash scenarios", () => {
    it("handles crash before commit (no state, no outbox row)", async () => {
      let transactionStarted = false;

      try {
        await client.$transaction(async (tx) => {
          transactionStarted = true;

          // Start writing outbox event
          await writeOutboxEvent(tx as any, {
            aggregateType: "settlement",
            aggregateId: "crash_1",
            eventType: "settlement.confirmed",
            payload: {}
          });

          // Crash before commit
          throw new Error("Process crash");
        });
      } catch {
        // Crash caught
      }

      expect(transactionStarted).toBe(true);

      // Neither state nor outbox row should exist
      const event = await client.outboxEvent.findFirst({
        where: { aggregateId: "crash_1" }
      });
      expect(event).toBeNull();
    });

    it("handles crash after commit but before handler execution (state+outbox exist, relay delivers after restart)", async () => {
      // Write event (simulating successful commit before crash)
      await client.$transaction(async (tx) => {
        await writeOutboxEvent(tx as any, {
          aggregateType: "settlement",
          aggregateId: "crash_2",
          eventType: "settlement.confirmed",
          payload: { amount: "100.0000000" }
        });
      });

      // Verify event exists but not yet processed
      let event = await client.outboxEvent.findFirst({
        where: { aggregateId: "crash_2" }
      });
      expect(event).toBeDefined();
      expect(event?.status).toBe("pending");

      // Simulate relay claiming and delivering after restart
      const claimed = await claimOutboxEventBatch(client, "relay-restart", 10, 60_000);
      expect(claimed).toHaveLength(1);

      await markOutboxEventDelivered(client, claimed[0].id);

      event = await client.outboxEvent.findFirst({
        where: { aggregateId: "crash_2" }
      });
      expect(event?.status).toBe("delivered");
    });

    it("handles crash after claim but before handoff (lease expires, row reclaimed)", async () => {
      // Create event and claim it
      await client.outboxEvent.create({
        data: {
          id: "crash_lease_1",
          aggregateType: "settlement",
          aggregateId: "crash_lease",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "crashed-relay",
          lockExpiresAt: new Date(Date.now() - 1000), // Already expired
          attemptCount: 0,
          nextAttemptAt: new Date()
        }
      });

      // New relay can reclaim the expired lock
      const claimed = await claimOutboxEventBatch(client, "relay-recovery", 10, 60_000);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].lockedBy).toBe("relay-recovery");
    });

    it("handles redelivery after handoff but before marking delivered (idempotency prevents duplicates)", async () => {
      const outboxEventId = "redelivery_1";
      const consumerId = "consumer.test";

      // First delivery: event is marked processing, then delivered
      await client.outboxEvent.create({
        data: {
          id: outboxEventId,
          aggregateType: "settlement",
          aggregateId: "agg_redelivery",
          eventType: "settlement.confirmed",
          payload: {},
          status: "processing",
          lockedBy: "relay-1",
          lockExpiresAt: new Date(Date.now() + 60_000),
          attemptCount: 0,
          nextAttemptAt: new Date()
        }
      });

      // Record as processed
      await client.$transaction(async (tx) => {
        await recordProcessedOutboxEvent(tx as any, outboxEventId, consumerId, "settlement", "agg_redelivery", "settlement.confirmed");
      });

      // Crash before marking delivered, event goes back to pending
      await client.outboxEvent.update({
        where: { id: outboxEventId },
        data: {
          status: "pending",
          lockedBy: null,
          lockExpiresAt: null
        }
      });

      // Redelivery: event is claimed and delivered again
      const claimed = await claimOutboxEventBatch(client, "relay-retry", 10, 60_000);
      expect(claimed).toHaveLength(1);

      // Idempotency check prevents duplicate processing
      const alreadyProcessed = await isOutboxEventProcessed(client, outboxEventId, consumerId);
      expect(alreadyProcessed).toBe(true);

      // Mark delivered
      await markOutboxEventDelivered(client, outboxEventId);

      const event = await client.outboxEvent.findUnique({
        where: { id: outboxEventId }
      });
      expect(event?.status).toBe("delivered");
    });
  });

  describe("Payload safety", () => {
    it("stores only allowlisted fields in payload", async () => {
      const eventId = await client.$transaction(async (tx) => {
        const event = await writeOutboxEvent(tx as any, {
          aggregateType: "receipt",
          aggregateId: "receipt_123",
          eventType: "receipt.status_changed",
          payload: {
            receiptId: "receipt_123",
            status: "finalized",
            amount: "50.0000000",
            assetCode: "USD"
            // Note: no secrets, signatures, or auth data
          }
        });
        return event.id;
      });

      const event = await client.outboxEvent.findUnique({ where: { id: eventId } });
      expect(event?.payload).toMatchObject({
        receiptId: "receipt_123",
        status: "finalized",
        amount: "50.0000000",
        assetCode: "USD"
      });
    });
  });
});
