import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/client";

import {
  fetchReceipt,
  runPaidResourceFlow,
  serializePaymentPayload,
  settlePayment,
  type PaidResourceFlowResult,
  type PaymentPayload,
  type PaymentRequirements,
  type ReceiptResult,
  type SettlePaymentResult
} from "../packages/buyer-sdk/src/index.js";
import { decodePaymentRequiredV2 } from "../packages/stellar-payments/src/index.js";

import {
  probeTestnetDeployment,
  type TestnetEndpointManifest,
  type TestnetProbeEvidence
} from "./testnet-probe.js";

/**
 * Comprehensive e2e suite evidence record
 * Records API commit, network, asset, transaction, and receipt evidence
 * Demonstrates replay rejection after successful settlement
 */
export type TestnetE2ESuiteEvidence = {
  // Metadata
  checkedAt: string;
  environment: "testnet";
  mode: "full" | "smoke";

  // Deployment evidence
  deployment: TestnetProbeEvidence;

  // First payment flow (successful)
  firstFlow: {
    authorizationHash: string;
    challengeProof: {
      scheme: string;
      network: string;
      asset: string;
      amount: string;
      payTo: string;
    };
    paidResponse: {
      bodyHash: string;
      statusCode: number;
    };
    receipt: ReceiptResult;
    settlement: {
      correlationId: string;
      ledger: number;
      receiptId: string;
      transactionHash: string;
    };
  };

  // Replay detection evidence
  replayRejection: {
    rejectedAt: string;
    replayAttemptPayload: {
      authorizationHash: string;
    };
    errorMessage: string;
    errorCode: string;
  };

  // Durable evidence verification
  durableVerification: {
    receiptPersisted: boolean;
    receiptHash: string;
    settlementIdempotent: boolean;
  };

  // Summary
  summary: {
    totalDuration: number;
    resourceRegistration: boolean;
    http402Response: boolean;
    verificationSuccess: boolean;
    settlementSuccess: boolean;
    receiptFinalized: boolean;
    replayBlocked: boolean;
  };
};

/**
 * Smoke mode evidence (read-only, no credentials required)
 */
export type TestnetE2ESmokeModeEvidence = {
  checkedAt: string;
  environment: "testnet";
  mode: "smoke";

  // Deployment health only
  deployment: TestnetProbeEvidence;

  summary: {
    totalDuration: number;
    deploymentHealthy: boolean;
    apiReachable: boolean;
    mcpHealthy: boolean;
    paidResourceAccessible: boolean;
  };
};

export type E2ESuiteDependencies = {
  fetchImpl?: typeof fetch;
  sign?: (requirements: PaymentRequirements, resource: { url: string }) => Promise<PaymentPayload>;
  runFlow?: (options: {
    apiUrl: string;
    paymentPayload: PaymentPayload;
    resourceId: string;
    resourceUrl: string;
  }) => Promise<PaidResourceFlowResult>;
  settle?: (
    apiUrl: string,
    input: {
      x402Version: 2;
      paymentPayload: PaymentPayload;
      paymentRequirements: PaymentRequirements;
    }
  ) => Promise<SettlePaymentResult>;
  receipt?: (apiUrl: string, receiptId: string) => Promise<ReceiptResult>;
};

/**
 * Run smoke mode (read-only) without credentials
 * Tests deployment health and accessibility only
 */
