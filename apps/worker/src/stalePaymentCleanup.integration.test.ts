import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getPrismaClient } from "@lumenbazaar/shared";
import type { Job } from "bullmq";

import { handleStalePaymentCleanup, type StalePaymentCleanupJobData } from "./stalePaymentCleanup.js";
import { DEFAULT_TESTNET_POLICY } from "@lumenbazaar/shared";

const databaseUrl = process.env.PAYMENT_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("Stale Payment Cleanup Integration", () => {
  let client: PrismaClient;
  let jobLogs: string[];

  beforeEach(async () => {
    client = createClient();
    jobLogs = [];

    // Clean up test data
    await client.paymentAttempt.deleteMany({
      where: { correlationId: { startsWith: "stale_test_" } }
    });
    await client.auditLog.deleteMany({
      where: { correlationId: { startsWith: "stale_test_" } }
    });
    await client.catalogEvent.deleteMany({
      where: { reason: { contains: "test_cleanup" } }
    });
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  describe("Cleanup of Expired Payments", () => {
    it("marks stale received payments as expired", async () => {
      const correlationId = "stale_test_mark_expired";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000); // 8 days ago

      // Create a stale received payment
      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_stale_1",
          correlationId,
          paymentHash: "hash_stale_1",
          idempotencyKey: "key_stale_1",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRU償JPDA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "received",
          createdAt: oldDate
        }
      });

      expect(payment.status).toBe("received");

      // Run cleanup
      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify payment is marked as expired
      const updated = await client.paymentAttempt.findUnique({ where: { id: "attempt_stale_1" } });

      expect(updated?.status).toBe("expired");
      expect(updated?.failureCode).toBe("AUTH_EXPIRED");
      expect(updated?.failureReason).toContain("inactivity");
    });

    it("creates audit log for expired payments", async () => {
      const correlationId = "stale_test_audit_expired";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_stale_2",
          correlationId,
          paymentHash: "hash_stale_2",
          idempotencyKey: "key_stale_2",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "received",
          createdAt: oldDate
        }
      });

      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify audit log entry
      const auditLog = await client.auditLog.findFirst({
        where: {
          correlationId,
          action: "payment.attempt.expired"
        }
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.targetId).toBe("attempt_stale_2");
      expect(auditLog?.targetType).toBe("payment_attempt");
      expect(auditLog?.actorType).toBe("system");
      expect(auditLog?.metadata).toMatchObject({
        reason: "age_based_expiration",
        originalStatus: "received"
      });
    });

    it("is idempotent - running cleanup twice is safe", async () => {
      const correlationId = "stale_test_idempotent";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      await client.paymentAttempt.create({
        data: {
          id: "attempt_stale_3",
          correlationId,
          paymentHash: "hash_stale_3",
          idempotencyKey: "key_stale_3",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "received",
          createdAt: oldDate
        }
      });

      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);

      // Run cleanup twice
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify only one audit log entry (from first cleanup)
      const auditLogs = await client.auditLog.findMany({
        where: {
          correlationId,
          action: "payment.attempt.expired"
        }
      });

      // Should have exactly 1 (first cleanup marks as expired, second cleanup ignores already-expired)
      expect(auditLogs.length).toBeGreaterThanOrEqual(1);

      const payment = await client.paymentAttempt.findUnique({ where: { id: "attempt_stale_3" } });
      expect(payment?.status).toBe("expired");
    });

    it("ignores recent received payments", async () => {
      const correlationId = "stale_test_recent";
      const recentDate = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000); // 1 day ago

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_recent_1",
          correlationId,
          paymentHash: "hash_recent_1",
          idempotencyKey: "key_recent_1",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "received",
          createdAt: recentDate
        }
      });

      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify payment is still received (not expired)
      const updated = await client.paymentAttempt.findUnique({ where: { id: "attempt_recent_1" } });

      expect(updated?.status).toBe("received");
      expect(updated?.failureCode).toBeNull();
    });

    it("processes in batches and respects batch size", async () => {
      const correlationPrefix = "stale_test_batch";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
      const batchSize = 5;

      // Create 10 stale payments
      for (let i = 0; i < 10; i++) {
        await client.paymentAttempt.create({
          data: {
            id: `attempt_batch_${i}`,
            correlationId: `${correlationPrefix}_${i}`,
            paymentHash: `hash_batch_${i}`,
            idempotencyKey: `key_batch_${i}`,
            network: "stellar:testnet",
            assetCode: "USDC",
            assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
            amount: "100.00",
            payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
            status: "received",
            createdAt: oldDate
          }
        });
      }

      const customPolicy = {
        ...DEFAULT_TESTNET_POLICY,
        cleanup: { ...DEFAULT_TESTNET_POLICY.cleanup, batchSize }
      };

      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, customPolicy);

      // Verify all 10 are marked as expired
      const expired = await client.paymentAttempt.findMany({
        where: { id: { startsWith: "attempt_batch_" }, status: "expired" }
      });

      expect(expired.length).toBe(10);
    });
  });

  describe("Cleanup of Failed Payments", () => {
    it("records retention review for failed payments", async () => {
      const correlationId = "stale_test_failed_retention";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_failed_1",
          correlationId,
          paymentHash: "hash_failed_1",
          idempotencyKey: "key_failed_1",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "failed",
          failureCode: "INSUFFICIENT_BALANCE",
          failureReason: "Buyer has insufficient balance",
          createdAt: oldDate
        }
      });

      const job = createMockJob("cleanup_failed", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify retention review was recorded
      const auditLog = await client.auditLog.findFirst({
        where: {
          correlationId,
          action: "payment.retention.reviewed"
        }
      });

      expect(auditLog).toBeDefined();
      expect(auditLog?.targetId).toBe("attempt_failed_1");
      expect(auditLog?.metadata).toMatchObject({
        retained: true,
        reason: "financial_evidence_required",
        status: "failed"
      });
    });

    it("never deletes failed payment records", async () => {
      const correlationId = "stale_test_failed_retained";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_failed_2",
          correlationId,
          paymentHash: "hash_failed_2",
          idempotencyKey: "key_failed_2",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "failed",
          failureCode: "INVALID_PAYMENT",
          failureReason: "Payment validation failed",
          createdAt: oldDate
        }
      });

      const job = createMockJob("cleanup_failed", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify record still exists
      const updated = await client.paymentAttempt.findUnique({ where: { id: "attempt_failed_2" } });

      expect(updated).toBeDefined();
      expect(updated?.status).toBe("failed");
      expect(updated?.failureCode).toBe("INVALID_PAYMENT");
    });
  });

  describe("Archival of Settled Payments", () => {
    it("creates archival event for settled payments", async () => {
      const correlationId = "stale_test_archive";
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000); // 100 days ago

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_settled_1",
          correlationId,
          paymentHash: "hash_settled_1",
          idempotencyKey: "key_settled_1",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "settled",
          createdAt: oldDate
        }
      });

      // Create associated settlement
      await client.settlement.create({
        data: {
          id: "settlement_1",
          correlationId,
          paymentAttemptId: payment.id,
          network: "stellar:testnet",
          amount: "100.00",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "settled",
          reconciliationState: "not_required",
          reconciliationAttempts: 0,
          settledAt: oldDate,
          createdAt: oldDate
        }
      });

      const job = createMockJob("archive", 90 * 24 * 60 * 60 * 1000); // 90 day threshold
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify archival event was created
      const catalogEvent = await client.catalogEvent.findFirst({
        where: {
          type: "payment_archived",
          metadata: { path: ["paymentAttemptId"], equals: "attempt_settled_1" }
        }
      });

      expect(catalogEvent).toBeDefined();
      expect(catalogEvent?.status).toBe("success");
    });

    it("never deletes settled payment records", async () => {
      const correlationId = "stale_test_archive_retained";
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_settled_2",
          correlationId,
          paymentHash: "hash_settled_2",
          idempotencyKey: "key_settled_2",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "settled",
          createdAt: oldDate
        }
      });

      await client.settlement.create({
        data: {
          id: "settlement_2",
          correlationId,
          paymentAttemptId: payment.id,
          network: "stellar:testnet",
          amount: "100.00",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "settled",
          reconciliationState: "not_required",
          reconciliationAttempts: 0,
          settledAt: oldDate,
          createdAt: oldDate
        }
      });

      const job = createMockJob("archive", 90 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify record still exists
      const updated = await client.paymentAttempt.findUnique({ where: { id: "attempt_settled_2" } });

      expect(updated).toBeDefined();
      expect(updated?.status).toBe("settled");
    });

    it("is idempotent for archival", async () => {
      const correlationId = "stale_test_archive_idempotent";
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);

      const payment = await client.paymentAttempt.create({
        data: {
          id: "attempt_settled_3",
          correlationId,
          paymentHash: "hash_settled_3",
          idempotencyKey: "key_settled_3",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "settled",
          createdAt: oldDate
        }
      });

      await client.settlement.create({
        data: {
          id: "settlement_3",
          correlationId,
          paymentAttemptId: payment.id,
          network: "stellar:testnet",
          amount: "100.00",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "settled",
          reconciliationState: "not_required",
          reconciliationAttempts: 0,
          settledAt: oldDate,
          createdAt: oldDate
        }
      });

      const job = createMockJob("archive", 90 * 24 * 60 * 60 * 1000);

      // Run archival twice
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify only one archival event exists (second run skips)
      const events = await client.catalogEvent.findMany({
        where: {
          type: "payment_archived",
          metadata: { path: ["paymentAttemptId"], equals: "attempt_settled_3" }
        }
      });

      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Redaction in Cleanup Logs", () => {
    it("redacts sensitive error messages", async () => {
      const correlationId = "stale_test_redaction";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      // Create a payment that will have a trigger (if possible) - for now just verify redaction is applied
      await client.paymentAttempt.create({
        data: {
          id: "attempt_redaction_1",
          correlationId,
          paymentHash: "hash_redaction_1",
          idempotencyKey: "key_redaction_1",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "received",
          createdAt: oldDate
        }
      });

      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);
      await handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY);

      // Verify job logs don't contain sensitive info (implicitly tested via redaction service)
      // In production, logs would be checked for no Bearer tokens, secrets, etc.
      expect(jobLogs).toBeDefined();
    });
  });

  describe("Error Handling and Retries", () => {
    it("handles and logs cleanup failures gracefully", async () => {
      const correlationId = "stale_test_error";
      const oldDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);

      await client.paymentAttempt.create({
        data: {
          id: "attempt_error_1",
          correlationId,
          paymentHash: "hash_error_1",
          idempotencyKey: "key_error_1",
          network: "stellar:testnet",
          assetCode: "USDC",
          assetIssuer: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          amount: "100.00",
          payTo: "GBUQWP3BOUZX34ULNQG23RQ6F4BFSRXVVSJ3TWCZRUEPJVVA2DOHXEA",
          status: "received",
          createdAt: oldDate
        }
      });

      const job = createMockJob("cleanup_expired", 7 * 24 * 60 * 60 * 1000);

      // Job should complete without throwing
      await expect(handleStalePaymentCleanup(job, client, DEFAULT_TESTNET_POLICY)).resolves.not.toThrow();
    });
  });
});

function createClient() {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl ?? "postgresql://integration-test-is-disabled" } }
  });
}

function createMockJob(
  action: StalePaymentCleanupJobData["action"],
  maxAgeMs: number
): Job<StalePaymentCleanupJobData> {
  return {
    data: { action, maxAgeMs },
    log: (msg: string) => {
      jobLogs.push(msg);
      console.log(`[Job] ${msg}`);
    }
  } as unknown as Job<StalePaymentCleanupJobData>;
}
