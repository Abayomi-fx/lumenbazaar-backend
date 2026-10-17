import { describe, it, expect, beforeEach } from "vitest";
import { Decimal } from "@prisma/client/runtime/library";
import type { FastifyInstance } from "fastify";
import { buildApiApp } from "../app.js";
import type { ReceiptService, PaymentAttemptStore, SettlementStore } from "@lumenbazaar/stellar-payments";
import {
  InMemoryPaymentAttemptStore,
  InMemorySettlementStore,
  InMemoryReceiptStore,
  ReceiptService as DefaultReceiptService,
  encodeCanonicalEvidence,
  computeCanonicalDigest
} from "@lumenbazaar/stellar-payments";
import type { PaymentAttempt, Settlement, Receipt } from "@lumenbazaar/shared";

describe("Receipt Verification Endpoint", () => {
  let app: FastifyInstance;
  let attemptStore: PaymentAttemptStore;
  let settlementStore: SettlementStore;
  let receiptService: ReceiptService;

  beforeEach(async () => {
    attemptStore = new InMemoryPaymentAttemptStore();
    settlementStore = new InMemorySettlementStore();
    const receiptStore = new InMemoryReceiptStore();
    receiptService = new DefaultReceiptService({ receiptStore });

    app = buildApiApp({
      logger: false,
      verificationService: undefined, // Will use default
      receiptService,
      paymentCapabilities: {
        exact: false,
        upto: false
      }
    });

    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  const createTestPaymentAttempt = async (
    overrides: Partial<PaymentAttempt> = {}
  ): Promise<PaymentAttempt> => {
    return attemptStore.createVerifiedAttempt({
      correlationId: "corr-123",
      paymentHash: "hash-" + Math.random().toString(36),
      resourceId: "resource-123",
      sellerId: "seller-123",
      network: "testnet",
      assetCode: "USDC",
      assetIssuer: "GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW",
      amount: "100.0000000",
      payTo: "GISSUER123",
      ...overrides
    });
  };

  const createTestSettlement = async (
    paymentAttemptId: string,
    overrides: Partial<Parameters<typeof settlementStore.createSettlement>[0]> = {}
  ): Promise<Settlement> => {
    return settlementStore.createSettlement({
      paymentAttemptId,
      correlationId: "corr-123",
      transactionHash: "tx-hash-abc123",
      ledger: 12345,
      network: "testnet",
      amount: "100.0000000",
      assetCode: "USDC",
      assetIssuer: "GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW",
      status: "confirmed",
      reconciliationState: "reconciled",
      settledAt: new Date().toISOString(),
      ...overrides
    });
  };

  const createTestReceipt = async (
    paymentAttempt: PaymentAttempt,
    settlement: Settlement,
    overrides: Partial<Receipt> = {}
  ): Promise<Receipt> => {
    const canonical = encodeCanonicalEvidence(
      paymentAttempt.id,
      paymentAttempt.paymentHash,
      settlement.transactionHash,
      settlement.ledger,
      settlement.network,
      settlement.amount,
      settlement.assetIssuer
    );
    const digest = computeCanonicalDigest(canonical);

    return receiptService.finalizeSettlementReceipt(paymentAttempt, settlement);
  };

  describe("GET /v1/receipts/:receiptId/verify", () => {
    it("verifies a finalized receipt with matching evidence", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(true);
      expect(body.receiptStatus).toBe("finalized");
      expect(body.settlementState).toBe("reconciled");
      expect(body.digest).toBeDefined();
      expect(body.digest.version).toBe("1.0");
      expect(body.digest.algorithm).toBe("SHA-256");
      expect(body.digest.value).toMatch(/^[a-f0-9]{64}$/);
      expect(body.fields).toBeInstanceOf(Array);
      expect(body.fields.length).toBeGreaterThan(0);
      expect(body.reason).toBeUndefined();
    });

    it("returns 404 for non-existent receipt", async () => {
      const response = await app.inject({
        method: "GET",
        url: "/v1/receipts/nonexistent-receipt-id/verify"
      });

      expect(response.statusCode).toBe(404);
      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
    });

    it("fails verification for pending receipt", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);

      // Create receipt with pending status
      const receipt = await receiptService.finalizeSettlementReceipt(attempt, {
        ...settlement,
        status: "pending"
      });

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.receiptStatus).toBe("pending");
      expect(body.reason).toBe("pending_receipt");
      expect(body.digest).toBeUndefined();
    });

    it("detects tampered transaction hash", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);
      let receipt = await createTestReceipt(attempt, settlement);

      // Tamper with receipt's transaction hash
      receipt = {
        ...receipt,
        transactionHash: "tampered-tx-hash"
      };

      // Mock the receipt store to return tampered receipt
      const originalGet = receiptService.getReceipt;
      receiptService.getReceipt = async () => receipt;

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      receiptService.getReceipt = originalGet;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.reason).toBe("field_mismatch");
      expect(body.fields).toContainEqual(
        expect.objectContaining({
          field: "transactionHash",
          status: "mismatch"
        })
      );
    });

    it("detects tampered amount", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);
      let receipt = await createTestReceipt(attempt, settlement);

      // Tamper with receipt's amount
      receipt = {
        ...receipt,
        amount: new Decimal("50.0000000")
      };

      // Mock the receipt store to return tampered receipt
      const originalGet = receiptService.getReceipt;
      receiptService.getReceipt = async () => receipt;

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      receiptService.getReceipt = originalGet;

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.reason).toBe("field_mismatch");
    });

    it("sets correlation ID header from receipt", async () => {
      const attempt = await createTestPaymentAttempt({ correlationId: "corr-custom-123" });
      const settlement = await createTestSettlement(attempt.id);
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.headers["x-correlation-id"]).toBe("corr-custom-123");
    });

    it("includes all field verification results", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      const body = JSON.parse(response.body);
      expect(body.fields).toBeInstanceOf(Array);
      expect(body.fields.length).toBeGreaterThan(5);

      // Should include these fields
      const fieldNames = body.fields.map((f: any) => f.field);
      expect(fieldNames).toContain("transactionHash");
      expect(fieldNames).toContain("ledger");
      expect(fieldNames).toContain("network");
      expect(fieldNames).toContain("amount");
      expect(fieldNames).toContain("digest");
    });

    it("handles settlement in not_required reconciliation state", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id, {
        reconciliationState: "not_required"
      });
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(true);
      expect(body.settlementState).toBe("not_required");
    });

    it("fails when settlement is pending (awaiting reconciliation)", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id, {
        reconciliationState: "pending"
      });
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.reason).toBe("incomplete_evidence");
    });

    it("fails when settlement needs review", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id, {
        reconciliationState: "needs_review"
      });
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.reason).toBe("incomplete_evidence");
    });

    it("fails when transaction hash is missing", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id, {
        transactionHash: null
      });
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.reason).toBe("incomplete_evidence");
      expect(body.fields).toContainEqual(
        expect.objectContaining({
          field: "transactionHash",
          status: "missing"
        })
      );
    });

    it("fails when ledger is missing", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id, {
        ledger: null
      });
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(false);
      expect(body.reason).toBe("incomplete_evidence");
      expect(body.fields).toContainEqual(
        expect.objectContaining({
          field: "ledger",
          status: "missing"
        })
      );
    });

    it("deterministic: repeated calls return identical digest", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);
      const receipt = await createTestReceipt(attempt, settlement);

      const response1 = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      const response2 = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      const body1 = JSON.parse(response1.body);
      const body2 = JSON.parse(response2.body);

      expect(body1.digest?.value).toBe(body2.digest?.value);
      expect(body1.verified).toBe(body2.verified);
      expect(body1.fields).toEqual(body2.fields);
    });

    it("does not modify receipt during verification", async () => {
      const attempt = await createTestPaymentAttempt();
      const settlement = await createTestSettlement(attempt.id);
      const receipt = await createTestReceipt(attempt, settlement);

      const receiptBefore = await receiptService.getReceipt(receipt.id);

      await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      const receiptAfter = await receiptService.getReceipt(receipt.id);

      // Receipt should be unchanged
      expect(receiptAfter).toEqual(receiptBefore);
    });

    it("handles null failure code and reason", async () => {
      const attempt = await createTestPaymentAttempt({
        failureCode: null,
        failureReason: null
      });
      const settlement = await createTestSettlement(attempt.id);
      const receipt = await createTestReceipt(attempt, settlement);

      const response = await app.inject({
        method: "GET",
        url: `/v1/receipts/${receipt.id}/verify`
      });

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);

      expect(body.verified).toBe(true);
      expect(body.fields).toContainEqual(
        expect.objectContaining({
          field: "failureCode",
          status: "match"
        })
      );
    });

    it("responds with proper error format on internal errors", async () => {
      // Try to verify a receipt that doesn't have a linked attempt
      const response = await app.inject({
        method: "GET",
        url: "/v1/receipts/invalid-id/verify"
      });

      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      const body = JSON.parse(response.body);
      expect(body.error).toBeDefined();
    });
  });
});