export async function runTestnetE2ESmoke(
  manifest: TestnetEndpointManifest,
  fetchImpl: typeof fetch = fetch
): Promise<TestnetE2ESmokeModeEvidence> {
  const startTime = performance.now();

  try {
    const deployment = await probeTestnetDeployment(manifest, fetchImpl);

    const duration = performance.now() - startTime;

    return {
      checkedAt: new Date().toISOString(),
      environment: "testnet",
      mode: "smoke",
      deployment,
      summary: {
        totalDuration: Math.round(duration),
        deploymentHealthy: true,
        apiReachable: deployment.supportedExactTestnet,
        mcpHealthy: true,
        paidResourceAccessible: deployment.officialV2Challenge
      }
    };
  } catch (error) {
    const duration = performance.now() - startTime;
    throw {
      error: String(error),
      duration: Math.round(duration),
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Run full e2e suite with credentials
 * Tests complete payment flow, replay rejection, and durable evidence
 */
export async function runTestnetE2ESuite(
  manifest: TestnetEndpointManifest,
  deployment: TestnetProbeEvidence,
  dependencies: E2ESuiteDependencies
): Promise<TestnetE2ESuiteEvidence> {
  const startTime = performance.now();
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  // Step 1: Get payment challenge
  const challengeResponse = await fetchImpl(manifest.paidResource.resourceUrl, {
    method: "GET",
    signal: AbortSignal.timeout(30_000)
  });

  if (challengeResponse.status !== 402) {
    throw new Error(`Paid resource returned HTTP ${challengeResponse.status} instead of 402.`);
  }

  const encodedChallenge = challengeResponse.headers.get("payment-required");
  if (encodedChallenge === null) throw new Error("Paid resource omitted PAYMENT-REQUIRED.");

  const challenge = decodePaymentRequiredV2(encodedChallenge);
  const requirements = challenge.accepts.find(
    (accept) => accept.scheme === "exact" && accept.network === "stellar:testnet"
  ) as PaymentRequirements | undefined;

  if (challenge.x402Version !== 2 || requirements === undefined) {
    throw new Error("Paid resource challenge is not official v2 Stellar exact.");
  }

  // Step 2: Create signed payment
  const sign = dependencies.sign;
  if (sign === undefined) {
    throw new Error("Sign function is required for full e2e suite.");
  }

  const paymentPayload = await sign(requirements, {
    url: manifest.paidResource.resourceUrl
  });

  assertSameRequirements(paymentPayload.accepted, requirements);

  const authorizationHash = sha256(serializePaymentPayload(paymentPayload));

  // Step 3: Run paid resource flow (call -> settle -> receipt)
  const runFlow = dependencies.runFlow ?? ((options) => runPaidResourceFlow(options));
  const flow = await runFlow({
    apiUrl: manifest.api.baseUrl,
    paymentPayload,
    resourceId: manifest.paidResource.resourceId,
    resourceUrl: manifest.paidResource.resourceUrl
  });

  if (!flow.call.success || flow.settlement === undefined || flow.receipt === undefined) {
    throw new Error("Exact payment flow did not return a paid response, settlement, and receipt.");
  }

  assertFinalReceipt(flow.receipt);

  const firstFlowReceipt = flow.receipt;
  const firstFlowSettlement = flow.settlement;

  // Step 4: Attempt replay - should be rejected
  const settle = dependencies.settle ?? settlePayment;
  const receipt = dependencies.receipt ?? fetchReceipt;

  let replayError: { message: string; code: string } | null = null;

  try {
    await settle(manifest.api.baseUrl, {
      x402Version: 2,
      paymentPayload,
      paymentRequirements: requirements
    });
  } catch (error) {
    replayError = {
      message: String(error),
      code: extractErrorCode(String(error))
    };
  }

  if (replayError === null) {
    throw new Error("Replay was not rejected - idempotency should prevent duplicates.");
  }

  // Step 5: Verify durable evidence - receipt should persist after replay rejection
  const persistedReceipt = await receipt(manifest.api.baseUrl, firstFlowReceipt.id);
  assertFinalReceipt(persistedReceipt);

  if (persistedReceipt.id !== firstFlowReceipt.id) {
    throw new Error("Receipt identity changed after replay attempt.");
  }

  const duration = performance.now() - startTime;

  return {
    checkedAt: new Date().toISOString(),
    environment: "testnet",
    mode: "full",
    deployment,
    firstFlow: {
      authorizationHash,
      challengeProof: {
        scheme: requirements.scheme,
        network: requirements.network,
        asset: requirements.asset,
        amount: requirements.amount,
        payTo: requirements.payTo
      },
      paidResponse: {
        bodyHash: sha256(JSON.stringify(flow.call.data ?? {})),
        statusCode: flow.call.statusCode ?? 200
      },
      receipt: persistedReceipt,
      settlement: {
        correlationId: firstFlowSettlement.extra.lumenbazaar.correlationId,
        ledger: firstFlowSettlement.extra.lumenbazaar.ledger,
        receiptId: firstFlowSettlement.extra.lumenbazaar.receiptId,
        transactionHash: firstFlowSettlement.transaction
      }
    },
    replayRejection: {
      rejectedAt: new Date().toISOString(),
      replayAttemptPayload: {
        authorizationHash
      },
      errorMessage: replayError.message,
      errorCode: replayError.code
    },
    durableVerification: {
      receiptPersisted: persistedReceipt.id === firstFlowReceipt.id,
      receiptHash: sha256(JSON.stringify(persistedReceipt)),
      settlementIdempotent: persistedReceipt.transactionHash === firstFlowReceipt.transactionHash
    },
    summary: {
      totalDuration: Math.round(duration),
      resourceRegistration: manifest.paidResource.resourceId.length > 0,
      http402Response: true,
      verificationSuccess: firstFlowReceipt.status === "finalized",
      settlementSuccess: firstFlowSettlement.transaction.length > 0,
      receiptFinalized: persistedReceipt.status === "finalized",
      replayBlocked: replayError !== null
    }
  };
}

/**
 * Create official Stellar testnet signer
 */
export function createOfficialTestnetSigner(privateKey: string) {
  const scheme = new ExactStellarScheme(createEd25519Signer(privateKey, "stellar:testnet"));
  return async (requirements: PaymentRequirements, resource: { url: string }) => {
    const signed = await scheme.createPaymentPayload(2, requirements);
    return {
      x402Version: 2,
      resource,
      accepted: requirements,
      payload: signed.payload
    } as PaymentPayload;
  };
}

// ============================================================================
// Helpers
// ============================================================================

function assertSameRequirements(actual: PaymentRequirements, expected: PaymentRequirements) {
  for (const key of ["scheme", "network", "asset", "amount", "payTo"] as const) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Signed payload changed challenge field ${key}.`);
    }
  }
}

function assertFinalReceipt(receipt: ReceiptResult) {
  if (
    receipt.status !== "finalized" ||
    receipt.id.length === 0 ||
    receipt.transactionHash.length === 0 ||
    !Number.isInteger(receipt.ledger)
  ) {
    throw new Error("Receipt is not finalized with transaction and ledger evidence.");
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function extractErrorCode(errorMessage: string) {
  const match = errorMessage.match(/\b([A-Z_]+)\b/);
  return match ? match[1] : "UNKNOWN_ERROR";
}

// ============================================================================
// CLI Entry Point
// ============================================================================

async function main() {
  const mode = argument("--mode") as "full" | "smoke" | undefined;
  const manifestPath = argument("--manifest") ?? "docs/deployment/testnet-endpoints.json";
  const outputPath = argument("--output");

  const manifest = JSON.parse(
    await readFile(resolve(manifestPath), "utf8")
  ) as TestnetEndpointManifest;

  if (mode === "smoke" || !process.env.CLIENT_PRIVATE_KEY) {
    // Run smoke mode (read-only, no secrets required)
    const evidence = await runTestnetE2ESmoke(manifest);
    if (outputPath !== undefined) {
      const target = resolve(outputPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(evidence, null, 2));
  } else {
    // Run full e2e suite (requires credentials)
    const privateKey = process.env.CLIENT_PRIVATE_KEY;
    if (privateKey === undefined || privateKey.length === 0) {
      throw new Error(
        "CLIENT_PRIVATE_KEY is required for full e2e suite and must be supplied through secret storage."
      );
    }

    const deployment = await probeTestnetDeployment(manifest);
    const evidence = await runTestnetE2ESuite(manifest, deployment, {
      sign: createOfficialTestnetSigner(privateKey)
    });

    if (outputPath !== undefined) {
      const target = resolve(outputPath);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
    }
    console.log(JSON.stringify(evidence, null, 2));
  }
}

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

const entrypoint = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;
if (entrypoint === import.meta.url) {
  await main();
}
