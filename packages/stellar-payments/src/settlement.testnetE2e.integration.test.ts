/**
 * End-to-end integration test for exact settlement on funded Stellar testnet.
 * Uses real Stellar RPC and Horizon to verify transaction finality.
 *
 * PREREQUISITES:
 * - Stellar testnet account with XLM funding
 * - Environment variables:
 *   - TESTNET_FACILITATOR_SECRET: Facilitator account secret key
 *   - TESTNET_BUYER_PUBLIC: Buyer account public key
 *   - TESTNET_USDC_ISSUER: USDC issuer account public key
 *
 * This test is marked as "integration" and requires network access.
 * Skip in CI if testnet is unavailable.
 */

import { describe, it, expect, beforeAll } from "vitest";
import * as StellarSdk from "@stellar/stellar-sdk";
import { type AppConfig } from "@lumenbazaar/shared";
import { SettlementService } from "./settlement.js";
import { createX402StellarAdapter } from "./x402Adapter.js";
import { EnvironmentFacilitatorSignerProvider } from "./facilitatorSigner.js";
import { InMemoryPaymentAttemptStore } from "./paymentAttemptStore.js";
import { InMemorySettlementStore } from "./settlementStore.js";
import { ReceiptService } from "./receipt.js";

describe.skipIf(!process.env.TESTNET_FACILITATOR_SECRET)(
  "Settlement - Testnet E2E Integration",
  () => {
    let config: AppConfig;
    let service: SettlementService;
    let testnet: {
      facilitatorPublic: string;
      buyerPublic: string;
      usdcIssuer: string;
    };

    beforeAll(async () => {
      const facilitatorSecret = process.env.TESTNET_FACILITATOR_SECRET!;
      const buyerPublic = process.env.TESTNET_BUYER_PUBLIC;
      const usdcIssuer = process.env.TESTNET_USDC_ISSUER;

      if (!buyerPublic || !usdcIssuer) {
        throw new Error(
          "Missing testnet environment variables: TESTNET_BUYER_PUBLIC, TESTNET_USDC_ISSUER"
        );
      }

      const facilitatorKeyPair = StellarSdk.Keypair.fromSecret(facilitatorSecret);
      testnet = {
        facilitatorPublic: facilitatorKeyPair.publicKey(),
        buyerPublic,
        usdcIssuer
      };

      config = {
        nodeEnv: "test",
        lumenEnv: "testnet",
        networks: {
          testnet: {
            rpcUrl: "http://stellar-testnet.stellar.org/soroban/rpc",
            horizonUrl: "https://horizon-testnet.stellar.org"
          }
        },
        settlement: {
          maxTransactionFeeStroops: 100_000,
          inclusionFeeStroops: 1000
        },
        redisUrl: "redis://localhost:6379"
      } as AppConfig;

      const signerProvider = new EnvironmentFacilitatorSignerProvider(
        "TESTNET_FACILITATOR_SECRET"
      );

      const adapter = createX402StellarAdapter({
        config,
        signerProvider
      });

      service = new SettlementService(config, {
        adapter,
        attemptStore: new InMemoryPaymentAttemptStore(),
        settlementStore: new InMemorySettlementStore(),
        receiptService: new ReceiptService()
      });
    });

    it(
      "should settle exact payment and confirm on Horizon",
      async () => {
        // This test requires:
        // 1. Both facilitator and buyer accounts funded on testnet
        // 2. USDC trustline set up on both accounts
        // 3. Buyer account has USDC balance > 100

        // Create a verified payment attempt
        const attemptStore = service["attemptStore"] as InMemoryPaymentAttemptStore;
        await attemptStore.createVerifiedAttempt({
          paymentHash:
            "testnet_e2e_settlement_abc123def456abc123def456abc123def456abc",
          network: "testnet",
          assetCode: "USDC",
          assetIssuer: testnet.usdcIssuer,
          amount: "100.0000000",
          payTo: testnet.facilitatorPublic,
          sellerId: "testnet_seller",
          resourceId: "testnet_resource"
        });

        // Build settlement request with real X402 payload
        // (This would typically come from the buyer's X402 library)
        const settlementRequest = {
          x402Version: 2,
          paymentPayload: {
            network: "testnet",
            payer: testnet.buyerPublic,
            // Note: Real payload would include valid signature from buyer
            payerSignature: "placeholder_signature_for_test"
          },
          paymentRequirements: {
            network: "testnet",
            payTo: testnet.facilitatorPublic,
            amount: "100.0000000",
            assetCode: "USDC",
            assetIssuer: testnet.usdcIssuer,
            expiration: Math.floor(Date.now() / 1000) + 3600
          }
        };

        // Submit settlement
        const result = await service.settle(settlementRequest);

        // Verify settlement result
        expect(result.status).toBe("confirmed");
        expect(result.transactionHash).toBeDefined();
        expect(result.transactionHash.length).toBeGreaterThan(0);
        expect(result.ledger).toBeGreaterThan(0);
        expect(result.amount).toBe("100.0000000");

        // Verify transaction exists on Horizon
        const server = new StellarSdk.Horizon.Server("https://horizon-testnet.stellar.org");
        const transaction = await server
          .transactions()
          .transaction(result.transactionHash)
          .call();

        expect(transaction.successful).toBe(true);
        expect(transaction.ledger_attr).toBe(result.ledger);
      },
      { timeout: 60000 }
    );

    it(
      "should handle concurrent settlement requests idempotently",
      async () => {
        const attemptStore = service["attemptStore"] as InMemoryPaymentAttemptStore;
        const paymentHash =
          "testnet_concurrent_settlement_xyz789uvw123xyz789uvw123xyz789uvw";

        await attemptStore.createVerifiedAttempt({
          paymentHash,
          network: "testnet",
          assetCode: "USDC",
          assetIssuer: testnet.usdcIssuer,
          amount: "50.0000000",
          payTo: testnet.facilitatorPublic,
          sellerId: "testnet_seller_concurrent",
          resourceId: "testnet_resource_concurrent"
        });

        const settlementRequest = {
          x402Version: 2,
          paymentPayload: {
            network: "testnet",
            payer: testnet.buyerPublic,
            payerSignature: "placeholder_signature_for_test"
          },
          paymentRequirements: {
            network: "testnet",
            payTo: testnet.facilitatorPublic,
            amount: "50.0000000",
            assetCode: "USDC",
            assetIssuer: testnet.usdcIssuer,
            expiration: Math.floor(Date.now() / 1000) + 3600
          }
        };

        // Submit two concurrent settlement requests
        const [result1, result2] = await Promise.all([
          service.settle(settlementRequest),
          service.settle(settlementRequest)
        ]);

        // Both should succeed and return same settlement
        expect(result1.status).toBe("confirmed");
        expect(result2.status).toBe("confirmed");
        expect(result1.transactionHash).toBe(result2.transactionHash);
        expect(result1.settlementId).toBe(result2.settlementId);
      },
      { timeout: 60000 }
    );
  }
);

// Standalone test data generation helper
export async function generateTestnetVector(): Promise<{
  facilitatorSecret: string;
  buyerPublic: string;
  usdcIssuer: string;
}> {
  // Create test keypairs
  const facilitatorKeypair = StellarSdk.Keypair.random();
  const buyerKeypair = StellarSdk.Keypair.random();
  const usdcIssuerKeypair = StellarSdk.Keypair.random();

  // Note: In production, these would be actual funded accounts.
  // For testing, use:
  // - https://laboratory.stellar.org to create accounts
  // - https://friendbot.stellar.org to fund them

  return {
    facilitatorSecret: facilitatorKeypair.secret(),
    buyerPublic: buyerKeypair.publicKey(),
    usdcIssuer: usdcIssuerKeypair.publicKey()
  };
}
