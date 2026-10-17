import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebhookEventService } from "./webhookEvents.js";
import { buildWebhookPayload } from "@lumenbazaar/shared";

describe("WebhookEventService", () => {
  let service: WebhookEventService;

  beforeEach(() => {
    service = new WebhookEventService();
  });

  it("emits webhook events", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "confirmed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: "abc123...",
      failureCode: null,
      failureReason: null,
    };

    const events: any[] = [];
    service.subscribe((event) => events.push(event));

    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);

    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("settlement.finalized");
    expect(events[0].sellerId).toBe("seller_123");
    expect(events[0].settlementId).toBe("settle_123");
    expect(events[0].payload.schemaVersion).toBe("1.0.0");
  });

  it("generates stable event IDs from correlationId", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "confirmed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: "abc123...",
      failureCode: null,
      failureReason: null,
    };

    const events: any[] = [];
    service.subscribe((event) => events.push(event));

    // First emission
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);

    const firstEventId = events[0].eventId;

    // Second emission of same event type should have same eventId
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);

    // Should not emit duplicate (idempotent)
    expect(events).toHaveLength(1);

    // Different event type should have different eventId
    await service.emitSettlementEvent("seller_123", "settlement.reconciled", settlement);
    expect(events).toHaveLength(2);
    expect(events[1].eventId).not.toBe(firstEventId);
  });

  it("prevents duplicate events (idempotency)", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "confirmed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: "abc123...",
      failureCode: null,
      failureReason: null,
    };

    const events: any[] = [];
    service.subscribe((event) => events.push(event));

    // Emit same event multiple times
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);

    // Should only emit once
    expect(events).toHaveLength(1);
  });

  it("excludes optional fields from payload when null", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "failed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: null,
      failureCode: "SETTLEMENT_FAILED",
      failureReason: "Insufficient funds",
    };

    const events: any[] = [];
    service.subscribe((event) => events.push(event));

    await service.emitSettlementEvent("seller_123", "settlement.failed", settlement);

    expect(events).toHaveLength(1);
    expect(events[0].payload.transactionHash).toBeUndefined();
    expect(events[0].payload.failureCode).toBe("SETTLEMENT_FAILED");
    expect(events[0].payload.failureReason).toBe("Insufficient funds");
  });

  it("includes optional fields when present", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "confirmed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: "abc123def456",
      failureCode: null,
      failureReason: null,
    };

    const events: any[] = [];
    service.subscribe((event) => events.push(event));

    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);

    expect(events).toHaveLength(1);
    expect(events[0].payload.transactionHash).toBe("abc123def456");
    expect(events[0].payload.failureCode).toBeUndefined();
    expect(events[0].payload.failureReason).toBeUndefined();
  });

  it("handles listener subscription and unsubscription", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "confirmed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: "abc123...",
      failureCode: null,
      failureReason: null,
    };

    const events1: any[] = [];
    const events2: any[] = [];

    const unsubscribe1 = service.subscribe((event) => events1.push(event));
    const unsubscribe2 = service.subscribe((event) => events2.push(event));

    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement);

    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);

    unsubscribe1();

    // Reset for new settlement with different ID
    const settlement2 = { ...settlement, correlationId: "corr_456" };
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement2);

    expect(events1).toHaveLength(1); // No new events
    expect(events2).toHaveLength(2); // Got new event

    unsubscribe2();

    const settlement3 = { ...settlement, correlationId: "corr_789" };
    await service.emitSettlementEvent("seller_123", "settlement.finalized", settlement3);

    expect(events1).toHaveLength(1); // Still 1
    expect(events2).toHaveLength(2); // Still 2
  });

  it("swallows listener errors", async () => {
    const settlement = {
      id: "settle_123",
      correlationId: "corr_123",
      paymentAttemptId: "pay_456",
      status: "confirmed" as const,
      amount: "100000000",
      assetCode: "USDC",
      assetIssuer: "GAAAA...",
      network: "testnet",
      transactionHash: "abc123...",
      failureCode: null,
      failureReason: null,
    };

    const events: any[] = [];

    service.subscribe(() => {
      throw new Error("Listener failed");
    });

    service.subscribe((event) => events.push(event));

    // Should not throw even if first listener fails
    await expect(
      service.emitSettlementEvent("seller_123", "settlement.finalized", settlement)
    ).resolves.not.toThrow();

    // Second listener should still receive event
    expect(events).toHaveLength(1);
  });

  it("lists webhook events for seller", async () => {
    const settlements = [
      {
        id: "settle_1",
        correlationId: "corr_1",
        paymentAttemptId: "pay_1",
        status: "confirmed" as const,
        amount: "100000000",
        assetCode: "USDC",
        assetIssuer: "GAAAA...",
        network: "testnet",
        transactionHash: "abc...",
        failureCode: null,
        failureReason: null,
      },
      {
        id: "settle_2",
        correlationId: "corr_2",
        paymentAttemptId: "pay_2",
        status: "failed" as const,
        amount: "50000000",
        assetCode: "USDC",
        assetIssuer: "GAAAA...",
        network: "testnet",
        transactionHash: null,
        failureCode: "SETTLEMENT_FAILED",
        failureReason: "Rejected",
      },
    ];

    for (const settlement of settlements) {
      await service.emitSettlementEvent(
        "seller_123",
        settlement.status === "confirmed" ? "settlement.finalized" : "settlement.failed",
        settlement
      );
    }

    const { events, total } = await service.listWebhookEvents("seller_123", 100, 0);

    expect(total).toBe(2);
    expect(events).toHaveLength(2);
    expect(events[0].eventType).toBe("settlement.failed");
    expect(events[1].eventType).toBe("settlement.finalized");
  });
});
