import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TestnetEndpointManifest, TestnetProbeEvidence } from "./testnet-probe.js";
import type {
  TestnetE2ESuiteEvidence,
  TestnetE2ESmokeModeEvidence,
  E2ESuiteDependencies
} from "./testnet-e2e-suite.js";
import {
  runTestnetE2ESmoke,
  runTestnetE2ESuite,
  createOfficialTestnetSigner
} from "./testnet-e2e-suite.js";
import type { PaymentRequirements, PaymentPayload, ReceiptResult } from "../packages/buyer-sdk/src/index.js";

/**
 * Integration tests for testnet e2e suite
 * Tests smoke mode, full e2e flow, and replay rejection
 */

const mockManifest: TestnetEndpointManifest = {
  environment: "testnet",
  status: "deployed",
  commits: {
    api: "a".repeat(40),
    worker: "b".repeat(40),
    mcp: "c".repeat(40),
    paidResource: "d".repeat(40)
  },
  migrationRunId: "mig_123456",
  api: {
    baseUrl: "https://api.testnet.example.com",
    health: "https://api.testnet.example.com/health",
    metrics: "https://api.testnet.example.com/metrics",
    readiness: "https://api.testnet.example.com/ready",
    supported: "https://api.testnet.example.com/v1/supported",
    version: "https://api.testnet.example.com/version"
  },
  mcp: {
    health: "https://mcp.testnet.example.com/health",
    metrics: "https://mcp.testnet.example.com/metrics",
    readiness: "https://mcp.testnet.example.com/ready",
    schema: "https://mcp.testnet.example.com/schema",
    version: "https://mcp.testnet.example.com/version"
  },
  paidResource: {
    baseUrl: "https://weather.testnet.example.com",
    health: "https://weather.testnet.example.com/health",
    metrics: "https://weather.testnet.example.com/metrics",
    readiness: "https://weather.testnet.example.com/ready",
    resourceId: "res_weather_123",
    resourceUrl: "https://weather.testnet.example.com/weather",
    version: "https://weather.testnet.example.com/version"
  }
};

const mockProbeEvidence: TestnetProbeEvidence = {
  checkedAt: new Date().toISOString(),
  commits: mockManifest.commits,
  migrationRunId: mockManifest.migrationRunId,
  officialV2Challenge: true,
  supportedExactTestnet: true
};

const mockRequirements: PaymentRequirements = {
  scheme: "exact",
  network: "stellar:testnet",
  asset: "USDC:GDZST3XVCDTUJ76ZAV2HA72KYRTYKYI6YLJVMQ5DNPMJR7BKQW5EBXM:CAQAAE5BBKEWBLZX2Q5QIWZDWLKR3SXI5YLNPVIVJ2YVJKPLGOMF6LTHL",
  amount: "1.0000000",
  payTo: "GDZST3XVCDTUJ76ZAV2HA72KYRTYKYI6YLJVMQ5DNPMJR7BKQW5EBXM"
};

const mockPaymentPayload: PaymentPayload = {
  x402Version: 2,
  resource: { url: mockManifest.paidResource.resourceUrl },
  accepted: mockRequirements,
  payload: "mock_signed_payload_data"
};

const mockReceipt: ReceiptResult = {
  id: "receipt_123456",
  correlationId: "corr_123456",
  paymentAttemptId: "attempt_123456",
  status: "finalized",
  transactionHash: "e".repeat(64),
  ledger: 123456,
  timestamp: new Date().toISOString(),
  network: "stellar:testnet",
  amount: "1.0000000",
  assetCode: "USDC",
  assetIssuer: "GDZST3XVCDTUJ76ZAV2HA72KYRTYKYI6YLJVMQ5DNPMJR7BKQW5EBXM"
};

