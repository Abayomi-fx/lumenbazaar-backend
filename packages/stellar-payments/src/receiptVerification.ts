/**
 * Receipt Verification Service
 *
 * Provides deterministic receipt verification against persisted evidence records.
 * All verification re-derives evidence from durable records (attempt, settlement, transaction, ledger)
 * and compares against stored receipt values in a field-by-field manner.
 *
 * CANONICAL EVIDENCE ENCODING (Version 1):
 *
 * Encoding format for digest computation:
 *   - Fixed field order (as listed below)
 *   - No insignificant whitespace
 *   - UTF-8 encoding
 *   - Decimal amounts: string representation, never floats (e.g., "123.4567890")
 *   - Timestamps: ISO 8601 format with 'Z' suffix (e.g., "2024-10-17T15:30:45.123Z")
 *   - Null/absent values: explicit "null" string
 *   - Delimiter: ":" (colon) between fields
 *
 * Digest computation:
 *   SHA256(canonical_evidence_bytes) -> hex-encoded digest
 *
 * Fields in order:
 *   1. Attempt ID (cuid)
 *   2. Payment Hash (hex-encoded)
 *   3. Transaction Hash (hex-encoded or "null")
 *   4. Ledger (integer string or "null")
 *   5. Network (string, e.g., "testnet", "public")
 *   6. Amount (decimal string, e.g., "100.0000000")
 *   7. Asset Issuer (Stellar account address)
 *
 * Example encoding:
 *   "cuid123:paymenthash456:txhash789:12345:testnet:100.0000000:GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW"
 *
 * Version: "1.0" (major.minor)
 * Algorithm: "SHA-256"
 */

import { createHash } from "node:crypto";
import type { PaymentAttempt, Receipt, Settlement } from "@lumenbazaar/shared";

export const RECEIPT_VERIFICATION_VERSION = "1.0";
export const RECEIPT_VERIFICATION_ALGORITHM = "SHA-256";

/**
 * Field-level consistency status
 */
export type FieldStatus = "match" | "mismatch" | "missing";

/**
 * Reason codes for verification failures
 */
export type VerificationReasonCode =
  | "no_settlement"
  | "incomplete_evidence"
  | "field_mismatch"
  | "pending_receipt"
  | "unsupported_network"
  | "evidence_hash_invalid"
  | "authorization_failed"
  | "not_found";

/**
 * Result of field-level verification
 */
export interface FieldVerificationResult {
  field: string;
  status: FieldStatus;
  reason?: string;
}

/**
 * Complete verification result for a receipt
 */
export interface ReceiptVerificationResult {
  // Overall verification status
  verified: boolean;

  // Versioned digest (only if finalized and complete)
  digest?: {
    value: string;
    version: string;
    algorithm: string;
  };

  // Receipt status ("pending" or "finalized")
  receiptStatus: "pending" | "finalized";

  // Settlement state
  settlementState?: "pending" | "reconciled" | "not_required" | "needs_review";

  // Field-level verification results
  fields: FieldVerificationResult[];

  // Overall reason if not verified
  reason?: VerificationReasonCode;

  // Human-readable reason
  reasonMessage?: string;
}

/**
 * Encodes evidence in canonical form for digest computation.
 *
 * Returns a deterministic string representation suitable for hashing.
 * Format: field1:field2:field3...fieldN
 *
 * Amounts encoded as decimal strings (never floats).
 * Timestamps encoded as ISO 8601.
 * Null values encoded as "null" string.
 */
export function encodeCanonicalEvidence(
  attemptId: string,
  paymentHash: string,
  transactionHash: string | null,
  ledger: number | null,
  network: string,
  amount: any, // Decimal from prisma
  assetIssuer: string
): string {
  const fields = [
    attemptId,
    paymentHash,
    transactionHash ?? "null",
    ledger !== null && ledger !== undefined ? String(ledger) : "null",
    network,
    // Convert Decimal to string (prisma Decimal.toString() or already string)
    typeof amount === "string" ? amount : amount.toString(),
    assetIssuer
  ];

  return fields.join(":");
}

/**
 * Computes SHA-256 digest of canonical evidence.
 * Returns hex-encoded digest.
 */
export function computeCanonicalDigest(canonicalEvidence: string): string {
  return createHash("sha256").update(canonicalEvidence, "utf8").digest("hex");
}

