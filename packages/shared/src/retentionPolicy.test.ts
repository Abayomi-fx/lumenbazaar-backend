import { describe, expect, it } from "vitest";

import {
  SENSITIVE_FIELD_PATTERNS,
  SENSITIVE_VALUE_PATTERNS,
  DEFAULT_TESTNET_POLICY,
  DEFAULT_MAINNET_POLICY,
  shouldRedactField,
  shouldCleanupStatus,
  calculateRecordAge,
  isRecordExpired,
  getDefaultPolicy
} from "./retentionPolicy.js";

describe("Retention Policy Configuration", () => {
  describe("SENSITIVE_FIELD_PATTERNS", () => {
    it("matches secret/credential field names", () => {
      const patterns = SENSITIVE_FIELD_PATTERNS;

      expect(patterns.some((p) => p.test("secret"))).toBe(true);
      expect(patterns.some((p) => p.test("SECRET"))).toBe(true);
      expect(patterns.some((p) => p.test("seed"))).toBe(true);
      expect(patterns.some((p) => p.test("private"))).toBe(true);
      expect(patterns.some((p) => p.test("token"))).toBe(true);
      expect(patterns.some((p) => p.test("authorization"))).toBe(true);
      expect(patterns.some((p) => p.test("password"))).toBe(true);
      expect(patterns.some((p) => p.test("api_key"))).toBe(true);
      expect(patterns.some((p) => p.test("api-key"))).toBe(true);
    });

    it("matches payment-related sensitive fields", () => {
      const patterns = SENSITIVE_FIELD_PATTERNS;

      expect(patterns.some((p) => p.test("paymentHash"))).toBe(true);
      expect(patterns.some((p) => p.test("payment_hash"))).toBe(true);
      expect(patterns.some((p) => p.test("idempotencyKey"))).toBe(true);
      expect(patterns.some((p) => p.test("idempotency_key"))).toBe(true);
      expect(patterns.some((p) => p.test("transactionHash"))).toBe(true);
      expect(patterns.some((p) => p.test("transaction_hash"))).toBe(true);
      expect(patterns.some((p) => p.test("contractId"))).toBe(true);
      expect(patterns.some((p) => p.test("contract_id"))).toBe(true);
      expect(patterns.some((p) => p.test("contractSessionId"))).toBe(true);
      expect(patterns.some((p) => p.test("usageHash"))).toBe(true);
      expect(patterns.some((p) => p.test("usage_hash"))).toBe(true);
    });

    it("does not match normal field names", () => {
      const patterns = SENSITIVE_FIELD_PATTERNS;

      expect(patterns.some((p) => p.test("id"))).toBe(false);
      expect(patterns.some((p) => p.test("amount"))).toBe(false);
      expect(patterns.some((p) => p.test("status"))).toBe(false);
      expect(patterns.some((p) => p.test("createdAt"))).toBe(false);
      expect(patterns.some((p) => p.test("network"))).toBe(false);
    });
  });

  describe("SENSITIVE_VALUE_PATTERNS", () => {
    it("matches Bearer tokens", () => {
      const patterns = SENSITIVE_VALUE_PATTERNS;
      const bearerToken =
        "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

      expect(patterns.some((p) => p.test(bearerToken))).toBe(true);
    });

    it("matches Stellar secret keys", () => {
      const patterns = SENSITIVE_VALUE_PATTERNS;
      const secretKey = "SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX";

      expect(patterns.some((p) => p.test(secretKey))).toBe(true);
    });

    it("matches key=value pairs for sensitive fields", () => {
      const patterns = SENSITIVE_VALUE_PATTERNS;

      expect(patterns.some((p) => p.test("api_key=sk_live_1234567890"))).toBe(true);
      expect(patterns.some((p) => p.test("secret:my-super-secret"))).toBe(true);
      expect(patterns.some((p) => p.test("token = some_token_value"))).toBe(true);
    });
  });

  describe("shouldRedactField", () => {
    it("identifies fields to redact for testnet policy", () => {
      expect(shouldRedactField("secret", DEFAULT_TESTNET_POLICY)).toBe(true);
      expect(shouldRedactField("api_key", DEFAULT_TESTNET_POLICY)).toBe(true);
      expect(shouldRedactField("paymentHash", DEFAULT_TESTNET_POLICY)).toBe(true);
      expect(shouldRedactField("contractId", DEFAULT_TESTNET_POLICY)).toBe(true);
    });

    it("identifies fields to keep for testnet policy", () => {
      expect(shouldRedactField("id", DEFAULT_TESTNET_POLICY)).toBe(false);
      expect(shouldRedactField("amount", DEFAULT_TESTNET_POLICY)).toBe(false);
      expect(shouldRedactField("status", DEFAULT_TESTNET_POLICY)).toBe(false);
    });

    it("works identically for mainnet policy", () => {
      const field = "paymentHash";

      expect(shouldRedactField(field, DEFAULT_TESTNET_POLICY)).toBe(
        shouldRedactField(field, DEFAULT_MAINNET_POLICY)
      );
    });
  });

  describe("shouldCleanupStatus", () => {
    it("returns true for cleanup-eligible statuses", () => {
      expect(shouldCleanupStatus("expired")).toBe(true);
      expect(shouldCleanupStatus("failed")).toBe(true);
      expect(shouldCleanupStatus("cancelled")).toBe(true);
    });

    it("returns false for non-cleanup statuses", () => {
      expect(shouldCleanupStatus("received")).toBe(false);
      expect(shouldCleanupStatus("verified")).toBe(false);
      expect(shouldCleanupStatus("settling")).toBe(false);
      expect(shouldCleanupStatus("settled")).toBe(false);
      expect(shouldCleanupStatus("confirmed")).toBe(false);
      expect(shouldCleanupStatus("open")).toBe(false);
    });
  });

  describe("calculateRecordAge", () => {
    it("calculates age of recent records", () => {
      const now = new Date();
      const recentTime = new Date(now.getTime() - 1000); // 1 second ago
      const age = calculateRecordAge(recentTime.toISOString());

      expect(age).toBeGreaterThanOrEqual(900); // Allow some time variance
      expect(age).toBeLessThanOrEqual(1500);
    });

    it("calculates age of old records", () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // 7 days ago
      const age = calculateRecordAge(oldTime.toISOString());

      expect(age).toBeGreaterThanOrEqual(7 * 24 * 60 * 60 * 1000 - 1000);
      expect(age).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1000 + 1000);
    });
  });

  describe("isRecordExpired", () => {
    it("returns false for records within retention window", () => {
      const now = new Date();
      const recentTime = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 1 day ago
      const retentionWindow = 7 * 24 * 60 * 60 * 1000; // 7 days

      expect(isRecordExpired(recentTime.toISOString(), retentionWindow)).toBe(false);
    });

    it("returns true for records exceeding retention window", () => {
      const now = new Date();
      const oldTime = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000); // 8 days ago
      const retentionWindow = 7 * 24 * 60 * 60 * 1000; // 7 days

      expect(isRecordExpired(oldTime.toISOString(), retentionWindow)).toBe(true);
    });

    it("handles boundary conditions", () => {
      const now = new Date();
      const boundaryTime = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000); // Exactly 7 days
      const retentionWindow = 7 * 24 * 60 * 60 * 1000;

      // At exact boundary, it should be expired
      expect(isRecordExpired(boundaryTime.toISOString(), retentionWindow)).toBe(true);
    });
  });
});

