import { describe, expect, it, vi } from "vitest";

import { loadConfig, type LumenError } from "@lumenbazaar/shared";
import {
  testAssetContractId,
  testPaymentPayload,
  testPaymentRequest,
  testPaymentRequirement
} from "@lumenbazaar/testkit";
import {
  BASE_FEE,
  Keypair,
  Networks,
  TransactionBuilder,
  nativeToScVal,
  type Transaction,
  xdr
} from "@stellar/stellar-sdk";
import type * as StellarSdkModule from "@stellar/stellar-sdk";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";

import { PaymentVerificationService, type X402StellarAdapter } from "./index.js";

const acceptingAdapter: X402StellarAdapter = {
  async verifyExact() {
    return {
      valid: true,
      adapter: "@x402/stellar"
    };
  }
};

const rejectingAdapter: X402StellarAdapter = {
  async verifyExact() {
    return {
      valid: false,
      failureCode: "INVALID_SIGNATURE",
      failureReason: "Signature rejected.",
      officialContext: { invalidReason: "invalid_exact_stellar_payload" },
      adapter: "@x402/stellar"
    };
  }
};

const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });

// Load the official SDK from @x402/stellar's node_modules to ensure XDR compatibility
const officialRequire = createRequire(import.meta.resolve("@x402/stellar/exact/facilitator"));
const officialSdkCjsEntry = officialRequire.resolve("@stellar/stellar-sdk");
const officialSdkEntry = resolve(
  dirname(dirname(dirname(officialSdkCjsEntry))),
  "lib/esm/index.js"
);
const officialStellarSdk = (await import(
  pathToFileURL(officialSdkEntry).href
)) as typeof StellarSdkModule;

