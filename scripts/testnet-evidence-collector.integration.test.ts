import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  APIDeploymentEvidenceCollector,
  NetworkEvidenceCollector,
  AssetPaymentEvidenceCollector,
  TransactionEvidenceCollector,
  ReceiptEvidenceCollector,
  EvidenceCollector,
  verifyEvidenceIntegrity,
  type ReceiptEvidence
} from "./testnet-evidence-collector.js";
import type { PaymentRequirements, ReceiptResult } from "../packages/buyer-sdk/src/index.js";

/**
 * Integration tests for evidence collection
 */

describe("APIDeploymentEvidenceCollector", () => {
  it("should collect API deployment evidence", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/version")) {
        return new Response(
          JSON.stringify({
            commit: "a".repeat(40),
            app: "api",
            timestamp: new Date().toISOString()
          }),
          { status: 200 }
        );
      }
      if (url.includes("/v1/supported")) {
        return new Response(
          JSON.stringify({
            kinds: [
              {
                scheme: "exact",
                network: "stellar:testnet",
                extra: {
                  assets: [
                    {
                      code: "USDC",
                      issuer: "GDZST3...",
                      contractId: "CAQAAE5...",
                      decimals: 7
                    }
                  ]
                }
              }
            ],
            extensions: ["bazaar"]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true, app: "api" }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const collector = new APIDeploymentEvidenceCollector();
    const evidence = await collector.collectFromAPI("https://api.test.com", mockFetch);

    expect(evidence.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(evidence.environment).toBe("testnet");
    expect(evidence.health.status).toBe("healthy");
    expect(evidence.health.responseTime).toBeGreaterThan(0);
    expect(evidence.capabilities.schemes).toHaveLength(1);
    expect(evidence.capabilities.assets).toHaveLength(1);
    expect(evidence.capabilities.extensions).toContain("bazaar");
  });

  it("should handle invalid commit format", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(JSON.stringify({ commit: "invalid" }), { status: 200 });
    });

    const collector = new APIDeploymentEvidenceCollector();
    await expect(collector.collectFromAPI("https://api.test.com", mockFetch)).rejects.toThrow(
      "Invalid or missing commit hash"
    );
  });

  it("should handle API errors", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(null, { status: 500 });
    });

    const collector = new APIDeploymentEvidenceCollector();
    await expect(collector.collectFromAPI("https://api.test.com", mockFetch)).rejects.toThrow();
  });
});

describe("NetworkEvidenceCollector", () => {
  it("should collect network configuration evidence", async () => {
    const mockFetch = vi.fn(async (url: string, options: Record<string, unknown>) => {
      const isPost = (options as Record<string, unknown>).method === "POST";
      if (isPost) {
        return new Response(JSON.stringify({ jsonrpc: "2.0", result: { version: "1" } }), {
          status: 200
        });
      }
      return new Response(null, { status: 404 });
    });

    const collector = new NetworkEvidenceCollector();
    const evidence = await collector.collectNetworkEvidence(
      "stellar:testnet",
      "https://rpc.test.com",
      "https://horizon.test.com",
      mockFetch
    );

    expect(evidence.network).toBe("stellar:testnet");
    expect(evidence.rpcEndpoint).toBe("https://rpc.test.com");
    expect(evidence.horizonEndpoint).toBe("https://horizon.test.com");
    expect(evidence.chainId).toBe("stellar-testnet");
    expect(evidence.healthCheck.isHealthy).toBe(true);
    expect(evidence.healthCheck.latency).toBeGreaterThan(0);
  });

  it("should detect unhealthy network", async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(null, { status: 500 });
    });

    const collector = new NetworkEvidenceCollector();
    const evidence = await collector.collectNetworkEvidence(
      "stellar:testnet",
      "https://rpc.test.com",
      "https://horizon.test.com",
      mockFetch
    );

    expect(evidence.healthCheck.isHealthy).toBe(false);
  });
});

describe("AssetPaymentEvidenceCollector", () => {
  it("should collect payment requirement evidence", () => {
    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "USDC:GDZST3...:CAQAAE5...",
      amount: "1.0000000",
      payTo: "GBY..."
    };

    const collector = new AssetPaymentEvidenceCollector();
    const evidence = collector.collectPaymentEvidence(requirements);

    expect(evidence.scheme).toBe("exact");
    expect(evidence.network).toBe("stellar:testnet");
    expect(evidence.asset.code).toBe("USDC");
    expect(evidence.amount).toBe("1.0000000");
    expect(evidence.payTo).toBe("GBY...");
  });
});

