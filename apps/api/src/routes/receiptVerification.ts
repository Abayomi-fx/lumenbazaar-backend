/**
 * Receipt Verification Routes
 *
 * Provides read-only endpoints to verify receipts against persisted evidence.
 * No writes, no side effects, deterministic operation.
 *
 * Endpoints:
 *   GET /v1/receipts/:receiptId/verify
 *     - Verifies a specific receipt
 *     - Returns versioned digest and field-level consistency result
 *     - Public access (anyone can request verification)
 */

import { type FastifyInstance } from "fastify";
import { z } from "zod";
import { LumenError } from "@lumenbazaar/shared";
import { verifyReceiptEvidence } from "@lumenbazaar/stellar-payments";
import type { ReceiptService, PaymentAttemptStore, SettlementStore } from "@lumenbazaar/stellar-payments";
import { parseParams } from "../http/validation.js";

export type ReceiptVerificationRouteOptions = {
  receiptService: ReceiptService;
  attemptStore: PaymentAttemptStore;
  settlementStore: SettlementStore;
};

export function registerReceiptVerificationRoutes(
  app: FastifyInstance,
  options: ReceiptVerificationRouteOptions
) {
  /**
   * GET /v1/receipts/:receiptId/verify
   *
   * Verifies a receipt against its persisted evidence records.
   *
   * Response:
   * {
   *   "verified": boolean,
   *   "digest": {
   *     "value": "hex-encoded-sha256",
   *     "version": "1.0",
   *     "algorithm": "SHA-256"
   *   } | undefined,
   *   "receiptStatus": "pending" | "finalized",
   *   "settlementState": "pending" | "reconciled" | "not_required" | "needs_review" | undefined,
   *   "fields": [
   *     {
   *       "field": "fieldName",
   *       "status": "match" | "mismatch" | "missing",
   *       "reason": "human-readable reason"
   *     }
   *   ],
   *   "reason": "verificationReasonCode" | undefined,
   *   "reasonMessage": "human-readable message" | undefined
   * }
   *
   * Status codes:
   * - 200 OK: Verification completed (check 'verified' field for result)
   * - 404 Not Found: Receipt does not exist
   * - 500 Internal Server Error: Unexpected error during verification
   *
   * Notes:
   * - This endpoint is read-only and performs no writes
   * - The digest is reproducible and deterministic
   * - Third parties can verify the digest by applying the same canonical encoding
   * - The digest is an integrity aid and does NOT replace Stellar ledger verification
   */
  app.get("/v1/receipts/:receiptId/verify", async (request, reply) => {
    const params = parseParams(request, z.object({ receiptId: z.string().min(1) }));

    try {
      // Fetch receipt
      const receipt = await options.receiptService.getReceipt(params.receiptId);
      if (!receipt) {
        throw new LumenError("RESOURCE_NOT_FOUND", "Receipt was not found.");
      }

      // Fetch payment attempt
      const attempt = await options.attemptStore.getPaymentAttempt(receipt.paymentAttemptId);
      if (!attempt) {
        throw new LumenError(
          "INTERNAL_ERROR",
          "Receipt exists but linked payment attempt not found."
        );
      }

      // Fetch settlement
      const settlement = await options.settlementStore.getSettlementByAttempt(
        receipt.paymentAttemptId
      );

      // Verify
      const result = verifyReceiptEvidence(receipt, attempt, settlement);

      reply.header("x-correlation-id", receipt.correlationId);
      return result;
    } catch (error) {
      if (error instanceof LumenError && error.code === "RESOURCE_NOT_FOUND") {
        throw error;
      }

      // Re-throw as internal error if not already a LumenError
      if (!(error instanceof LumenError)) {
        throw new LumenError(
          "INTERNAL_ERROR",
          "An error occurred during receipt verification.",
          { cause: error }
        );
      }

      throw error;
    }
  });
}
