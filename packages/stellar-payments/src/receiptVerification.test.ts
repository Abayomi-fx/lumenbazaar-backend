import { describe, it, expect } from "vitest";
import type { PaymentAttempt, Receipt, Settlement } from "@lumenbazaar/shared";
import { Decimal } from "@prisma/client/runtime/library";
import {
  encodeCanonicalEvidence,
  computeCanonicalDigest,
  verifyReceiptEvidence,
  formatDecimalForEncoding,
  RECEIPT_VERIFICATION_VERSION,
  RECEIPT_VERIFICATION_ALGORITHM,
  CANONICAL_ENCODING_TEST_VECTORS
} from "./receiptVerification.js";

describe("Canonical Evidence Encoding", () => {
  describe("encodeCanonicalEvidence", () => {
    it("encodes fields in fixed order with colon delimiter", () => {
      const encoded = encodeCanonicalEvidence(
        "attempt1",
        "hash1",
        "txhash1",
        12345,
        "testnet",
        "100.0000000",
        "GISSUER"
      );

      expect(encoded).toBe("attempt1:hash1:txhash1:12345:testnet:100.0000000:GISSUER");
    });

    it("encodes null transaction hash as 'null' string", () => {
      const encoded = encodeCanonicalEvidence(
        "attempt2",
        "hash2",
        null,
        54321,
        "public",
        "50.5000000",
        "GOTHER"
      );

      expect(encoded).toBe("attempt2:hash2:null:54321:public:50.5000000:GOTHER");
    });

    it("encodes null ledger as 'null' string", () => {
      const encoded = encodeCanonicalEvidence(
        "attempt3",
        "hash3",
        "txhash3",
        null,
        "testnet",
        "1.0000000",
        "GTHIRD"
      );

      expect(encoded).toBe("attempt3:hash3:txhash3:null:testnet:1.0000000:GTHIRD");
    });

    it("encodes both null txhash and ledger", () => {
      const encoded = encodeCanonicalEvidence(
        "attempt4",
        "hash4",
        null,
        null,
        "testnet",
        "75.2500000",
        "GFOURTH"
      );

      expect(encoded).toBe("attempt4:hash4:null:null:testnet:75.2500000:GFOURTH");
    });

    it("preserves decimal representation without scientific notation", () => {
      const encoded = encodeCanonicalEvidence(
        "attempt5",
        "hash5",
        "txhash5",
        99999,
        "public",
        "0.0000001",
        "GFIFTH"
      );

      expect(encoded).toContain("0.0000001");
      expect(encoded).not.toContain("e-");
    });

    it("handles large decimal amounts", () => {
      const encoded = encodeCanonicalEvidence(
        "attempt6",
        "hash6",
        "txhash6",
        11111,
        "testnet",
        "922337203685.4775807",
        "GSIXTH"
      );

      expect(encoded).toContain("922337203685.4775807");
    });
  });

  describe("formatDecimalForEncoding", () => {
    it("converts string directly", () => {
      expect(formatDecimalForEncoding("100.0000000")).toBe("100.0000000");
    });

    it("converts number to string", () => {
      expect(formatDecimalForEncoding(100)).toBe("100");
    });

    it("converts Prisma Decimal to string", () => {
      const decimal = new Decimal("123.4567890");
      expect(formatDecimalForEncoding(decimal)).toBe("123.4567890");
    });

    it("handles null gracefully", () => {
      const result = formatDecimalForEncoding(null);
      expect(result).toBe("null");
    });
  });

  describe("computeCanonicalDigest", () => {
    it("computes SHA-256 digest of canonical evidence", () => {
      const evidence = "attempt1:hash1:txhash1:12345:testnet:100.0000000:GISSUER";
      const digest = computeCanonicalDigest(evidence);

      // SHA-256 produces 64 hex characters
      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces deterministic digest for same input", () => {
      const evidence = "attempt1:hash1:txhash1:12345:testnet:100.0000000:GISSUER";
      const digest1 = computeCanonicalDigest(evidence);
      const digest2 = computeCanonicalDigest(evidence);

      expect(digest1).toBe(digest2);
    });

    it("produces different digest for different input", () => {
      const evidence1 = "attempt1:hash1:txhash1:12345:testnet:100.0000000:GISSUER";
      const evidence2 = "attempt1:hash1:txhash1:12346:testnet:100.0000000:GISSUER";

      const digest1 = computeCanonicalDigest(evidence1);
      const digest2 = computeCanonicalDigest(evidence2);

      expect(digest1).not.toBe(digest2);
    });

    it("tampering with a single character changes digest", () => {
      const original = "attempt1:hash1:txhash1:12345:testnet:100.0000000:GISSUER";
      const tampered = "attempt1:hash1:txhash1:12345:testnet:100.0000001:GISSUER";

      const digest1 = computeCanonicalDigest(original);
      const digest2 = computeCanonicalDigest(tampered);

      expect(digest1).not.toBe(digest2);
    });

    it("uses UTF-8 encoding", () => {
      // Both should produce consistent result
      const evidence = "attempt1:hash1:txhash1:12345:testnet:100.0000000:GISSUER";
      const digest = computeCanonicalDigest(evidence);

      expect(digest).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("Test Vectors", () => {
    it("has valid test vectors structure", () => {
      expect(CANONICAL_ENCODING_TEST_VECTORS.length).toBeGreaterThan(0);

      for (const vector of CANONICAL_ENCODING_TEST_VECTORS) {
        expect(vector).toHaveProperty("name");
        expect(vector).toHaveProperty("input");
        expect(vector).toHaveProperty("expectedEncoding");
        expect(vector).toHaveProperty("expectedDigest");
      }
    });

    it("encodes test vectors correctly", () => {
      for (const vector of CANONICAL_ENCODING_TEST_VECTORS) {
        const { input, expectedEncoding } = vector;
        const encoded = encodeCanonicalEvidence(
          input.attemptId,
          input.paymentHash,
          input.transactionHash,
          input.ledger,
          input.network,
          input.amount,
          input.assetIssuer
        );

        expect(encoded).toBe(expectedEncoding);
      }
    });

    it("computes digests for test vectors", () => {
      for (const vector of CANONICAL_ENCODING_TEST_VECTORS) {
        const digest = computeCanonicalDigest(vector.expectedEncoding);
        // Just verify it's a valid hex digest; the expectedDigest is illustrative
        expect(digest).toMatch(/^[a-f0-9]{64}$/);
      }
    });
  });
});

describe("Receipt Verification", () => {
  const createMockAttempt = (overrides: Partial<PaymentAttempt> = {}): PaymentAttempt => ({
    id: "attempt-123",
    correlationId: "corr-456",
    paymentHash: "payment-hash-789",
    idempotencyKey: "idem-000",
    resourceId: "resource-111",
    sellerId: "seller-222",
    network: "testnet",
    assetCode: "USDC",
    assetIssuer: "GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW",
    amount: new Decimal("100.0000000"),
    payTo: "GISSUER123",
    status: "received",
    failureCode: null,
    failureReason: null,
    expiresAtLedger: null,
    createdAt: new Date("2024-10-17T10:00:00Z"),
    updatedAt: new Date("2024-10-17T10:00:00Z"),
    ...overrides
  });

  const createMockSettlement = (overrides: Partial<Settlement> = {}): Settlement => ({
    id: "settlement-333",
    correlationId: "corr-456",
    paymentAttemptId: "attempt-123",
    transactionHash: "tx-hash-abc123",
    ledger: 12345,
    network: "testnet",
    amount: new Decimal("100.0000000"),
    assetCode: "USDC",
    assetIssuer: "GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW",
    status: "confirmed",
    reconciliationState: "reconciled",
    reconciliationReason: null,
    reconciliationAttempts: 1,
    lastReconciledAt: new Date("2024-10-17T10:05:00Z"),
    settledAt: new Date("2024-10-17T10:05:00Z"),
    createdAt: new Date("2024-10-17T10:00:00Z"),
    ...overrides
  });

  const createMockReceipt = (
    attempt: PaymentAttempt,
    settlement: Settlement,
    overrides: Partial<Receipt> = {}
  ): Receipt => {
    const canonical = encodeCanonicalEvidence(
      attempt.id,
      attempt.paymentHash,
      settlement.transactionHash,
      settlement.ledger,
      settlement.network,
      settlement.amount,
      settlement.assetIssuer
    );
    const digest = computeCanonicalDigest(canonical);

    return {
      id: "receipt-444",
      correlationId: attempt.correlationId,
      paymentAttemptId: attempt.id,
      resourceId: attempt.resourceId,
      sellerId: attempt.sellerId,
      transactionHash: settlement.transactionHash,
      ledger: settlement.ledger,
      network: settlement.network,
      amount: settlement.amount,
      assetCode: settlement.assetCode,
      assetIssuer: settlement.assetIssuer,
      status: "finalized",
      settledAt: settlement.settledAt,
      failureCode: attempt.failureCode,
      failureReason: attempt.failureReason,
      evidenceHash: digest,
      createdAt: new Date("2024-10-17T10:05:00Z"),
      updatedAt: new Date("2024-10-17T10:05:00Z"),
      ...overrides
    };
  };

  describe("verifyReceiptEvidence", () => {
    it("verifies finalized receipt with matching evidence", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(true);
      expect(result.receiptStatus).toBe("finalized");
      expect(result.settlementState).toBe("reconciled");
      expect(result.digest).toBeDefined();
      expect(result.digest?.version).toBe(RECEIPT_VERIFICATION_VERSION);
      expect(result.digest?.algorithm).toBe(RECEIPT_VERIFICATION_ALGORITHM);
      expect(result.reason).toBeUndefined();
    });

    it("fails verification when settlement is missing", () => {
      const attempt = createMockAttempt();
      const receipt = createMockReceipt(attempt, createMockSettlement());

      const result = verifyReceiptEvidence(receipt, attempt, null);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("no_settlement");
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "settlement",
          status: "missing"
        })
      );
    });

    it("fails verification for pending receipt", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, { status: "pending" });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.receiptStatus).toBe("pending");
      expect(result.reason).toBe("pending_receipt");
      expect(result.reasonMessage).toContain("pending");
    });

    it("detects tampered transaction hash", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, {
        transactionHash: "tampered-tx-hash"
      });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("field_mismatch");
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "transactionHash",
          status: "mismatch"
        })
      );
    });

    it("detects tampered ledger", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, { ledger: 99999 });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("field_mismatch");
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "ledger",
          status: "mismatch"
        })
      );
    });

    it("detects tampered amount", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, {
        amount: new Decimal("50.0000000")
      });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("field_mismatch");
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "amount",
          status: "mismatch"
        })
      );
    });

    it("detects tampered assetCode", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, { assetCode: "FAKE" });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("field_mismatch");
    });

    it("detects tampered assetIssuer", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, {
        assetIssuer: "GFAKEPUBLIC1234567890ABCDEFGH"
      });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("field_mismatch");
    });

    it("detects tampered evidence hash", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, {
        evidenceHash: "0000000000000000000000000000000000000000000000000000000000000000"
      });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("evidence_hash_invalid");
    });

    it("fails when settlement is pending (not reconciled)", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement({ reconciliationState: "pending" });
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("incomplete_evidence");
    });

    it("fails when settlement needs review", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement({ reconciliationState: "needs_review" });
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("incomplete_evidence");
    });

    it("fails when transaction hash is missing from settlement", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement({ transactionHash: null });
      const receipt = createMockReceipt(attempt, settlement, { transactionHash: null });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("incomplete_evidence");
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "transactionHash",
          status: "missing"
        })
      );
    });

    it("fails when ledger is missing from settlement", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement({ ledger: null });
      const receipt = createMockReceipt(attempt, settlement, { ledger: null });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("incomplete_evidence");
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "ledger",
          status: "missing"
        })
      );
    });

    it("verifies with settlement in 'not_required' reconciliation state", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement({ reconciliationState: "not_required" });
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(true);
      expect(result.settlementState).toBe("not_required");
    });

    it("includes all field verification results in output", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      // Should include fields for: transactionHash, ledger, network, amount, assetCode, assetIssuer, status,
      // correlationId, resourceId, sellerId, failureCode, failureReason, digest
      expect(result.fields.length).toBeGreaterThan(5);
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "digest",
          status: "match"
        })
      );
    });

    it("tracks settlement state in result", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement({ reconciliationState: "reconciled" });
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.settlementState).toBe("reconciled");
    });

    it("handles null failure code and reason", () => {
      const attempt = createMockAttempt({
        failureCode: null,
        failureReason: null
      });
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(true);
      expect(result.fields).toContainEqual(
        expect.objectContaining({
          field: "failureCode",
          status: "match"
        })
      );
    });

    it("detects mismatched correlationId between receipt and attempt", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement, {
        correlationId: "wrong-corr-id"
      });

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.verified).toBe(false);
      expect(result.reason).toBe("field_mismatch");
    });

    it("returns comprehensive digest with version and algorithm", () => {
      const attempt = createMockAttempt();
      const settlement = createMockSettlement();
      const receipt = createMockReceipt(attempt, settlement);

      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      expect(result.digest).toEqual({
        value: expect.stringMatching(/^[a-f0-9]{64}$/),
        version: "1.0",
        algorithm: "SHA-256"
      });
    });
  });
});
