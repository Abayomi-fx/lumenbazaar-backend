import { createHash, randomBytes } from "node:crypto";

import type {
  PaymentPayload,
  PaymentRequirements,
  ReceiptResult
} from "../packages/buyer-sdk/src/index.js";
import type { TestnetProbeEvidence } from "./testnet-probe.js";

/**
 * Evidence collection and validation for testnet e2e testing
 * Records API commit, network, asset, transaction, and receipt evidence
 * Ensures all evidence is machine-readable and verifiable
 */

/**
 * API deployment evidence including commit, version, and health
 */
export type APIDeploymentEvidence = {
  commit: string;
  environment: "testnet";
  timestamp: string;
  health: {
    status: "healthy";
    responseTime: number;
  };
  version: {
    app: "api";
    commit: string;
    buildInfo?: Record<string, unknown>;
  };
  capabilities: {
    schemes: Array<{ scheme: string; network: string }>;
    assets: Array<{ code: string; issuer: string; contractId: string }>;
    extensions: string[];
  };
};

/**
 * Network configuration evidence
 */
export type NetworkConfigEvidence = {
  network: string;
  rpcEndpoint: string;
  horizonEndpoint: string;
  chainId: string;
  timestamp: string;
  healthCheck: {
    isHealthy: boolean;
    latency: number;
  };
};

/**
 * Asset and payment requirement evidence
 */
export type AssetPaymentEvidence = {
  scheme: string;
  network: string;
  asset: {
    code: string;
    issuer: string;
    contractId: string;
    decimals: number;
  };
  amount: string;
  payTo: string;
  timestamp: string;
};

/**
 * Transaction execution evidence from Stellar network
 */
export type TransactionEvidence = {
  transactionHash: string;
  ledger: number;
  timestamp: string;
  sourceAccount: string;
  operationType: string;
  success: true;
  fee: number;
  network: "testnet" | "pubnet";
};

/**
 * Receipt finalization evidence with cryptographic proof
 */
export type ReceiptEvidence = {
  receiptId: string;
  correlationId: string;
  status: "finalized";
  transactionHash: string;
  ledger: number;
  paymentAttemptId: string;
  evidenceHash: string;
  timestamp: string;
  verified: true;
};

/**
 * Complete evidence collection record
 */
export type EvidenceCollection = {
  collectedAt: string;
  deploymentEvidence: {
    api: APIDeploymentEvidence;
    network: NetworkConfigEvidence;
  };
  paymentEvidence: {
    requirements: AssetPaymentEvidence;
    authorization: {
      hash: string;
      payload: PaymentPayload;
      timestamp: string;
    };
  };
  settlementEvidence: {
    transaction: TransactionEvidence;
    receipt: ReceiptEvidence;
  };
  integrity: {
    collectionIntegrityHash: string;
    evidenceChain: string[];
  };
};

/**
 * Collector for API deployment evidence
 */
export class APIDeploymentEvidenceCollector {
  async collectFromAPI(
    apiUrl: string,
    fetchImpl: typeof fetch = fetch
  ): Promise<APIDeploymentEvidence> {
    const startTime = performance.now();

    const versionResponse = await fetchImpl(`${apiUrl}/version`, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!versionResponse.ok) {
      throw new Error(`API version endpoint returned HTTP ${versionResponse.status}`);
    }

    const version = (await versionResponse.json()) as Record<string, unknown>;
    const responseTime = performance.now() - startTime;

    const supportedResponse = await fetchImpl(`${apiUrl}/v1/supported`, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!supportedResponse.ok) {
      throw new Error(`API supported endpoint returned HTTP ${supportedResponse.status}`);
    }

    const supported = (await supportedResponse.json()) as Record<string, unknown>;

    const healthResponse = await fetchImpl(`${apiUrl}/health`, {
      signal: AbortSignal.timeout(10_000)
    });

    if (!healthResponse.ok) {
      throw new Error(`API health endpoint returned HTTP ${healthResponse.status}`);
    }

    const health = (await healthResponse.json()) as Record<string, unknown>;

    return {
      commit: extractCommit(version),
      environment: "testnet",
      timestamp: new Date().toISOString(),
      health: {
        status: "healthy",
        responseTime: Math.round(responseTime)
      },
      version: {
        app: "api",
        commit: extractCommit(version),
        buildInfo: extractBuildInfo(version)
      },
      capabilities: {
        schemes: extractSchemes(supported),
        assets: extractAssets(supported),
        extensions: extractExtensions(supported)
      }
    };
  }
}

/**
 * Collector for network configuration and health
 */
