import { type AppConfig, type ErrorCode } from "@lumenbazaar/shared";
import { type SettleResponse, type VerifyResponse } from "@x402/core/types";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";

import { type FacilitatorSignerProvider } from "./facilitatorSigner.js";
import {
  type ExactStellarPaymentPayload,
  type ExactStellarPaymentRequirements,
  type NormalizedVerifyPaymentRequest
} from "./paymentPayload.js";

export type X402VerificationInput = {
  paymentPayload: ExactStellarPaymentPayload;
  paymentRequirements: ExactStellarPaymentRequirements;
  normalizedRequest: NormalizedVerifyPaymentRequest;
};

export type X402VerificationResult = {
  valid: boolean;
  failureCode?: ErrorCode;
  failureReason?: string;
  officialContext?: Record<string, unknown>;
  adapter: "@x402/stellar";
};

export type X402SettlementResult = {
  transactionHash?: string;
  ledger?: number;
  status: "confirmed" | "failed" | "timed_out";
  failureCode?: ErrorCode;
  failureReason?: string;
  officialContext?: Record<string, unknown>;
  adapter: "@x402/stellar";
};

export type SettlementFinality =
  | { status: "confirmed"; ledger: number }
  | { status: "failed" }
  | { status: "pending" };

export type X402StellarAdapter = {
  verifyExact: (input: X402VerificationInput) => Promise<X402VerificationResult>;
  settleExact?: (input: X402VerificationInput) => Promise<X402SettlementResult>;
};

type OfficialExactVerifier = {
  verify: (
    paymentPayload: ExactStellarPaymentPayload,
    paymentRequirements: ExactStellarPaymentRequirements
  ) => Promise<VerifyResponse>;
  settle: (
    paymentPayload: ExactStellarPaymentPayload,
    paymentRequirements: ExactStellarPaymentRequirements
  ) => Promise<SettleResponse>;
};

export type X402StellarAdapterOptions = {
  config: AppConfig;
  signerProvider: FacilitatorSignerProvider;
  createVerifier?: (input: {
    network: ExactStellarPaymentRequirements["network"];
    rpcUrl: string;
    maxTransactionFeeStroops: number;
    inclusionFeeStroops: number;
  }) => Promise<OfficialExactVerifier>;
  resolveFinality?: (input: {
    network: ExactStellarPaymentRequirements["network"];
    rpcUrl: string;
    transactionHash: string;
  }) => Promise<SettlementFinality>;
};

export function createX402StellarAdapter(options?: X402StellarAdapterOptions): X402StellarAdapter {
  if (options !== undefined) {
    return createOfficialAdapter(options);
  }

  return {
    async verifyExact() {
      return rejectedVerification(
        "The exact Stellar facilitator adapter is not configured. Payment verification is unavailable.",
        "SETTLEMENT_FAILED"
      );
    }
  };
}

function createOfficialAdapter(options: X402StellarAdapterOptions): X402StellarAdapter {
  const createVerifier =
    options.createVerifier ??
    (async ({ rpcUrl, maxTransactionFeeStroops, inclusionFeeStroops }) => {
      const signer = await options.signerProvider.getSigner();
      return new ExactStellarScheme([signer], {
        rpcConfig: { url: rpcUrl },
        maxTransactionFeeStroops,
        inclusionFeeStroops
      });
    });
  const resolveFinality = options.resolveFinality ?? resolveRpcFinality;

  async function getVerifier(input: X402VerificationInput) {
    const network = options.config.networks[input.normalizedRequest.network];
    if (network === undefined) {
      return undefined;
    }
    return {
      network,
      verifier: await createVerifier({
        network: input.normalizedRequest.network,
        rpcUrl: network.rpcUrl,
        maxTransactionFeeStroops: options.config.settlement.maxTransactionFeeStroops,
        inclusionFeeStroops: options.config.settlement.inclusionFeeStroops
      })
    };
  }

  return {
    async verifyExact(input) {
      try {
        const resolved = await getVerifier(input);
        if (resolved === undefined) {
          return rejectedVerification("Payment network is not configured.", "UNSUPPORTED_NETWORK");
        }
        const response = await resolved.verifier.verify(
          input.paymentPayload,
          input.paymentRequirements
        );
        return mapOfficialVerification(response);
      } catch {
        return rejectedVerification(
          "Official Stellar verification is unavailable.",
          "SETTLEMENT_FAILED"
        );
      }
    },
    async settleExact(input) {
      try {
        const resolved = await getVerifier(input);
        if (resolved === undefined) {
          return rejectedSettlement("failed", "Payment network is not configured.", {
            stage: "simulation",
            errorReason: "invalid_network"
          });
        }
        const response = await resolved.verifier.settle(
          input.paymentPayload,
          input.paymentRequirements
        );
        return await mapOfficialSettlement(response, {
          network: input.normalizedRequest.network,
          rpcUrl: resolved.network.rpcUrl,
          resolveFinality
        });
      } catch {
        return rejectedSettlement("failed", "Official Stellar settlement is unavailable.", {
          stage: "submission",
          errorReason: "unexpected_settle_error"
        });
      }
    }
  };
}

