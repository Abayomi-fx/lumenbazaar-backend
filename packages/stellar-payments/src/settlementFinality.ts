/**
 * Settlement Finality Management
 *
 * This module manages the lifecycle of settlement finality confirmation.
 * Key patterns:
 *
 * 1. SETTLEMENT STATES:
 *    - "confirmed" (RPC/adapter reported success with ledger)
 *    - "failed" (adapter or on-chain settlement failed)
 *    - "timed_out" (finality resolution timed out)
 *
 * 2. RECONCILIATION STATES:
 *    - "not_required": Settlement marked final in adapter (legacy path, no Horizon poll needed)
 *    - "pending": Transaction hash exists, awaiting Horizon confirmation
 *    - "reconciled": Horizon confirmed the transaction
 *    - "needs_review": Transaction failed on-chain or Horizon verification failed
 *
 * 3. RECEIPT FINALIZATION:
 *    - Receipts created in "pending" status when settlement submitted
 *    - Receipt finalized to "finalized" status ONLY after Horizon confirms
 *    - Evidence hash is computed and verified during reconciliation
 *
 * 4. IDEMPOTENCY:
 *    - PaymentAttemptStore tracks by paymentHash with claimSettlement() atomic transition
 *    - SettlementStore prevents duplicate transaction hashes
 *    - Concurrent settlement requests wait for in-progress result
 *
 * 5. RETRY & TIMEOUT HANDLING:
 *    - RPC finality polling: 20 attempts with exponential backoff (100ms → 2000ms)
 *    - Horizon reconciliation: 8 attempts with exponential backoff (5s → 640s)
 *    - Failed transactions: Marked for manual review instead of infinite retry
 *    - Timeout transactions: Can retry during reconciliation phase
 */

import { type Settlement, type Receipt, type PaymentAttempt } from "@lumenbazaar/shared";

/**
 * Represents the result of finality verification.
 * Used to determine if a settlement can safely finalize a receipt.
 */
export type FinalityVerificationResult = {
  // True if transaction is confirmed on ledger with matching hash
  isFinalized: boolean;
  // The confirmed ledger number (if isFinalized)
  ledger?: number;
  // Reason if not finalized (pending, failed, error)
  reason?: string;
  // Whether this state requires manual review
  needsReview: boolean;
};

/**
 * Determines if a settlement has achieved finality sufficient for receipt creation.
 *
 * Finality is achieved when:
 * 1. reconciliationState is "reconciled" (Horizon confirmed), OR
 * 2. reconciliationState is "not_required" (legacy adapter-final path)
 *
 * NOT finalized when:
 * - reconciliationState is "pending" (still awaiting Horizon confirmation)
 * - reconciliationState is "needs_review" (failed on-chain)
 */
export function isSettlementFinalized(settlement: Settlement): boolean {
  return (
    settlement.reconciliationState === "reconciled" ||
    settlement.reconciliationState === "not_required"
  );
}

/**
 * Determines if a settlement requires manual intervention.
 * This includes failed transactions and reconciliation timeouts.
 */
export function doesSettlementNeedReview(settlement: Settlement): boolean {
  return settlement.reconciliationState === "needs_review";
}

/**
 * Determines if a settlement is still awaiting Horizon confirmation.
 * These settlements have a transaction hash but haven't been confirmed yet.
 */
export function isSettlementPending(settlement: Settlement): boolean {
  return (
    settlement.reconciliationState === "pending" &&
    settlement.transactionHash !== null &&
    settlement.status === "confirmed"
  );
}

/**
 * Computes the expected evidence hash for a settlement.
 * Used during reconciliation to verify receipt integrity.
 *
 * Evidence hash: SHA256(
 *   attemptId:paymentHash:transactionHash:ledger:network:amount:assetIssuer
 * )
 *
 * This hash ties together all settlement parameters and cannot be forged
 * without access to the private transaction data.
 */
export function computeExpectedEvidenceHash(
  attempt: PaymentAttempt,
  settlement: Settlement,
  digestFn?: (input: string) => string
): string {
  const hash = digestFn ?? ((input: string) => {
    // Use crypto dynamically to avoid circular dependency
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createHash } = require("node:crypto");
    return createHash("sha256").update(input, "utf8").digest("hex");
  });

  const input = [
    attempt.id,
    attempt.paymentHash,
    settlement.transactionHash ?? "",
    String(settlement.ledger ?? ""),
    settlement.network,
    settlement.amount,
    settlement.assetIssuer
  ].join(":");

  return hash(input);
}

/**
 * Validates that a receipt's evidence hash matches expected computation.
 * Returns false if hash doesn't match, indicating potential tampering or corruption.
 */
export function isReceiptEvidenceValid(
  receipt: Receipt,
  attempt: PaymentAttempt,
  settlement: Settlement
): boolean {
  const expectedHash = computeExpectedEvidenceHash(attempt, settlement);
  return receipt.evidenceHash === expectedHash;
}

/**
 * Determines the appropriate next action for a settlement.
 *
 * Returns:
 * - "finalize_receipt": Settlement is finalized, receipt can be created/finalized
 * - "wait_for_horizon": Settlement has transaction hash, awaiting Horizon confirmation
 * - "needs_review": Transaction failed or needs manual investigation
 */
export function getSettlementAction(
  settlement: Settlement
): "finalize_receipt" | "wait_for_horizon" | "needs_review" {
  if (settlement.reconciliationState === "needs_review") {
    return "needs_review";
  }

  if (
    settlement.reconciliationState === "reconciled" ||
    settlement.reconciliationState === "not_required"
  ) {
    return "finalize_receipt";
  }

  if (settlement.reconciliationState === "pending" && settlement.transactionHash !== null) {
    return "wait_for_horizon";
  }

  // Default: wait for Horizon
  return "wait_for_horizon";
}