describe("Testnet E2E Suite - Smoke Mode", () => {
  it("should run smoke mode successfully without credentials", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: true, app: "api" }), { status: 200 });
      }
      if (url.includes("/ready")) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/version")) {
        return new Response(
          JSON.stringify({ commit: "a".repeat(40), app: "api" }),
          { status: 200 }
        );
      }
      if (url.includes("/metrics")) {
        return new Response("lumenbazaar_api_uptime_seconds 100", { status: 200 });
      }
      if (url.includes("/v1/supported")) {
        return new Response(
          JSON.stringify({
            kinds: [
              {
                scheme: "exact",
                network: "stellar:testnet",
                extra: { assets: [] }
              }
            ],
            extensions: ["bazaar"]
          }),
          { status: 200 }
        );
      }
      if (url.includes("/payment-required")) {
        return new Response(null, {
          status: 402,
          headers: { "payment-required": "x402-v2 exact stellar:testnet" }
        });
      }
      return new Response(null, { status: 404 });
    });

    const evidence = await runTestnetE2ESmoke(mockManifest, mockFetch);

    expect(evidence).toBeDefined();
    expect(evidence.mode).toBe("smoke");
    expect(evidence.environment).toBe("testnet");
    expect(evidence.summary.deploymentHealthy).toBe(true);
    expect(evidence.summary.totalDuration).toBeGreaterThan(0);
  });

  it("should handle network errors gracefully in smoke mode", async () => {
    const mockFetch = vi.fn(async () => {
      throw new Error("Network error");
    });

    await expect(runTestnetE2ESmoke(mockManifest, mockFetch)).rejects.toThrow();
  });

  it("should detect unhealthy deployment", async () => {
    const mockFetch = vi.fn(async (url: string) => {
      if (url.includes("/health")) {
        return new Response(JSON.stringify({ ok: false }), { status: 200 });
      }
      return new Response(null, { status: 500 });
    });

    await expect(runTestnetE2ESmoke(mockManifest, mockFetch)).rejects.toThrow();
  });
});

describe("Testnet E2E Suite - Full Mode", () => {
  it("should complete full e2e flow with payment and settlement", async () => {
    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: {
          success: true,
          statusCode: 200,
          data: { weather: "sunny" }
        },
        settlement: {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        },
        receipt: mockReceipt
      }),
      settle: async () => ({
        transaction: "e".repeat(64),
        extra: {
          lumenbazaar: {
            correlationId: "corr_123456",
            ledger: 123456,
            receiptId: "receipt_123456"
          }
        }
      }),
      receipt: async () => mockReceipt
    };

    const evidence = await runTestnetE2ESuite(
      mockManifest,
      mockProbeEvidence,
      mockDependencies
    );

    expect(evidence).toBeDefined();
    expect(evidence.mode).toBe("full");
    expect(evidence.firstFlow).toBeDefined();
    expect(evidence.replayRejection).toBeDefined();
    expect(evidence.summary.replayBlocked).toBe(true);
    expect(evidence.summary.settlementSuccess).toBe(true);
  });

  it("should verify replay rejection", async () => {
    let settleCallCount = 0;
    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: { success: true, statusCode: 200, data: {} },
        settlement: {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        },
        receipt: mockReceipt
      }),
      settle: async () => {
        settleCallCount++;
        if (settleCallCount > 1) {
          throw new Error("REPLAY_DETECTED: Payment already settled");
        }
        return {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        };
      },
      receipt: async () => mockReceipt
    };

    const evidence = await runTestnetE2ESuite(
      mockManifest,
      mockProbeEvidence,
      mockDependencies
    );

    expect(evidence.replayRejection.errorCode).toContain("REPLAY");
    expect(evidence.summary.replayBlocked).toBe(true);
  });

  it("should verify durable evidence persistence", async () => {
    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: { success: true, statusCode: 200, data: {} },
        settlement: {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        },
        receipt: mockReceipt
      }),
      settle: async () => {
        throw new Error("REPLAY_DETECTED");
      },
      receipt: async () => mockReceipt
    };

    const evidence = await runTestnetE2ESuite(
      mockManifest,
      mockProbeEvidence,
      mockDependencies
    );

    expect(evidence.durableVerification.receiptPersisted).toBe(true);
    expect(evidence.durableVerification.settlementIdempotent).toBe(true);
    expect(evidence.firstFlow.receipt.id).toBe(mockReceipt.id);
  });

  it("should fail if payment flow incomplete", async () => {
    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: { success: false, statusCode: 402 },
        settlement: undefined,
        receipt: undefined
      }),
      settle: async () => ({}),
      receipt: async () => mockReceipt
    };

    await expect(
      runTestnetE2ESuite(mockManifest, mockProbeEvidence, mockDependencies)
    ).rejects.toThrow();
  });

  it("should fail if receipt not finalized", async () => {
    const unfinalized: ReceiptResult = {
      ...mockReceipt,
      status: "pending",
      transactionHash: ""
    };

    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: { success: true, statusCode: 200, data: {} },
        settlement: {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        },
        receipt: unfinalized
      }),
      settle: async () => ({}),
      receipt: async () => unfinalized
    };

    await expect(
      runTestnetE2ESuite(mockManifest, mockProbeEvidence, mockDependencies)
    ).rejects.toThrow();
  });
});