describe("PaymentVerificationService", () => {
  it("accepts valid exact payments through the x402 Stellar adapter", async () => {
    const service = new PaymentVerificationService(config, { adapter: acceptingAdapter });

    await expect(service.verify(testPaymentRequest)).resolves.toMatchObject({
      network: "stellar:testnet",
      status: "verified",
      adapter: "@x402/stellar"
    });
  });

  it("returns the original attempt for an identical safe retry", async () => {
    const verifyExact = vi.fn(acceptingAdapter.verifyExact);
    const service = new PaymentVerificationService(config, {
      adapter: { verifyExact }
    });

    const first = await service.verify(testPaymentRequest);
    const retry = await service.verify(testPaymentRequest);

    expect(retry).toEqual(first);
    expect(verifyExact).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid payment details before settlement", async () => {
    const service = new PaymentVerificationService(config, { adapter: acceptingAdapter });
    const changedRequirement = { ...testPaymentRequirement, amount: "100000" };
    const invalid = {
      ...testPaymentRequest,
      paymentPayload: {
        ...testPaymentPayload,
        accepted: changedRequirement
      },
      paymentRequirements: testPaymentRequirement
    };

    await expect(service.verify(invalid)).rejects.toMatchObject({
      code: "INVALID_PAYMENT_PAYLOAD"
    });
  });

  it("maps x402 Stellar verification rejection to a stable code", async () => {
    const service = new PaymentVerificationService(config, { adapter: rejectingAdapter });

    await expect(service.verify(testPaymentRequest)).rejects.toMatchObject({
      code: "INVALID_SIGNATURE",
      message: "Signature rejected.",
      details: {
        adapter: "@x402/stellar",
        invalidReason: "invalid_exact_stellar_payload"
      }
    } satisfies Partial<LumenError>);
  });

  describe("integration with real ExactStellarScheme", () => {
    it("accepts valid payment through real upstream verifier", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build and sign transaction using official SDK
      const transaction = new officialStellarSdk.TransactionBuilder(
        new officialStellarSdk.Account(payer.publicKey(), "0"),
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        }
      )
        .addOperation(
          officialStellarSdk.Operation.invokeContractFunction({
            contract: testAssetContractId,
            function: "transfer",
            args: [
              officialStellarSdk.nativeToScVal(payer.publicKey(), { type: "address" }),
              officialStellarSdk.nativeToScVal(recipient.publicKey(), { type: "address" }),
              officialStellarSdk.nativeToScVal(500000n, { type: "i128" })
            ]
          })
        )
        .setTimeout(60)
        .build();

      transaction.sign(officialStellarSdk.Keypair.fromSecret(payer.secret()));

      // Create signed authorization
      const authorization = await officialStellarSdk.authorizeInvocation({
        signer: officialStellarSdk.Keypair.fromSecret(payer.secret()),
        validUntilLedgerSeq: 102,
        networkPassphrase: Networks.TESTNET,
        invocation: new officialStellarSdk.xdr.SorobanAuthorizedInvocation({
          function:
            officialStellarSdk.xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
              (
                transaction.operations[0] as unknown as {
                  func: { invokeContract: () => xdr.InvokeContractArgs };
                }
              ).func.invokeContract()
            ),
          subInvocations: []
        }) as never
      });

      // Rebuild with authorization
      const authorizedTransaction = new officialStellarSdk.TransactionBuilder(
        new officialStellarSdk.Account(payer.publicKey(), "0"),
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        }
      )
        .addOperation(
          officialStellarSdk.Operation.invokeContractFunction({
            contract: testAssetContractId,
            function: "transfer",
            args: [
              officialStellarSdk.nativeToScVal(payer.publicKey(), { type: "address" }),
              officialStellarSdk.nativeToScVal(recipient.publicKey(), { type: "address" }),
              officialStellarSdk.nativeToScVal(500000n, { type: "i128" })
            ],
            auth: [authorization as never]
          })
        )
        .setTimeout(60)
        .build();

      authorizedTransaction.sign(officialStellarSdk.Keypair.fromSecret(payer.secret()));

      // Create payment request with real transaction
      const paymentRequest = {
        x402Version: 2 as const,
        paymentPayload: {
          x402Version: 2 as const,
          accepted: testPaymentRequirement,
          payload: {
            transaction: authorizedTransaction.toXDR()
          }
        },
        paymentRequirements: {
          ...testPaymentRequirement,
          payTo: recipient.publicKey()
        }
      };

      // Create adapter with real ExactStellarScheme
      const upstreamAdapter: X402StellarAdapter = {
        async verifyExact(input) {
          const scheme = new ExactStellarScheme([
            createEd25519Signer(facilitator.secret(), "stellar:testnet")
          ]);

          const response = await scheme.verify(
            input.paymentPayload,
            input.paymentRequirements
          );

          // Map response using adapter pattern
          if (response.isValid === true && typeof response.payer === "string") {
            return { valid: true, adapter: "@x402/stellar" };
          }

          if (response.isValid !== false || typeof response.invalidReason !== "string") {
            return {
              valid: false,
              failureCode: "SETTLEMENT_FAILED",
              failureReason: "Official Stellar verifier returned an incompatible response.",
              adapter: "@x402/stellar"
            };
          }

          return {
            valid: false,
            failureCode: "INVALID_SIGNATURE",
            failureReason: response.invalidReason,
            officialContext: { invalidReason: response.invalidReason },
            adapter: "@x402/stellar"
          };
        }
      };

      const service = new PaymentVerificationService(config, { adapter: upstreamAdapter });
      const result = await service.verify(paymentRequest);

      expect(result).toMatchObject({
        network: "stellar:testnet",
        status: "verified",
        adapter: "@x402/stellar"
      });
      expect(result.paymentAttemptId).toBeDefined();
    });

    it("rejects invalid payment through real upstream verifier", async () => {
      const payer = Keypair.random();
      const wrongRecipient = Keypair.random();
      const correctRecipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build transaction with wrong recipient
      const transaction = new officialStellarSdk.TransactionBuilder(
        new officialStellarSdk.Account(payer.publicKey(), "0"),
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        }
      )
        .addOperation(
          officialStellarSdk.Operation.invokeContractFunction({
            contract: testAssetContractId,
            function: "transfer",
            args: [
              officialStellarSdk.nativeToScVal(payer.publicKey(), { type: "address" }),
              officialStellarSdk.nativeToScVal(wrongRecipient.publicKey(), { type: "address" }),
              officialStellarSdk.nativeToScVal(500000n, { type: "i128" })
            ]
          })
        )
        .setTimeout(60)
        .build();

      transaction.sign(officialStellarSdk.Keypair.fromSecret(payer.secret()));

      // Create payment request with real transaction but wrong recipient
      const paymentRequest = {
        x402Version: 2 as const,
        paymentPayload: {
          x402Version: 2 as const,
          accepted: testPaymentRequirement,
          payload: {
            transaction: transaction.toXDR()
          }
        },
        paymentRequirements: {
          ...testPaymentRequirement,
          payTo: correctRecipient.publicKey()
        }
      };

      // Create adapter with real ExactStellarScheme
      const upstreamAdapter: X402StellarAdapter = {
        async verifyExact(input) {
          const scheme = new ExactStellarScheme([
            createEd25519Signer(facilitator.secret(), "stellar:testnet")
          ]);

          const response = await scheme.verify(
            input.paymentPayload,
            input.paymentRequirements
          );

          if (response.isValid === true && typeof response.payer === "string") {
            return { valid: true, adapter: "@x402/stellar" };
          }

          if (response.isValid !== false || typeof response.invalidReason !== "string") {
            return {
              valid: false,
              failureCode: "SETTLEMENT_FAILED",
              failureReason: "Official Stellar verifier returned an incompatible response.",
              adapter: "@x402/stellar"
            };
          }

          // Map invalidReason to proper error code
          const failureCode = response.invalidReason?.includes("recipient")
            ? "RECIPIENT_MISMATCH"
            : "INVALID_PAYMENT_PAYLOAD";

          return {
            valid: false,
            failureCode,
            failureReason: response.invalidReason,
            officialContext: { invalidReason: response.invalidReason },
            adapter: "@x402/stellar"
          };
        }
      };

      const service = new PaymentVerificationService(config, { adapter: upstreamAdapter });

      await expect(service.verify(paymentRequest)).rejects.toMatchObject({
        code: "RECIPIENT_MISMATCH"
      } as Partial<LumenError>);
    });

    it("transforms unexpected upstream errors to SETTLEMENT_FAILED", async () => {
      const failingAdapter: X402StellarAdapter = {
        async verifyExact() {
          return {
            valid: false,
            failureCode: "SETTLEMENT_FAILED",
            failureReason: "Upstream verifier encountered an error.",
            officialContext: { stage: "verification", errorReason: "upstream_error" },
            adapter: "@x402/stellar"
          };
        }
      };

      const service = new PaymentVerificationService(config, { adapter: failingAdapter });

      await expect(service.verify(testPaymentRequest)).rejects.toMatchObject({
        code: "SETTLEMENT_FAILED"
      } as Partial<LumenError>);
    });
  });
});