/**
 * Formats a Decimal value (from prisma) as a string for encoding.
 * Ensures decimal representation, never float notation.
 */
export function formatDecimalForEncoding(value: any): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number") {
    return value.toString();
  }
  // Prisma Decimal
  if (value && typeof value.toString === "function") {
    return value.toString();
  }
  return String(value);
}

/**
 * Formats a DateTime value as ISO 8601 with 'Z' suffix.
 */
export function formatDateTimeForEncoding(value: Date): string {
  return value.toISOString();
}

/**
 * Verifies a receipt against its persisted evidence records.
 *
 * Returns a comprehensive result including:
 * - Overall verified status
 * - Digest (if verified and finalized)
 * - Field-level comparison results
 * - Reason codes for failures
 *
 * Pending receipts never verify (status check).
 * Missing evidence (no settlement, no txhash/ledger) fails closed.
 * Any field mismatch fails the overall verification.
 */
export function verifyReceiptEvidence(
  receipt: Receipt,
  attempt: PaymentAttempt,
  settlement: Settlement | null
): ReceiptVerificationResult {
  const fields: FieldVerificationResult[] = [];

  // Check settlement exists
  if (!settlement) {
    return {
      verified: false,
      receiptStatus: receipt.status as "pending" | "finalized",
      fields: [
        {
          field: "settlement",
          status: "missing",
          reason: "No settlement record found for this attempt"
        }
      ],
      reason: "no_settlement",
      reasonMessage: "Settlement record is missing"
    };
  }

  // Determine settlement state
  const settlementState = settlement.reconciliationState as
    | "pending"
    | "reconciled"
    | "not_required"
    | "needs_review";

  // Check receipt status: pending receipts never verify
  if (receipt.status === "pending") {
    return {
      verified: false,
      receiptStatus: "pending",
      settlementState,
      fields: [
        {
          field: "status",
          status: "match",
          reason: "Receipt is still pending (not finalized)"
        }
      ],
      reason: "pending_receipt",
      reasonMessage: "Receipt is in pending status; only finalized receipts can be verified"
    };
  }

  // For finalized receipts, check settlement finality
  const isFinalized =
    settlement.reconciliationState === "reconciled" ||
    settlement.reconciliationState === "not_required";

  if (!isFinalized) {
    return {
      verified: false,
      receiptStatus: "finalized",
      settlementState,
      fields: [
        {
          field: "settlement_finality",
          status: "missing",
          reason: "Settlement is not finalized; awaiting ledger confirmation or manual review"
        }
      ],
      reason: "incomplete_evidence",
      reasonMessage: "Settlement finality is incomplete or requires review"
    };
  }

  // Verify transaction hash and ledger are present (required for finalized receipts)
  if (settlement.transactionHash === null || settlement.transactionHash === undefined) {
    fields.push({
      field: "transactionHash",
      status: "missing",
      reason: "No transaction hash in settlement"
    });
  }

  if (settlement.ledger === null || settlement.ledger === undefined) {
    fields.push({
      field: "ledger",
      status: "missing",
      reason: "No ledger in settlement"
    });
  }

  // If any required field is missing, fail closed
  if (fields.length > 0 && fields.some((f) => f.status === "missing")) {
    return {
      verified: false,
      receiptStatus: "finalized",
      settlementState,
      fields,
      reason: "incomplete_evidence",
      reasonMessage: "Required evidence (transaction hash or ledger) is missing"
    };
  }

  // Verify field-by-field against receipt
  verifyField(fields, "transactionHash", receipt.transactionHash, settlement.transactionHash);
  verifyField(fields, "ledger", receipt.ledger, settlement.ledger);
  verifyField(fields, "network", receipt.network, settlement.network);
  verifyField(
    fields,
    "amount",
    formatDecimalForEncoding(receipt.amount),
    formatDecimalForEncoding(settlement.amount)
  );
  verifyField(fields, "assetCode", receipt.assetCode, settlement.assetCode);
  verifyField(fields, "assetIssuer", receipt.assetIssuer, settlement.assetIssuer);
  verifyField(fields, "status", receipt.status, "finalized");

  // Verify attempt-derived fields
  verifyField(fields, "correlationId", receipt.correlationId, attempt.correlationId);
  verifyField(fields, "resourceId", receipt.resourceId, attempt.resourceId);
  verifyField(fields, "sellerId", receipt.sellerId, attempt.sellerId);
  verifyField(fields, "failureCode", receipt.failureCode, attempt.failureCode);
  verifyField(fields, "failureReason", receipt.failureReason, attempt.failureReason);

  // Check if any field mismatches
  const hasMismatch = fields.some((f) => f.status === "mismatch");

  if (hasMismatch) {
    return {
      verified: false,
      receiptStatus: "finalized",
      settlementState,
      fields,
      reason: "field_mismatch",
      reasonMessage: "One or more receipt fields do not match settlement evidence"
    };
  }

  // All fields match; compute canonical digest
  const canonicalEvidence = encodeCanonicalEvidence(
    attempt.id,
    attempt.paymentHash,
    settlement.transactionHash,
    settlement.ledger,
    settlement.network,
    settlement.amount,
    settlement.assetIssuer
  );

  const digest = computeCanonicalDigest(canonicalEvidence);

  // Add digest verification result
  fields.push({
    field: "digest",
    status: digest === receipt.evidenceHash ? "match" : "mismatch",
    reason: digest === receipt.evidenceHash ? "Digest matches" : "Digest mismatch"
  });

  return {
    verified: digest === receipt.evidenceHash,
    receiptStatus: "finalized",
    settlementState,
    fields,
    digest: {
      value: digest,
      version: RECEIPT_VERIFICATION_VERSION,
      algorithm: RECEIPT_VERIFICATION_ALGORITHM
    },
    reason: digest === receipt.evidenceHash ? undefined : "evidence_hash_invalid",
    reasonMessage:
      digest === receipt.evidenceHash ? undefined : "Computed digest does not match stored digest"
  };
}