async function mapOfficialSettlement(
  response: SettleResponse,
  context: {
    network: ExactStellarPaymentRequirements["network"];
    rpcUrl: string;
    resolveFinality: NonNullable<X402StellarAdapterOptions["resolveFinality"]>;
  }
): Promise<X402SettlementResult> {
  const transactionHash = response.transaction;
  if (
    response.success &&
    (response.network !== context.network || typeof response.payer !== "string")
  ) {
    return rejectedSettlement("failed", "Official settlement response was incompatible.", {
      stage: "submission",
      errorReason: "incompatible_settlement_response"
    });
  }
  if (transactionHash.length > 0) {
    try {
      const finality = await context.resolveFinality({
        network: context.network,
        rpcUrl: context.rpcUrl,
        transactionHash
      });
      if (finality.status === "confirmed") {
        return {
          adapter: "@x402/stellar",
          status: "confirmed",
          transactionHash,
          ledger: finality.ledger
        };
      }
      if (finality.status === "failed") {
        return rejectedSettlement(
          "failed",
          "Stellar transaction failed before finality.",
          { stage: "failed", errorReason: response.errorReason ?? "transaction_failed" },
          transactionHash
        );
      }
      return rejectedSettlement(
        "timed_out",
        "Stellar transaction finality timed out.",
        { stage: "timeout", errorReason: response.errorReason ?? "transaction_pending" },
        transactionHash
      );
    } catch {
      return rejectedSettlement(
        "timed_out",
        "Stellar transaction finality could not be confirmed.",
        { stage: "timeout", errorReason: "finality_unavailable" },
        transactionHash
      );
    }
  }

  if (response.success) {
    return rejectedSettlement("failed", "Official settlement response was incompatible.", {
      stage: "submission",
      errorReason: "missing_transaction_hash"
    });
  }

  const errorReason = response.errorReason ?? "settlement_failed";
  return rejectedSettlement("failed", settlementFailureMessage(errorReason), {
    stage: settlementFailureStage(errorReason),
    errorReason
  });
}

/**
 * Resolve transaction finality via RPC with retry logic.
 * Polls Stellar RPC endpoint until transaction status is confirmed, failed, or timeout.
 * Uses exponential backoff starting at 100ms, with maximum 20 attempts over ~30 seconds.
 */
async function resolveRpcFinality(input: {
  rpcUrl: string;
  transactionHash: string;
}): Promise<SettlementFinality> {
  const maxAttempts = 20;
  const baseDelayMs = 100;
  const maxDelayMs = 2000;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: { hash: input.transactionHash }
        }),
        signal: AbortSignal.timeout(5_000)
      });

      if (!response.ok) {
        if (attempt < maxAttempts - 1) {
          await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
          continue;
        }
        throw new Error("Stellar RPC finality request failed after max retries.");
      }

      const payload = (await response.json()) as {
        error?: unknown;
        result?: { status?: string; ledger?: number };
      };

      if (payload.error !== undefined || payload.result === undefined) {
        if (attempt < maxAttempts - 1) {
          await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
          continue;
        }
        throw new Error("Stellar RPC finality response was invalid.");
      }

      if (payload.result.status === "SUCCESS" && Number.isInteger(payload.result.ledger)) {
        return { status: "confirmed", ledger: payload.result.ledger as number };
      }

      if (payload.result.status === "FAILED") {
        return { status: "failed" };
      }

      // Pending - retry if attempts remain
      if (attempt < maxAttempts - 1) {
        await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
        continue;
      }

      // Max retries reached while still pending
      return { status: "pending" };
    } catch (error) {
      if (attempt < maxAttempts - 1) {
        await delay(Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs));
        continue;
      }
      throw error;
    }
  }

  // Should not reach here
  return { status: "pending" };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function settlementFailureStage(reason: string) {
  if (reason.includes("verification") || reason.includes("simulation") || reason.includes("fee")) {
    return "simulation";
  }
  if (reason.includes("submission") || reason.includes("signing") || reason.includes("signer")) {
    return "submission";
  }
  return "failed";
}