describe("TransactionEvidenceCollector", () => {
  it("should collect transaction execution evidence", () => {
    const collector = new TransactionEvidenceCollector();
    const evidence = collector.collectTransactionEvidence(
      "e".repeat(64),
      123456,
      "GACCOUNT...",
      "testnet",
      100
    );

    expect(evidence.transactionHash).toMatch(/^e{64}$/);
    expect(evidence.ledger).toBe(123456);
    expect(evidence.sourceAccount).toBe("GACCOUNT...");
    expect(evidence.network).toBe("testnet");
    expect(evidence.fee).toBe(100);
    expect(evidence.operationType).toBe("payment");
    expect(evidence.success).toBe(true);
  });
});

describe("ReceiptEvidenceCollector", () => {
  it("should collect receipt finalization evidence", () => {
    const receipt: ReceiptResult = {
      id: "receipt_123",
      correlationId: "corr_456",
      paymentAttemptId: "attempt_789",
      status: "finalized",
      transactionHash: "e".repeat(64),
      ledger: 123456,
      timestamp: new Date().toISOString(),
      network: "stellar:testnet",
      amount: "1.0000000",
      assetCode: "USDC",
      assetIssuer: "GDZST3..."
    };

    const collector = new ReceiptEvidenceCollector();
    const evidence = collector.collectReceiptEvidence(receipt);

    expect(evidence.receiptId).toBe("receipt_123");
    expect(evidence.correlationId).toBe("corr_456");
    expect(evidence.status).toBe("finalized");
    expect(evidence.transactionHash).toMatch(/^e{64}$/);
    expect(evidence.ledger).toBe(123456);
    expect(evidence.verified).toBe(true);
    expect(evidence.evidenceHash).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe("EvidenceCollector - Master Orchestrator", () => {
  it("should collect full evidence chain", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/version")) {
        return new Response(
          JSON.stringify({ commit: "a".repeat(40), app: "api" }),
          { status: 200 }
        );
      }
      if (url.includes("/v1/supported")) {
        return new Response(
          JSON.stringify({
            kinds: [{ scheme: "exact", network: "stellar:testnet", extra: { assets: [] } }],
            extensions: []
          }),
          { status: 200 }
        );
      }
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true, app: "api" }), { status: 200 });
      }
      if (url.includes("POST")) {
        return new Response(JSON.stringify({ version: "1" }), { status: 200 });
      }
      return new Response(null, { status: 404 });
    });

    const requirements: PaymentRequirements = {
      scheme: "exact",
      network: "stellar:testnet",
      asset: "USDC:GDZST3...:CAQAAE5...",
      amount: "1.0000000",
      payTo: "GBY..."
    };

    const paymentPayload = {
      x402Version: 2,
      resource: { url: "https://example.com" },
      accepted: requirements,
      payload: "signed_data"
    };

    const receipt: ReceiptResult = {
      id: "receipt_123",
      correlationId: "corr_456",
      paymentAttemptId: "attempt_789",
      status: "finalized",
      transactionHash: "e".repeat(64),
      ledger: 123456,
      timestamp: new Date().toISOString(),
      network: "stellar:testnet",
      amount: "1.0000000",
      assetCode: "USDC",
      assetIssuer: "GDZST3..."
    };

    const probeEvidence = {
      checkedAt: new Date().toISOString(),
      commits: {
        api: "a".repeat(40),
        worker: "b".repeat(40),
        mcp: "c".repeat(40),
        paidResource: "d".repeat(40)
      },
      migrationRunId: "mig_123",
      officialV2Challenge: true,
      supportedExactTestnet: true
    };

    const collector = new EvidenceCollector();
    const evidence = await collector.collectFullEvidence(
      "https://api.test.com",
      probeEvidence,
      requirements,
      paymentPayload,
      receipt,
      mockFetch
    );

    expect(evidence.collectedAt).toBeDefined();
    expect(evidence.deploymentEvidence.api).toBeDefined();
    expect(evidence.deploymentEvidence.network).toBeDefined();
    expect(evidence.paymentEvidence.requirements).toBeDefined();
    expect(evidence.paymentEvidence.authorization).toBeDefined();
    expect(evidence.settlementEvidence.transaction).toBeDefined();
    expect(evidence.settlementEvidence.receipt).toBeDefined();
    expect(evidence.integrity.collectionIntegrityHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.integrity.evidenceChain).toHaveLength(5);
  });
});

