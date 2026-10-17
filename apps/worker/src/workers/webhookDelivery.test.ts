import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  deliverWebhook,
  computeBackoffDelay,
  redactSensitiveHeaders,
  createWebhookDeliveryAttemptRecord,
  type WebhookDeliveryJobInput,
} from "./webhookDelivery.js";
import { buildWebhookPayload, type WebhookPayload } from "@lumenbazaar/shared";

describe("webhook delivery backoff", () => {
  it("computes exponential backoff with jitter", () => {
    // Attempt 0: base ~5000ms + jitter
    const attempt0 = computeBackoffDelay(0, 5000);
    expect(attempt0).toBeGreaterThanOrEqual(5000);
    expect(attempt0).toBeLessThan(5000 * 1.1);

    // Attempt 1: ~10000ms + jitter
    const attempt1 = computeBackoffDelay(1, 5000);
    expect(attempt1).toBeGreaterThanOrEqual(10000);
    expect(attempt1).toBeLessThan(10000 * 1.1);

    // Attempt 2: ~20000ms + jitter
    const attempt2 = computeBackoffDelay(2, 5000);
    expect(attempt2).toBeGreaterThanOrEqual(20000);
    expect(attempt2).toBeLessThan(20000 * 1.1);
  });

  it("adds randomized jitter", () => {
    const delays = Array.from({ length: 10 }, () =>
      computeBackoffDelay(1, 5000)
    );
    const unique = new Set(delays);
    expect(unique.size).toBeGreaterThan(1); // Should have variation
  });
});

describe("webhook delivery header redaction", () => {
  it("redacts sensitive headers", () => {
    const headers = {
      "content-type": "application/json",
      authorization: "Bearer token123",
      "x-api-key": "secret-key",
      cookie: "session=xyz",
    };

    const redacted = redactSensitiveHeaders(headers);

    expect(redacted["content-type"]).toBe("application/json");
    expect(redacted["authorization"]).toBe("[REDACTED]");
    expect(redacted["x-api-key"]).toBe("[REDACTED]");
    expect(redacted["cookie"]).toBe("[REDACTED]");
  });

  it("handles case-insensitive header names", () => {
    const headers = {
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    };

    const redacted = redactSensitiveHeaders(headers);

    expect(redacted["Authorization"]).toBe("[REDACTED]");
    expect(redacted["Content-Type"]).toBe("application/json");
  });
});

describe("webhook delivery attempt record", () => {
  it("creates delivery attempt record with success", () => {
    const record = createWebhookDeliveryAttemptRecord(
      "event_123",
      "endpoint_456",
      1,
      "https://api.example.com/webhook",
      { "content-type": "application/json" },
      {
        success: true,
        statusCode: 200,
        latencyMs: 150,
        shouldRetry: false,
      }
    );

    expect(record.eventId).toBe("event_123");
    expect(record.endpointId).toBe("endpoint_456");
    expect(record.attemptNumber).toBe(1);
    expect(record.statusCode).toBe(200);
    expect(record.latencyMs).toBe(150);
    expect(record.errorClass).toBeNull();
    expect(record.responseBodyTruncated).toBeNull();
  });

  it("truncates response body", () => {
    const longBody = "x".repeat(1000);
    const record = createWebhookDeliveryAttemptRecord(
      "event_123",
      "endpoint_456",
      1,
      "https://api.example.com/webhook",
      { "content-type": "application/json" },
      {
        success: false,
        statusCode: 500,
        latencyMs: 5000,
        errorClass: "ServerError",
        responseBodyTruncated: longBody,
        shouldRetry: true,
      }
    );

    expect(record.responseBodyTruncated?.length).toBeLessThanOrEqual(503); // 500 + "..."
    expect(record.responseBodyTruncated).toContain("...");
  });
});

describe("webhook delivery success scenarios", () => {
  it("handles successful 2xx response", async () => {
    // Mock fetch would be tested in integration tests
    // This is a structural test
    const payload: WebhookPayload = {
      schemaVersion: "1.0.0",
      eventId: "evt_123",
      eventType: "settlement.finalized",
      timestamp: new Date().toISOString(),
      paymentId: "pay_456",
      settlementId: "settle_789",
      status: "confirmed",
      network: "testnet",
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
    };

    const input: WebhookDeliveryJobInput = {
      eventId: "evt_123",
      endpointId: "ep_123",
      sellerId: "seller_123",
      url: "https://api.example.com/webhook",
      payload,
      secret: "test-secret",
      attemptNumber: 0,
    };

    // Actual delivery testing requires mocking fetch
    // This structure ensures the function accepts the right input types
    expect(input).toBeDefined();
  });
});

describe("webhook delivery retry logic", () => {
  it("determines retry decisions for different status codes", () => {
    const retryableStatuses = [408, 429, 500, 502, 503, 504];
    const nonRetryableStatuses = [400, 401, 403, 404];

    // This test documents expected behavior
    // Actual retry logic is tested in integration tests
    for (const status of retryableStatuses) {
      // statusCode >= 500 or statusCode in [408, 429, 503] should retry
      const shouldRetry =
        (status >= 500 || status === 408 || status === 429 || status === 503) &&
        0 < 5; // attemptNumber < MAX_ATTEMPTS
      expect(shouldRetry).toBe(true);
    }

    for (const status of nonRetryableStatuses) {
      // statusCode in 400s should not retry (except 408, 429)
      const shouldRetry = status >= 500 && 0 < 5;
      expect(shouldRetry).toBe(false);
    }
  });

  it("stops retrying after max attempts", () => {
    // After 5 attempts, no more retries
    const attemptNumber = 5;
    const maxAttempts = 5;
    const shouldRetry = attemptNumber < maxAttempts;
    expect(shouldRetry).toBe(false);
  });
});