function settlementFailureMessage(reason: string) {
  const stage = settlementFailureStage(reason);
  if (stage === "simulation") {
    return "Fresh Stellar simulation rejected the settlement.";
  }
  if (stage === "submission") {
    return "Stellar transaction submission failed.";
  }
  return "Stellar settlement failed.";
}

function rejectedSettlement(
  status: "failed" | "timed_out",
  failureReason: string,
  officialContext: Record<string, unknown>,
  transactionHash?: string
): X402SettlementResult {
  return {
    adapter: "@x402/stellar",
    status,
    failureCode: "SETTLEMENT_FAILED",
    failureReason,
    officialContext,
    ...(transactionHash === undefined ? {} : { transactionHash })
  };
}

function mapOfficialVerification(response: VerifyResponse): X402VerificationResult {
  if (response.isValid === true && typeof response.payer === "string") {
    return { valid: true, adapter: "@x402/stellar" };
  }

  if (response.isValid !== false || typeof response.invalidReason !== "string") {
    return rejectedVerification(
      "Official Stellar verifier returned an incompatible response.",
      "SETTLEMENT_FAILED"
    );
  }

  const invalidReason = response.invalidReason;
  return rejectedVerification(failureMessage(invalidReason), failureCode(invalidReason), {
    invalidReason
  });
}

function failureCode(reason: string): ErrorCode {
  if (reason === "network_mismatch" || reason === "invalid_network") {
    return "UNSUPPORTED_NETWORK";
  }
  if (reason.includes("wrong_asset") || reason.includes("event_wrong_asset")) {
    return "ASSET_MISMATCH";
  }
  if (reason.includes("wrong_amount") || reason.includes("event_wrong_amount")) {
    return "AMOUNT_MISMATCH";
  }
  if (reason.includes("wrong_recipient") || reason.includes("event_wrong_to")) {
    return "RECIPIENT_MISMATCH";
  }
  if (reason.includes("expiration")) {
    return "AUTH_EXPIRED";
  }
  if (reason.includes("signature")) {
    return "INVALID_SIGNATURE";
  }
  if (reason === "unexpected_verify_error" || reason.includes("simulation_failed")) {
    return "SETTLEMENT_FAILED";
  }
  return "INVALID_PAYMENT_PAYLOAD";
}

function failureMessage(reason: string): string {
  const code = failureCode(reason);
  const messages: Record<ErrorCode, string> = {
    AMOUNT_MISMATCH: "Payment amount does not match the requirement.",
    ASSET_MISMATCH: "Payment asset does not match the requirement.",
    AUTH_EXPIRED: "Payment authorization expiry is invalid.",
    CATALOG_VALIDATION_FAILED: "Payment payload is invalid.",
    FORBIDDEN: "Payment payload is invalid.",
    INTERNAL_ERROR: "Payment payload is invalid.",
    INVALID_PAYMENT_PAYLOAD: "Official Stellar verification rejected the payment payload.",
    INVALID_SIGNATURE: "Payment authorization signature is invalid.",
    PAYMENT_REQUIRED: "Payment payload is invalid.",
    RATE_LIMITED: "Payment payload is invalid.",
    RECIPIENT_MISMATCH: "Payment recipient does not match the requirement.",
    REPLAY_DETECTED: "Payment payload is invalid.",
    RESOURCE_NOT_FOUND: "Payment payload is invalid.",
    ROUTE_TEMPLATE_INVALID: "Payment payload is invalid.",
    SELLER_DOMAIN_UNVERIFIED: "Payment payload is invalid.",
    SELLER_NOT_FOUND: "Payment payload is invalid.",
    SETTLEMENT_FAILED: "Official Stellar verification could not be completed.",
    TRUSTLINE_REQUIRED: "Payment payload is invalid.",
    UNAUTHORIZED: "Payment payload is invalid.",
    UNSUPPORTED_ASSET: "Payment payload is invalid.",
    UNSUPPORTED_NETWORK: "Payment network is not supported.",
    VALIDATION_FAILED: "Payment payload is invalid."
  };
  return messages[code];
}

function rejectedVerification(
  reason: string,
  failureCode: ErrorCode = "INVALID_SIGNATURE",
  officialContext?: Record<string, unknown>
): X402VerificationResult {
  return {
    valid: false,
    failureCode,
    failureReason: reason,
    ...(officialContext === undefined ? {} : { officialContext }),
    adapter: "@x402/stellar"
  };
}