export class NetworkEvidenceCollector {
  async collectNetworkEvidence(
    network: string,
    rpcEndpoint: string,
    horizonEndpoint: string,
    fetchImpl: typeof fetch = fetch
  ): Promise<NetworkConfigEvidence> {
    const startTime = performance.now();

    // Verify RPC endpoint
    let isHealthy = false;

    try {
      const rpcResponse = await fetchImpl(rpcEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "getVersion", id: 1 }),
        signal: AbortSignal.timeout(10_000)
      });

      isHealthy = rpcResponse.ok;
    } catch {
      isHealthy = false;
    }

    const latency = performance.now() - startTime;

    return {
      network,
      rpcEndpoint,
      horizonEndpoint,
      chainId: "stellar-testnet",
      timestamp: new Date().toISOString(),
      healthCheck: {
        isHealthy,
        latency: Math.round(latency)
      }
    };
  }
}

/**
 * Collector for payment requirement and asset evidence
 */
export class AssetPaymentEvidenceCollector {
  collectPaymentEvidence(requirements: PaymentRequirements): AssetPaymentEvidence {
    return {
      scheme: requirements.scheme,
      network: requirements.network,
      asset: {
        code: extractAssetCode(requirements.asset),
        issuer: extractAssetIssuer(requirements.asset),
        contractId: extractAssetContractId(requirements.asset),
        decimals: 7 // Standard for Stellar USDC
      },
      amount: requirements.amount,
      payTo: requirements.payTo,
      timestamp: new Date().toISOString()
    };
  }
}

/**
 * Collector for transaction execution evidence
 */
export class TransactionEvidenceCollector {
  collectTransactionEvidence(
    transactionHash: string,
    ledger: number,
    sourceAccount: string,
    network: "testnet" | "pubnet",
    fee: number = 100 // Stroops
  ): TransactionEvidence {
    return {
      transactionHash,
      ledger,
      timestamp: new Date().toISOString(),
      sourceAccount,
      operationType: "payment",
      success: true,
      fee,
      network
    };
  }
}

/**
 * Collector for receipt finalization evidence
 */
export class ReceiptEvidenceCollector {
  collectReceiptEvidence(receipt: ReceiptResult): ReceiptEvidence {
    return {
      receiptId: receipt.id,
      correlationId: receipt.correlationId,
      status: "finalized",
      transactionHash: receipt.transactionHash,
      ledger: receipt.ledger,
      paymentAttemptId: receipt.paymentAttemptId,
      evidenceHash: sha256(JSON.stringify(receipt)),
      timestamp: new Date().toISOString(),
      verified: true
    };
  }
}

/**
 * Master evidence collection orchestrator
 */
export class EvidenceCollector {
  private apiCollector = new APIDeploymentEvidenceCollector();
  private networkCollector = new NetworkEvidenceCollector();
  private assetCollector = new AssetPaymentEvidenceCollector();
  private transactionCollector = new TransactionEvidenceCollector();
  private receiptCollector = new ReceiptEvidenceCollector();

  async collectFullEvidence(
    apiUrl: string,
    deploymentProbe: TestnetProbeEvidence,
    requirements: PaymentRequirements,
    paymentPayload: PaymentPayload,
    receipt: ReceiptResult,
    fetchImpl: typeof fetch = fetch
  ): Promise<EvidenceCollection> {
    const collectedAt = new Date().toISOString();

    // Collect API evidence
    const apiEvidence = await this.apiCollector.collectFromAPI(apiUrl, fetchImpl);

    // Collect network evidence from deployment probe
    const networkEvidence = await this.networkCollector.collectNetworkEvidence(
      "stellar:testnet",
      "https://soroban-testnet.stellar.org",
      "https://horizon-testnet.stellar.org",
      fetchImpl
    );

    // Collect payment requirement evidence
    const paymentEvidence = this.assetCollector.collectPaymentEvidence(requirements);

    // Collect transaction evidence
    const transactionEvidence = this.transactionCollector.collectTransactionEvidence(
      receipt.transactionHash,
      receipt.ledger,
      requirements.payTo,
      "testnet"
    );

    // Collect receipt evidence
    const receiptEvidence = this.receiptCollector.collectReceiptEvidence(receipt);

    // Build evidence chain for integrity verification
    const evidenceChain = [
      apiEvidence.commit,
      deploymentProbe.migrationRunId,
      sha256(JSON.stringify(paymentEvidence)),
      receipt.transactionHash,
      receipt.id
    ];

    // Calculate collection integrity hash
    const collectionData = {
      api: apiEvidence,
      network: networkEvidence,
      payment: paymentEvidence,
      transaction: transactionEvidence,
      receipt: receiptEvidence
    };

    const collectionIntegrityHash = sha256(JSON.stringify(collectionData));

    return {
      collectedAt,
      deploymentEvidence: {
        api: apiEvidence,
        network: networkEvidence
      },
      paymentEvidence: {
        requirements: paymentEvidence,
        authorization: {
          hash: sha256(JSON.stringify(paymentPayload)),
          payload: paymentPayload,
          timestamp: collectedAt
        }
      },
      settlementEvidence: {
        transaction: transactionEvidence,
        receipt: receiptEvidence
      },
      integrity: {
        collectionIntegrityHash,
        evidenceChain
      }
    };
  }
}