describe("Default Policies", () => {
  describe("DEFAULT_TESTNET_POLICY", () => {
    it("has all retention windows set to indefinite", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.retentionWindows.paymentAttemptMs).toBeGreaterThan(
        365 * 24 * 60 * 60 * 1000 * 100
      ); // >100 years
      expect(policy.retentionWindows.settlementMs).toBeGreaterThan(365 * 24 * 60 * 60 * 1000 * 100);
      expect(policy.retentionWindows.receiptMs).toBeGreaterThan(365 * 24 * 60 * 60 * 1000 * 100);
      expect(policy.retentionWindows.paymentSessionMs).toBeGreaterThan(
        365 * 24 * 60 * 60 * 1000 * 100
      );
      expect(policy.retentionWindows.auditLogMs).toBeGreaterThan(365 * 24 * 60 * 60 * 1000 * 100);
    });

    it("enables cleanup operations", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.cleanup.enableExpiredCleanup).toBe(true);
      expect(policy.cleanup.enableArchival).toBe(true);
    });

    it("has reasonable stale payment threshold", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.cleanup.stalePaymentAgeMs).toBe(7 * 24 * 60 * 60 * 1000); // 7 days
    });

    it("has reasonable archival threshold", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.cleanup.archiveThresholdMs).toBe(90 * 24 * 60 * 60 * 1000); // 90 days
    });

    it("has batch size of 100 for testnet", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.cleanup.batchSize).toBe(100);
    });

    it("allows longer error messages", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.redaction.maxErrorMessageLength).toBeGreaterThan(300);
    });
  });

  describe("DEFAULT_MAINNET_POLICY", () => {
    it("has all retention windows set to indefinite", () => {
      const policy = DEFAULT_MAINNET_POLICY;

      expect(policy.retentionWindows.paymentAttemptMs).toBeGreaterThan(
        365 * 24 * 60 * 60 * 1000 * 100
      );
      expect(policy.retentionWindows.settlementMs).toBeGreaterThan(365 * 24 * 60 * 60 * 1000 * 100);
      expect(policy.retentionWindows.receiptMs).toBeGreaterThan(365 * 24 * 60 * 60 * 1000 * 100);
    });

    it("enables cleanup operations", () => {
      const policy = DEFAULT_MAINNET_POLICY;

      expect(policy.cleanup.enableExpiredCleanup).toBe(true);
      expect(policy.cleanup.enableArchival).toBe(true);
    });

    it("has same stale payment threshold as testnet", () => {
      expect(DEFAULT_MAINNET_POLICY.cleanup.stalePaymentAgeMs).toBe(
        DEFAULT_TESTNET_POLICY.cleanup.stalePaymentAgeMs
      );
    });

    it("has longer archival threshold than testnet", () => {
      expect(DEFAULT_MAINNET_POLICY.cleanup.archiveThresholdMs).toBeGreaterThan(
        DEFAULT_TESTNET_POLICY.cleanup.archiveThresholdMs
      );

      expect(DEFAULT_MAINNET_POLICY.cleanup.archiveThresholdMs).toBe(180 * 24 * 60 * 60 * 1000); // 180 days
    });

    it("has smaller batch size for production stability", () => {
      expect(DEFAULT_MAINNET_POLICY.cleanup.batchSize).toBe(50);
      expect(DEFAULT_MAINNET_POLICY.cleanup.batchSize).toBeLessThan(
        DEFAULT_TESTNET_POLICY.cleanup.batchSize
      );
    });

    it("has more retries for production reliability", () => {
      expect(DEFAULT_MAINNET_POLICY.cleanup.maxRetries).toBeGreaterThan(
        DEFAULT_TESTNET_POLICY.cleanup.maxRetries
      );

      expect(DEFAULT_MAINNET_POLICY.cleanup.maxRetries).toBe(5);
    });

    it("restricts error messages for production", () => {
      expect(DEFAULT_MAINNET_POLICY.redaction.maxErrorMessageLength).toBeLessThan(
        DEFAULT_TESTNET_POLICY.redaction.maxErrorMessageLength
      );

      expect(DEFAULT_MAINNET_POLICY.redaction.maxErrorMessageLength).toBe(300);
    });
  });
});

