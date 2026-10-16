import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AuditLogService, PrismaAuditLogStore } from "./audit.js";
import { RedactionService, DEFAULT_TESTNET_POLICY, DEFAULT_MAINNET_POLICY } from "@lumenbazaar/shared";

const databaseUrl = process.env.PAYMENT_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("Redaction Policy Integration", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = createClient();
    // Clean up test data
    await client.auditLog.deleteMany({
      where: { action: { startsWith: "test_redaction_" } }
    });
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  describe("Sensitive metadata redaction at storage", () => {
    it("redacts sensitive keys from audit metadata before storage", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      await service.record({
        action: "test_redaction_sensitive_keys",
        actorType: "system",
        correlationId: "corr_test_redaction_1",
        targetType: "payment_attempt",
        metadata: {
          id: "attempt_123",
          amount: "100.00",
          secret: "super_secret_value",
          api_key: "sk_live_abcd1234",
          paymentHash: "hash_value_123",
          normal_field: "this_should_not_be_redacted"
        }
      });

      // Query from database to verify redaction was applied at storage
      const log = await client.auditLog.findFirst({
        where: {
          action: "test_redaction_sensitive_keys",
          correlationId: "corr_test_redaction_1"
        }
      });

      expect(log).toBeDefined();
      expect(log?.metadata).toEqual({
        id: "attempt_123",
        amount: "100.00",
        secret: "[redacted]",
        api_key: "[redacted]",
        paymentHash: "[redacted]",
        normal_field: "this_should_not_be_redacted"
      });

      // Verify sensitive values were never persisted
      expect(JSON.stringify(log?.metadata)).not.toContain("super_secret_value");
      expect(JSON.stringify(log?.metadata)).not.toContain("sk_live_abcd1234");
      expect(JSON.stringify(log?.metadata)).not.toContain("hash_value_123");
    });

    it("redacts sensitive text patterns in string values", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      await service.record({
        action: "test_redaction_text_patterns",
        actorType: "system",
        correlationId: "corr_test_redaction_2",
        targetType: "payment_attempt",
        metadata: {
          description: "Failed to authenticate with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0",
          errorContext: "stellar key SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX used",
          config: "api_key=secret_12345"
        }
      });

      const log = await client.auditLog.findFirst({
        where: {
          action: "test_redaction_text_patterns",
          correlationId: "corr_test_redaction_2"
        }
      });

      expect(log).toBeDefined();

      // Verify Bearer token was redacted
      expect((log?.metadata?.description as string) || "").toContain("[redacted]");
      expect((log?.metadata?.description as string) || "").not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");

      // Verify Stellar secret key was redacted
      expect((log?.metadata?.errorContext as string) || "").toContain("[redacted]");
      expect((log?.metadata?.errorContext as string) || "").not.toContain(
        "SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX"
      );

      // Verify key=value pair was redacted
      expect((log?.metadata?.config as string) || "").toContain("[redacted]");
      expect((log?.metadata?.config as string) || "").not.toContain("secret_12345");
    });

    it("redacts nested sensitive values", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      await service.record({
        action: "test_redaction_nested",
        actorType: "system",
        correlationId: "corr_test_redaction_3",
        targetType: "payment_attempt",
        metadata: {
          payment: {
            amount: "100.00",
            credentials: {
              token: "secret_token_value",
              apiKey: "sk_live_nested"
            }
          },
          normal: {
            field: "value"
          }
        }
      });

      const log = await client.auditLog.findFirst({
        where: {
          action: "test_redaction_nested",
          correlationId: "corr_test_redaction_3"
        }
      });

      expect(log).toBeDefined();

      const nested = log?.metadata as Record<string, unknown>;
      expect((nested.payment as Record<string, unknown>).amount).toBe("100.00");
      expect(((nested.payment as Record<string, unknown>).credentials as Record<string, unknown>).token).toBe(
        "[redacted]"
      );
      expect(((nested.payment as Record<string, unknown>).credentials as Record<string, unknown>).apiKey).toBe(
        "[redacted]"
      );
      expect((nested.normal as Record<string, unknown>).field).toBe("value");
    });

    it("preserves non-sensitive data types", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      await service.record({
        action: "test_redaction_data_types",
        actorType: "system",
        correlationId: "corr_test_redaction_4",
        targetType: "payment_attempt",
        metadata: {
          count: 42,
          enabled: true,
          disabled: false,
          amount: 99.99,
          nullValue: null,
          arrayOfIds: ["id1", "id2", "id3"],
          mixed: [1, "two", true, null]
        }
      });

      const log = await client.auditLog.findFirst({
        where: {
          action: "test_redaction_data_types",
          correlationId: "corr_test_redaction_4"
        }
      });

      expect(log).toBeDefined();
      expect(log?.metadata?.count).toBe(42);
      expect(log?.metadata?.enabled).toBe(true);
      expect(log?.metadata?.disabled).toBe(false);
      expect(log?.metadata?.amount).toBe(99.99);
      expect(log?.metadata?.nullValue).toBeNull();
      expect(Array.isArray(log?.metadata?.arrayOfIds)).toBe(true);
      expect(Array.isArray(log?.metadata?.mixed)).toBe(true);
    });

    it("survives database round-trip with redaction intact", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      const correlationId = "corr_test_redaction_roundtrip";

      await service.record({
        action: "test_redaction_roundtrip",
        actorType: "buyer",
        actorId: "buyer_123",
        correlationId,
        targetType: "payment_attempt",
        targetId: "attempt_456",
        metadata: {
          status: "settled",
          amount: "100.00",
          transactionHash: "tx_hash_value",
          secret: "should_be_redacted"
        }
      });

      // Query the service to get the list
      const logs = await service.list();
      const found = logs.find((log) => log.correlationId === correlationId);

      expect(found).toBeDefined();
      expect(found?.metadata?.status).toBe("settled");
      expect(found?.metadata?.amount).toBe("100.00");
      expect(found?.metadata?.transactionHash).toBe("[redacted]");
      expect(found?.metadata?.secret).toBe("[redacted]");
    });
  });

  describe("Environment-specific redaction policies", () => {
    it("testnet allows longer error messages than mainnet", async () => {
      const testnetService = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      const mainnetService = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_MAINNET_POLICY)
      );

      const testnetStatus = new RedactionService(DEFAULT_TESTNET_POLICY).getRedactionStatus();
      const mainnetStatus = new RedactionService(DEFAULT_MAINNET_POLICY).getRedactionStatus();

      expect(testnetStatus.maxErrorMessageLength).toBeGreaterThan(
        mainnetStatus.maxErrorMessageLength
      );
    });

    it("both policies redact sensitive fields consistently", async () => {
      const testnetService = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      const mainnetService = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_MAINNET_POLICY)
      );

      const sensitiveMeta = {
        secret: "value",
        api_key: "value",
        paymentHash: "value",
        normal: "value"
      };

      // Both should redact the same sensitive fields
      const testnetRedacted = new RedactionService(DEFAULT_TESTNET_POLICY).sanitizeMetadata(
        sensitiveMeta
      );
      const mainnetRedacted = new RedactionService(DEFAULT_MAINNET_POLICY).sanitizeMetadata(
        sensitiveMeta
      );

      expect(testnetRedacted.secret).toBe("[redacted]");
      expect(mainnetRedacted.secret).toBe("[redacted]");
      expect(testnetRedacted.api_key).toBe("[redacted]");
      expect(mainnetRedacted.api_key).toBe("[redacted]");
      expect(testnetRedacted.paymentHash).toBe("[redacted]");
      expect(mainnetRedacted.paymentHash).toBe("[redacted]");
      expect(testnetRedacted.normal).toBe("value");
      expect(mainnetRedacted.normal).toBe("value");
    });
  });

  describe("Payment record audit trail with redaction", () => {
    it("logs payment attempts with redacted sensitive identifiers", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      const correlationId = "corr_payment_audit_1";

      // Simulate payment attempt creation
      await service.record({
        action: "payment.attempt.created",
        actorType: "buyer",
        actorId: "buyer_789",
        correlationId,
        targetType: "payment_attempt",
        targetId: "attempt_123",
        metadata: {
          network: "stellar:testnet",
          amount: "100.00",
          assetCode: "USDC",
          paymentHash: "hash_abc123",
          idempotencyKey: "key_xyz789"
        }
      });

      const log = await client.auditLog.findFirst({
        where: { correlationId, action: "payment.attempt.created" }
      });

      expect(log).toBeDefined();
      expect(log?.metadata?.network).toBe("stellar:testnet");
      expect(log?.metadata?.amount).toBe("100.00");
      expect(log?.metadata?.assetCode).toBe("USDC");
      expect(log?.metadata?.paymentHash).toBe("[redacted]");
      expect(log?.metadata?.idempotencyKey).toBe("[redacted]");
    });

    it("logs settlement with transaction hash redacted", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      const correlationId = "corr_settlement_audit_1";

      await service.record({
        action: "payment.settled",
        actorType: "system",
        correlationId,
        targetType: "settlement",
        targetId: "settlement_456",
        metadata: {
          network: "stellar:testnet",
          amount: "100.00",
          transactionHash: "tx_hash_abc123",
          ledger: 1000000,
          status: "settled"
        }
      });

      const log = await client.auditLog.findFirst({
        where: { correlationId, action: "payment.settled" }
      });

      expect(log).toBeDefined();
      expect(log?.metadata?.transactionHash).toBe("[redacted]");
      expect(log?.metadata?.ledger).toBe(1000000);
      expect(log?.metadata?.status).toBe("settled");
    });
  });

  describe("Compliance audit trail", () => {
    it("maintains non-repudiation with actor and timestamp", async () => {
      const service = new AuditLogService(
        new PrismaAuditLogStore(client),
        new RedactionService(DEFAULT_TESTNET_POLICY)
      );

      const correlationId = "corr_non_repudiation_1";
      const beforeTime = new Date();

      await service.record({
        action: "test_redaction_non_repudiation",
        actorType: "seller",
        actorId: "seller_123",
        correlationId,
        targetType: "payment_attempt",
        targetId: "attempt_789",
        metadata: {
          status: "verified"
        }
      });

      const afterTime = new Date();

      const log = await client.auditLog.findFirst({
        where: { correlationId }
      });

      expect(log).toBeDefined();
      expect(log?.actorType).toBe("seller");
      expect(log?.actorId).toBe("seller_123");
      expect(log?.targetType).toBe("payment_attempt");
      expect(log?.targetId).toBe("attempt_789");

      const logTime = new Date(log?.createdAt ?? "");
      expect(logTime.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime() - 1000);
      expect(logTime.getTime()).toBeLessThanOrEqual(afterTime.getTime() + 1000);
    });
  });
});

function createClient() {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl ?? "postgresql://integration-test-is-disabled" } }
  });
}
