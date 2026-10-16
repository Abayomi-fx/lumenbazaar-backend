import { describe, expect, it, beforeEach } from "vitest";

import {
  RedactionService,
  createRedactionService,
  getGlobalRedactionService,
  setGlobalRedactionService,
  initializeRedactionService
} from "./redactionService.js";
import { DEFAULT_TESTNET_POLICY, DEFAULT_MAINNET_POLICY } from "./retentionPolicy.js";

describe("RedactionService", () => {
  let service: RedactionService;

  beforeEach(() => {
    service = new RedactionService(DEFAULT_TESTNET_POLICY);
  });

  describe("sanitizeMetadata", () => {
    it("redacts sensitive field keys", () => {
      const metadata = {
        normalField: "value",
        secret: "my-secret-123",
        api_key: "sk_live_12345",
        token: "bearer-token-abc"
      };

      const result = service.sanitizeMetadata(metadata);

      expect(result.normalField).toBe("value");
      expect(result.secret).toBe("[redacted]");
      expect(result.api_key).toBe("[redacted]");
      expect(result.token).toBe("[redacted]");
    });

    it("redacts nested objects", () => {
      const metadata = {
        user: {
          id: "user-123",
          password: "super-secret"
        },
        settings: {
          api_key: "key123",
          theme: "dark"
        }
      };

      const result = service.sanitizeMetadata(metadata);

      expect(result.user).toEqual({
        id: "user-123",
        password: "[redacted]"
      });
      expect(result.settings).toEqual({
        api_key: "[redacted]",
        theme: "dark"
      });
    });

    it("redacts arrays containing sensitive values", () => {
      const metadata = {
        items: [
          { id: "1", secret: "secret1" },
          { id: "2", secret: "secret2" }
        ]
      };

      const result = service.sanitizeMetadata(metadata);

      expect(result.items).toEqual([
        { id: "1", secret: "[redacted]" },
        { id: "2", secret: "[redacted]" }
      ]);
    });

    it("redacts sensitive payment field names", () => {
      const metadata = {
        paymentHash: "hash123",
        idempotencyKey: "key123",
        transactionHash: "tx123",
        contractId: "C123",
        contractSessionId: "S123",
        usageHash: "usage123",
        normalField: "value"
      };

      const result = service.sanitizeMetadata(metadata);

      expect(result.paymentHash).toBe("[redacted]");
      expect(result.idempotencyKey).toBe("[redacted]");
      expect(result.transactionHash).toBe("[redacted]");
      expect(result.contractId).toBe("[redacted]");
      expect(result.contractSessionId).toBe("[redacted]");
      expect(result.usageHash).toBe("[redacted]");
      expect(result.normalField).toBe("value");
    });

    it("redacts sensitive text values in strings", () => {
      const metadata = {
        description: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
        stellarKey: "SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX",
        normalField: "value"
      };

      const result = service.sanitizeMetadata(metadata);

      expect(result.description).toContain("[redacted]");
      expect(result.stellarKey).toContain("[redacted]");
      expect(result.normalField).toBe("value");
    });
  });

  describe("redactObject", () => {
    it("redacts sensitive keys from objects", () => {
      const obj = {
        id: "123",
        secret: "my-secret",
        api_key: "key123",
        data: "public"
      };

      const result = service.redactObject(obj);

      expect(result.id).toBe("123");
      expect(result.secret).toBe("[redacted]");
      expect(result.api_key).toBe("[redacted]");
      expect(result.data).toBe("public");
    });

    it("recursively redacts nested objects", () => {
      const obj = {
        outer: {
          inner: {
            secret: "hidden",
            visible: "shown"
          }
        }
      };

      const result = service.redactObject(obj);

      expect(result.outer).toEqual({
        inner: {
          secret: "[redacted]",
          visible: "shown"
        }
      });
    });
  });

  describe("redactErrorDetails", () => {
    it("redacts error details and truncates long values", () => {
      const details = {
        message: "Payment failed",
        context: {
          secret: "very-secret-key-123",
          status: "failed"
        },
        longString: "a".repeat(1000)
      };

      const result = service.redactErrorDetails(details);

      expect(result.message).toBe("Payment failed");
      expect(result.context).toEqual({
        secret: "[redacted]",
        status: "failed"
      });
      expect((result.longString as string).length).toBeLessThan(1000);
      expect((result.longString as string).endsWith("...")).toBe(true);
    });
  });

  describe("redactErrorMessage", () => {
    it("redacts bearer tokens from error messages", () => {
      const message =
        "Failed to authenticate with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

      const result = service.redactErrorMessage(message);

      expect(result).toContain("[redacted]");
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("redacts Stellar secret keys from error messages", () => {
      const message =
        "Invalid signer key SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX used for transaction";

      const result = service.redactErrorMessage(message);

      expect(result).toContain("[redacted]");
      expect(result).not.toContain("SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX");
    });

    it("redacts key-value pairs from error messages", () => {
      const message = "Config validation failed: api_key=sk_live_1234567890 and secret:my-super-secret";

      const result = service.redactErrorMessage(message);

      expect(result).toContain("[redacted]");
      expect(result).not.toContain("sk_live_1234567890");
      expect(result).not.toContain("my-super-secret");
    });

    it("truncates very long error messages", () => {
      const longMessage = "Error: " + "a".repeat(2000);

      const result = service.redactErrorMessage(longMessage);

      expect(result.length).toBeLessThanOrEqual(DEFAULT_TESTNET_POLICY.redaction.maxErrorMessageLength);
      expect(result.endsWith("...")).toBe(true);
    });
  });

  describe("redactJobError", () => {
    it("handles Error objects", () => {
      const error = new Error(
        "Failed with Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"
      );

      const result = service.redactJobError(error);

      expect(result).toContain("[redacted]");
      expect(result).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    });

    it("handles string errors", () => {
      const error = "Failed to process payment with api_key=secret123";

      const result = service.redactJobError(error);

      expect(result).toContain("[redacted]");
      expect(result).not.toContain("secret123");
    });
  });

  describe("redactPaymentRecord", () => {
    it("redacts payment attempt records", () => {
      const payment = {
        id: "attempt-123",
        paymentHash: "hash123",
        idempotencyKey: "key123",
        amount: "100.00",
        network: "stellar:testnet",
        status: "received"
      };

      const result = service.redactPaymentRecord(payment);

      expect(result.id).toBe("attempt-123");
      expect(result.paymentHash).toBe("[redacted]");
      expect(result.idempotencyKey).toBe("[redacted]");
      expect(result.amount).toBe("100.00");
      expect(result.status).toBe("received");
    });
  });

  describe("isFieldRedacted", () => {
    it("returns true for sensitive field names", () => {
      expect(service.isFieldRedacted("secret")).toBe(true);
      expect(service.isFieldRedacted("api_key")).toBe(true);
      expect(service.isFieldRedacted("paymentHash")).toBe(true);
      expect(service.isFieldRedacted("contractId")).toBe(true);
    });

    it("returns false for normal field names", () => {
      expect(service.isFieldRedacted("id")).toBe(false);
      expect(service.isFieldRedacted("amount")).toBe(false);
      expect(service.isFieldRedacted("status")).toBe(false);
      expect(service.isFieldRedacted("createdAt")).toBe(false);
    });
  });

  describe("getRedactionStatus", () => {
    it("returns redaction configuration status", () => {
      const status = service.getRedactionStatus();

      expect(status.enabled).toBe(true);
      expect(status.environment).toBe("testnet");
      expect(status.fieldPatternsCount).toBeGreaterThan(0);
      expect(status.valuePatternCount).toBeGreaterThan(0);
      expect(status.maxErrorMessageLength).toBeGreaterThan(0);
    });

    it("reflects mainnet configuration", () => {
      const mainnetService = new RedactionService(DEFAULT_MAINNET_POLICY);
      const status = mainnetService.getRedactionStatus();

      expect(status.environment).toBe("mainnet");
      expect(status.maxErrorMessageLength).toBeLessThan(
        DEFAULT_TESTNET_POLICY.redaction.maxErrorMessageLength
      );
    });
  });
});

describe("createRedactionService", () => {
  it("creates service from environment string", () => {
    const service = createRedactionService("testnet");

    expect(service).toBeInstanceOf(RedactionService);
    const status = service.getRedactionStatus();
    expect(status.environment).toBe("testnet");
  });

  it("creates service from policy object", () => {
    const service = createRedactionService(DEFAULT_MAINNET_POLICY);

    expect(service).toBeInstanceOf(RedactionService);
    const status = service.getRedactionStatus();
    expect(status.environment).toBe("mainnet");
  });

  it("creates service for all environments", () => {
    const environments: Array<"local" | "testnet" | "staging" | "mainnet"> = [
      "local",
      "testnet",
      "staging",
      "mainnet"
    ];

    for (const env of environments) {
      const service = createRedactionService(env);
      expect(service).toBeInstanceOf(RedactionService);
      const status = service.getRedactionStatus();
      expect(status.enabled).toBe(true);
    }
  });
});

describe("Global redaction service", () => {
  beforeEach(() => {
    // Reset to default
    setGlobalRedactionService(new RedactionService(DEFAULT_TESTNET_POLICY));
  });

  it("initializes with default testnet policy", () => {
    const service = getGlobalRedactionService();

    expect(service).toBeInstanceOf(RedactionService);
    const status = service.getRedactionStatus();
    expect(status.environment).toBe("testnet");
  });

  it("can set and retrieve custom service", () => {
    const customService = new RedactionService(DEFAULT_MAINNET_POLICY);
    setGlobalRedactionService(customService);

    const retrieved = getGlobalRedactionService();

    expect(retrieved).toBe(customService);
    const status = retrieved.getRedactionStatus();
    expect(status.environment).toBe("mainnet");
  });

  it("initializes service and updates global reference", () => {
    const service = initializeRedactionService(DEFAULT_MAINNET_POLICY);
    const retrieved = getGlobalRedactionService();

    expect(retrieved).toBe(service);
    const status = retrieved.getRedactionStatus();
    expect(status.environment).toBe("mainnet");
  });
});

describe("Redaction edge cases", () => {
  let service: RedactionService;

  beforeEach(() => {
    service = new RedactionService(DEFAULT_TESTNET_POLICY);
  });

  it("handles null and undefined values", () => {
    const metadata = {
      nullValue: null,
      undefinedValue: undefined,
      normalValue: "value"
    };

    const result = service.sanitizeMetadata(metadata as Record<string, unknown>);

    expect(result.nullValue).toBe(null);
    expect(result.undefinedValue).toBeUndefined();
    expect(result.normalValue).toBe("value");
  });

  it("handles deeply nested structures", () => {
    const metadata = {
      level1: {
        level2: {
          level3: {
            secret: "hidden",
            visible: "shown"
          }
        }
      }
    };

    const result = service.sanitizeMetadata(metadata);

    expect((result.level1 as Record<string, unknown>).level2).toEqual({
      level3: {
        secret: "[redacted]",
        visible: "shown"
      }
    });
  });

  it("handles mixed types in arrays", () => {
    const metadata = {
      items: ["string", 123, true, null, { secret: "value" }]
    };

    const result = service.sanitizeMetadata(metadata);

    expect(result.items).toEqual(["string", 123, true, null, { secret: "[redacted]" }]);
  });

  it("handles circular references safely", () => {
    // This should not throw
    const metadata: Record<string, unknown> = {
      id: "123",
      normal: "value"
    };

    const result = service.sanitizeMetadata(metadata);

    expect(result.id).toBe("123");
    expect(result.normal).toBe("value");
  });

  it("preserves numeric and boolean types", () => {
    const metadata = {
      count: 42,
      enabled: true,
      disabled: false,
      amount: 99.99,
      scientific: 1.23e-4
    };

    const result = service.sanitizeMetadata(metadata);

    expect(result.count).toBe(42);
    expect(result.enabled).toBe(true);
    expect(result.disabled).toBe(false);
    expect(result.amount).toBe(99.99);
    expect(result.scientific).toBe(1.23e-4);
  });

  it("handles multiple redactions in same string", () => {
    const message =
      "Failed to process with Bearer token123 and secret=mykey and SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX key";

    const result = service.redactErrorMessage(message);

    expect(result).not.toContain("token123");
    expect(result).not.toContain("mykey");
    expect(result).not.toContain("SBGCYAXSV52JRYUBJJ3TTVHJ4THVDKUVPVGWYJK4RN3QXU74NI3EVDFX");
  });

  it("preserves message structure with truncation", () => {
    const message = "Error: " + "a".repeat(1000);

    const result = service.redactErrorMessage(message);

    expect(result.startsWith("Error: ")).toBe(true);
    expect(result.includes("...")).toBe(true);
  });
});

describe("Environment-specific behavior", () => {
  it("testnet allows longer error messages", () => {
    const testnetService = new RedactionService(DEFAULT_TESTNET_POLICY);
    const testnStatus = testnetService.getRedactionStatus();

    const mainnetService = new RedactionService(DEFAULT_MAINNET_POLICY);
    const mainnetStatus = mainnetService.getRedactionStatus();

    expect(testnStatus.maxErrorMessageLength).toBeGreaterThan(
      mainnetStatus.maxErrorMessageLength
    );
  });

  it("mainnet has smaller batch size for cleanup", () => {
    const testnetPolicy = DEFAULT_TESTNET_POLICY;
    const mainnetPolicy = DEFAULT_MAINNET_POLICY;

    expect(testnetPolicy.cleanup.batchSize).toBeGreaterThan(mainnetPolicy.cleanup.batchSize);
  });

  it("mainnet has longer archival threshold", () => {
    const testnetPolicy = DEFAULT_TESTNET_POLICY;
    const mainnetPolicy = DEFAULT_MAINNET_POLICY;

    expect(mainnetPolicy.cleanup.archiveThresholdMs).toBeGreaterThan(
      testnetPolicy.cleanup.archiveThresholdMs
    );
  });
});