describe("getDefaultPolicy", () => {
  it("returns testnet policy for testnet environment", () => {
    const policy = getDefaultPolicy("testnet");

    expect(policy).toEqual(DEFAULT_TESTNET_POLICY);
    expect(policy.environment).toBe("testnet");
  });

  it("returns mainnet policy for mainnet environment", () => {
    const policy = getDefaultPolicy("mainnet");

    expect(policy).toEqual(DEFAULT_MAINNET_POLICY);
    expect(policy.environment).toBe("mainnet");
  });

  it("returns mainnet policy for staging environment", () => {
    const policy = getDefaultPolicy("staging");

    expect(policy.environment).toBe("mainnet");
    expect(policy).toEqual(DEFAULT_MAINNET_POLICY);
  });

  it("returns testnet policy for local environment", () => {
    const policy = getDefaultPolicy("local");

    expect(policy).toEqual(DEFAULT_TESTNET_POLICY);
    expect(policy.environment).toBe("testnet");
  });
});

describe("Policy Structure Validation", () => {
  describe("Testnet policy", () => {
    it("has required fields", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.enabled).toBe(true);
      expect(policy.environment).toBe("testnet");
      expect(policy.retentionWindows).toBeDefined();
      expect(policy.cleanup).toBeDefined();
      expect(policy.redaction).toBeDefined();
    });

    it("has all retention window fields", () => {
      const windows = DEFAULT_TESTNET_POLICY.retentionWindows;

      expect(windows.paymentAttemptMs).toBeGreaterThan(0);
      expect(windows.failedPaymentAttemptMs).toBeGreaterThan(0);
      expect(windows.expiredPaymentAttemptMs).toBeGreaterThan(0);
      expect(windows.settlementMs).toBeGreaterThan(0);
      expect(windows.receiptMs).toBeGreaterThan(0);
      expect(windows.paymentSessionMs).toBeGreaterThan(0);
      expect(windows.auditLogMs).toBeGreaterThan(0);
      expect(windows.stalePaymentAgeMs).toBeGreaterThan(0);
      expect(windows.archivePaymentAgeMs).toBeGreaterThan(0);
    });

    it("has all cleanup policy fields", () => {
      const cleanup = DEFAULT_TESTNET_POLICY.cleanup;

      expect(typeof cleanup.enableExpiredCleanup).toBe("boolean");
      expect(typeof cleanup.enableArchival).toBe("boolean");
      expect(cleanup.expiredPaymentThresholdMs).toBeGreaterThan(0);
      expect(cleanup.archiveThresholdMs).toBeGreaterThan(0);
      expect(typeof cleanup.runAsBackgroundJob).toBe("boolean");
      expect(cleanup.batchSize).toBeGreaterThan(0);
      expect(cleanup.maxRetries).toBeGreaterThan(0);
    });

    it("has all redaction policy fields", () => {
      const redaction = DEFAULT_TESTNET_POLICY.redaction;

      expect(Array.isArray(redaction.fieldPatterns)).toBe(true);
      expect(redaction.fieldPatterns.length).toBeGreaterThan(0);
      expect(Array.isArray(redaction.valuePatterns)).toBe(true);
      expect(redaction.valuePatterns.length).toBeGreaterThan(0);
      expect(redaction.maxErrorMessageLength).toBeGreaterThan(0);
    });
  });

  describe("Policy consistency", () => {
    it("archive threshold is greater than stale payment threshold", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.cleanup.archiveThresholdMs).toBeGreaterThan(
        policy.cleanup.stalePaymentAgeMs
      );
    });

    it("cleanup configuration thresholds match retention windows", () => {
      const policy = DEFAULT_TESTNET_POLICY;

      expect(policy.cleanup.expiredPaymentThresholdMs).toBe(policy.retentionWindows.stalePaymentAgeMs);
      expect(policy.cleanup.archiveThresholdMs).toBe(policy.retentionWindows.archivePaymentAgeMs);
    });

    it("batch size is positive and reasonable", () => {
      const testnetPolicy = DEFAULT_TESTNET_POLICY;
      const mainnetPolicy = DEFAULT_MAINNET_POLICY;

      expect(testnetPolicy.cleanup.batchSize).toBeGreaterThanOrEqual(10);
      expect(testnetPolicy.cleanup.batchSize).toBeLessThanOrEqual(1000);
      expect(mainnetPolicy.cleanup.batchSize).toBeGreaterThanOrEqual(10);
      expect(mainnetPolicy.cleanup.batchSize).toBeLessThanOrEqual(1000);
    });
  });
});