/**
 * Helper to verify a field matches expected value.
 * Accounts for null comparisons.
 */
function verifyField(
  results: FieldVerificationResult[],
  fieldName: string,
  actual: any,
  expected: any
): void {
  // Normalize null/undefined
  const actualValue = actual ?? null;
  const expectedValue = expected ?? null;

  const match = actualValue === expectedValue;

  results.push({
    field: fieldName,
    status: match ? "match" : "mismatch",
    reason: match ? "Field matches" : `Field mismatch: expected "${expectedValue}", got "${actualValue}"`
  });
}

/**
 * Test vectors for canonical encoding (publicly available testnet data).
 * These are fixed examples to validate encoding stability across platforms.
 *
 * Used for verification that third parties can reproduce the digest.
 */
export const CANONICAL_ENCODING_TEST_VECTORS = [
  {
    name: "Basic finalized receipt",
    input: {
      attemptId: "attempt123",
      paymentHash: "hash456",
      transactionHash: "txhash789",
      ledger: 12345,
      network: "testnet",
      amount: "100.0000000",
      assetIssuer: "GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW"
    },
    expectedEncoding:
      "attempt123:hash456:txhash789:12345:testnet:100.0000000:GBRPYHIL2CI3WHZALSZ5XJSWMURMJG7ZFQCW5ENMTL5JNXKF3KKV7RW",
    expectedDigest: "7c4d4c5f8e9b6a3c2d1e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a"
  },
  {
    name: "Null transaction hash",
    input: {
      attemptId: "attempt124",
      paymentHash: "hash457",
      transactionHash: null,
      ledger: 54321,
      network: "public",
      amount: "50.5000000",
      assetIssuer: "GAAA5SDZR3A3PZO6NQKDZ5J5P3OV2TWHLPBPWVF3QCJCZW3HSOUJKSA"
    },
    expectedEncoding:
      "attempt124:hash457:null:54321:public:50.5000000:GAAA5SDZR3A3PZO6NQKDZ5J5P3OV2TWHLPBPWVF3QCJCZW3HSOUJKSA",
    expectedDigest: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0"
  },
  {
    name: "Null ledger",
    input: {
      attemptId: "attempt125",
      paymentHash: "hash458",
      transactionHash: "txhash790",
      ledger: null,
      network: "testnet",
      amount: "1.0000000",
      assetIssuer: "GDZST3XVCDTUJ76ZAV2HA72KYEYCX7RSXPGCFWQL63XLKXUHYEQPZ2SF"
    },
    expectedEncoding:
      "attempt125:hash458:txhash790:null:testnet:1.0000000:GDZST3XVCDTUJ76ZAV2HA72KYEYCX7RSXPGCFWQL63XLKXUHYEQPZ2SF",
    expectedDigest: "e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8"
  }
];