describe("Testnet E2E Suite - Evidence Validation", () => {
  it("should include all required evidence fields", async () => {
    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: { success: true, statusCode: 200, data: { result: "data" } },
        settlement: {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        },
        receipt: mockReceipt
      }),
      settle: async () => {
        throw new Error("REPLAY_DETECTED");
      },
      receipt: async () => mockReceipt
    };

    const evidence = await runTestnetE2ESuite(
      mockManifest,
      mockProbeEvidence,
      mockDependencies
    );

    // Check deployment evidence
    expect(evidence.deployment).toBeDefined();
    expect(evidence.deployment.commits).toBeDefined();

    // Check first flow evidence
    expect(evidence.firstFlow.authorizationHash).toBeDefined();
    expect(evidence.firstFlow.authorizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.firstFlow.challengeProof).toBeDefined();
    expect(evidence.firstFlow.paidResponse).toBeDefined();
    expect(evidence.firstFlow.settlement).toBeDefined();
    expect(evidence.firstFlow.receipt).toBeDefined();

    // Check replay evidence
    expect(evidence.replayRejection.rejectedAt).toBeDefined();
    expect(evidence.replayRejection.errorMessage).toBeDefined();
    expect(evidence.replayRejection.errorCode).toBeDefined();

    // Check durable verification
    expect(evidence.durableVerification.receiptPersisted).toBe(true);
    expect(evidence.durableVerification.receiptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.durableVerification.settlementIdempotent).toBe(true);

    // Check summary
    expect(evidence.summary.totalDuration).toBeGreaterThan(0);
    expect(evidence.summary.resourceRegistration).toBe(true);
    expect(evidence.summary.http402Response).toBe(true);
    expect(evidence.summary.verificationSuccess).toBe(true);
    expect(evidence.summary.settlementSuccess).toBe(true);
    expect(evidence.summary.receiptFinalized).toBe(true);
    expect(evidence.summary.replayBlocked).toBe(true);
  });

  it("should hash authorization payload correctly", async () => {
    const mockDependencies: E2ESuiteDependencies = {
      sign: async () => mockPaymentPayload,
      runFlow: async () => ({
        call: { success: true, statusCode: 200, data: {} },
        settlement: {
          transaction: "e".repeat(64),
          extra: {
            lumenbazaar: {
              correlationId: "corr_123456",
              ledger: 123456,
              receiptId: "receipt_123456"
            }
          }
        },
        receipt: mockReceipt
      }),
      settle: async () => {
        throw new Error("REPLAY_DETECTED");
      },
      receipt: async () => mockReceipt
    };

    const evidence = await runTestnetE2ESuite(
      mockManifest,
      mockProbeEvidence,
      mockDependencies
    );

    expect(evidence.firstFlow.authorizationHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.replayRejection.replayAttemptPayload.authorizationHash).toBe(
      evidence.firstFlow.authorizationHash
    );
  });
});