describe("Evidence Integrity Verification", () => {
  it("should validate complete evidence", () => {
    const receipt: ReceiptResult = {
      id: "receipt_123",
      correlationId: "corr_456",
      paymentAttemptId: "attempt_789",
      status: "finalized",
      transactionHash: "e".repeat(64),
      ledger: 123456,
      timestamp: new Date().toISOString(),
      network: "stellar:testnet",
      amount: "1.0000000",
      assetCode: "USDC",
      assetIssuer: "GDZST3..."
    };

    const receiptEvidence: ReceiptEvidence = {
      receiptId: "receipt_123",
      correlationId: "corr_456",
      status: "finalized",
      transactionHash: "e".repeat(64),
      ledger: 123456,
      paymentAttemptId: "attempt_789",
      evidenceHash: "a".repeat(64),
      timestamp: new Date().toISOString(),
      verified: true
    };

    const evidence = {
      collectedAt: new Date().toISOString(),
      deploymentEvidence: {
        api: {
          commit: "a".repeat(40),
          environment: "testnet" as const,
          timestamp: new Date().toISOString(),
          health: { status: "healthy" as const, responseTime: 100 },
          version: {
            app: "api" as const,
            commit: "a".repeat(40)
          },
          capabilities: {
            schemes: [{ scheme: "exact", network: "stellar:testnet" }],
            assets: [{ code: "USDC", issuer: "GDZST3...", contractId: "CAQAAE5..." }],
            extensions: ["bazaar"]
          }
        },
        network: {
          network: "stellar:testnet",
          rpcEndpoint: "https://rpc.test.com",
          horizonEndpoint: "https://horizon.test.com",
          chainId: "stellar-testnet",
          timestamp: new Date().toISOString(),
          healthCheck: { isHealthy: true, latency: 50 }
        }
      },
      paymentEvidence: {
        requirements: {
          scheme: "exact",
          network: "stellar:testnet",
          asset: {
            code: "USDC",
            issuer: "GDZST3...",
            contractId: "CAQAAE5...",
            decimals: 7
          },
          amount: "1.0000000",
          payTo: "GBY...",
          timestamp: new Date().toISOString()
        },
        authorization: {
          hash: "b".repeat(64),
          payload: {
            x402Version: 2,
            resource: { url: "https://example.com" },
            accepted: {
              scheme: "exact",
              network: "stellar:testnet",
              asset: "USDC:GDZST3...:CAQAAE5...",
              amount: "1.0000000",
              payTo: "GBY..."
            },
            payload: "signed_data"
          },
          timestamp: new Date().toISOString()
        }
      },
      settlementEvidence: {
        transaction: {
          transactionHash: "e".repeat(64),
          ledger: 123456,
          timestamp: new Date().toISOString(),
          sourceAccount: "GACCOUNT...",
          operationType: "payment",
          success: true,
          fee: 100,
          network: "testnet" as const
        },
        receipt: receiptEvidence
      },
      integrity: {
        collectionIntegrityHash: "c".repeat(64),
        evidenceChain: [
          "a".repeat(40),
          "mig_123",
          "d".repeat(64),
          "e".repeat(64),
          "receipt_123"
        ]
      }
    };

    const result = verifyEvidenceIntegrity(evidence as any);

    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should detect missing commit hash", () => {
    const evidence = {
      collectedAt: new Date().toISOString(),
      deploymentEvidence: {
        api: {
          commit: "", // Invalid empty commit
          environment: "testnet" as const,
          health: { status: "healthy" as const, responseTime: 100 },
          version: { app: "api" as const, commit: "" },
          capabilities: { schemes: [], assets: [], extensions: [] }
        },
        network: {
          network: "stellar:testnet",
          rpcEndpoint: "https://rpc.test.com",
          horizonEndpoint: "https://horizon.test.com",
          chainId: "stellar-testnet",
          healthCheck: { isHealthy: true, latency: 50 }
        }
      },
      paymentEvidence: { requirements: {} as any, authorization: {} as any },
      settlementEvidence: { transaction: {} as any, receipt: {} as any },
      integrity: { collectionIntegrityHash: "valid", evidenceChain: [] }
    };

    const result = verifyEvidenceIntegrity(evidence as any);

    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("should detect invalid transaction hash format", () => {
    const evidence = {
      collectedAt: new Date().toISOString(),
      deploymentEvidence: {
        api: {
          commit: "a".repeat(40),
          health: { status: "healthy" as const, responseTime: 100 },
          capabilities: { schemes: [], assets: [], extensions: [] }
        },
        network: { healthCheck: { isHealthy: true, latency: 50 } }
      },
      paymentEvidence: { requirements: {} as any, authorization: {} as any },
      settlementEvidence: {
        transaction: {
          transactionHash: "invalid_hash", // Invalid format
          ledger: 123456
        },
        receipt: {
          status: "finalized",
          evidenceHash: "a".repeat(64)
        }
      },
      integrity: { collectionIntegrityHash: "valid", evidenceChain: ["a", "b", "c"] }
    };

    const result = verifyEvidenceIntegrity(evidence as any);

    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("transaction hash"))).toBe(true);
  });
});