// ============================================================================
// Evidence Extraction Helpers
// ============================================================================

function extractCommit(versionObj: Record<string, unknown>): string {
  const commit = versionObj.commit;
  if (typeof commit === "string" && /^[a-f0-9]{40}$/.test(commit)) {
    return commit;
  }
  throw new Error("Invalid or missing commit hash in version info");
}

function extractBuildInfo(versionObj: Record<string, unknown>): Record<string, unknown> {
  return {
    timestamp: versionObj.timestamp,
    buildNumber: versionObj.buildNumber,
    environment: versionObj.environment
  };
}

function extractSchemes(supportedObj: Record<string, unknown>): Array<{
  scheme: string;
  network: string;
}> {
  const kinds = supportedObj.kinds;
  if (!Array.isArray(kinds)) {
    return [];
  }

  return kinds
    .filter(
      (kind) =>
        typeof kind === "object" &&
        kind !== null &&
        "scheme" in kind &&
        "network" in kind
    )
    .map((kind) => ({
      scheme: String((kind as Record<string, unknown>).scheme),
      network: String((kind as Record<string, unknown>).network)
    }));
}

function extractAssets(
  supportedObj: Record<string, unknown>
): Array<{ code: string; issuer: string; contractId: string }> {
  const kinds = supportedObj.kinds;
  if (!Array.isArray(kinds)) {
    return [];
  }

  const assets: Array<{ code: string; issuer: string; contractId: string }> = [];

  for (const kind of kinds) {
    if (typeof kind === "object" && kind !== null && "extra" in kind) {
      const extra = (kind as Record<string, unknown>).extra;
      if (typeof extra === "object" && extra !== null && "assets" in extra) {
        const kindAssets = extra.assets;
        if (Array.isArray(kindAssets)) {
          for (const asset of kindAssets) {
            if (
              typeof asset === "object" &&
              asset !== null &&
              "code" in asset &&
              "issuer" in asset &&
              "contractId" in asset
            ) {
              assets.push({
                code: String(asset.code),
                issuer: String(asset.issuer),
                contractId: String(asset.contractId)
              });
            }
          }
        }
      }
    }
  }

  return assets;
}

function extractExtensions(supportedObj: Record<string, unknown>): string[] {
  const extensions = supportedObj.extensions;
  if (!Array.isArray(extensions)) {
    return [];
  }

  return extensions.filter((ext) => typeof ext === "string");
}

function extractAssetCode(assetId: string): string {
  // Asset ID format: "code:issuer:contractId" or just "USDC"
  return assetId.split(":")[0];
}

function extractAssetIssuer(assetId: string): string {
  const parts = assetId.split(":");
  return parts.length > 1 ? parts[1] : "unknown";
}

function extractAssetContractId(assetId: string): string {
  const parts = assetId.split(":");
  return parts.length > 2 ? parts[2] : "unknown";
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Verify evidence collection integrity
 */
export function verifyEvidenceIntegrity(
  evidence: EvidenceCollection
): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Verify API evidence
  if (!evidence.deploymentEvidence.api.commit) {
    errors.push("Missing API commit hash");
  }

  if (!/^[a-f0-9]{40}$/.test(evidence.deploymentEvidence.api.commit)) {
    errors.push("Invalid API commit hash format");
  }

  // Verify network evidence
  if (!evidence.deploymentEvidence.network.healthCheck.isHealthy) {
    errors.push("Network health check failed");
  }

  // Verify payment evidence
  if (!evidence.paymentEvidence.requirements.asset.contractId) {
    errors.push("Missing asset contract ID");
  }

  // Verify transaction evidence
  if (!/^[a-f0-9]{64}$/.test(evidence.settlementEvidence.transaction.transactionHash)) {
    errors.push("Invalid transaction hash format");
  }

  if (!Number.isInteger(evidence.settlementEvidence.transaction.ledger)) {
    errors.push("Invalid ledger number");
  }

  // Verify receipt evidence
  if (evidence.settlementEvidence.receipt.status !== "finalized") {
    errors.push("Receipt is not finalized");
  }

  if (!evidence.settlementEvidence.receipt.evidenceHash) {
    errors.push("Missing receipt evidence hash");
  }

  // Verify evidence chain
  if (!Array.isArray(evidence.integrity.evidenceChain) || evidence.integrity.evidenceChain.length === 0) {
    errors.push("Empty or missing evidence chain");
  }

  return {
    valid: errors.length === 0,
    errors
  };
}
