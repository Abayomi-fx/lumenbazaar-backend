import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";
import {
  testAssetContractId,
  testPaymentPayload,
  testPaymentRequirement,
  testPaymentRequest
} from "@lumenbazaar/testkit";
import {
  Account,
  BASE_FEE,
  Keypair,
  Networks,
  Operation,
  TransactionBuilder,
  nativeToScVal,
  type Transaction,
  xdr
} from "@stellar/stellar-sdk";
import type * as StellarSdkModule from "@stellar/stellar-sdk";
import { type PaymentPayload, type PaymentRequirements } from "@x402/core/types";
import { createEd25519Signer } from "@x402/stellar";
import { ExactStellarScheme } from "@x402/stellar/exact/facilitator";

import { type FacilitatorSignerProvider } from "./facilitatorSigner.js";
import { parseVerifyPaymentRequest } from "./paymentPayload.js";
import { createX402StellarAdapter, type X402VerificationInput } from "./x402Adapter.js";

const config = loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: testAssetContractId });
const normalizedRequest = parseVerifyPaymentRequest(testPaymentRequest, config);
const verificationInput: X402VerificationInput = {
  paymentPayload: testPaymentPayload,
  paymentRequirements: testPaymentRequirement,
  normalizedRequest
};
const signerProvider = {
  assertReady: vi.fn(),
  getSigner: vi.fn(),
  getStatus: vi.fn()
} as FacilitatorSignerProvider;

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

describe("default x402 Stellar adapter", () => {
  it("fails closed while no facilitator implementation is configured", async () => {
    const adapter = createX402StellarAdapter();

    await expect(
      adapter.verifyExact({} as Parameters<typeof adapter.verifyExact>[0])
    ).resolves.toMatchObject({
      adapter: "@x402/stellar",
      failureCode: "SETTLEMENT_FAILED",
      valid: false
    });
    expect(adapter.settleExact).toBeUndefined();
  });
});

describe("official x402 Stellar adapter", () => {
  it("passes the configured network RPC and accepts only an official valid result", async () => {
    const verify = vi.fn().mockResolvedValue({ isValid: true, payer: "GTEST" });
    const createVerifier = vi.fn().mockResolvedValue({ verify, settle: vi.fn() });
    const adapter = createX402StellarAdapter({ config, signerProvider, createVerifier });

    await expect(adapter.verifyExact(verificationInput)).resolves.toEqual({
      adapter: "@x402/stellar",
      valid: true
    });
    expect(createVerifier).toHaveBeenCalledWith({
      network: "stellar:testnet",
      rpcUrl: config.networks["stellar:testnet"].rpcUrl,
      maxTransactionFeeStroops: 50_000,
      inclusionFeeStroops: 100
    });
    expect(verify).toHaveBeenCalledWith(testPaymentPayload, testPaymentRequirement);
  });

  it.each([
    ["invalid_exact_stellar_payload_wrong_operation", "INVALID_PAYMENT_PAYLOAD"],
    ["network_mismatch", "UNSUPPORTED_NETWORK"],
    ["invalid_exact_stellar_payload_wrong_asset", "ASSET_MISMATCH"],
    ["invalid_exact_stellar_payload_wrong_amount", "AMOUNT_MISMATCH"],
    ["invalid_exact_stellar_payload_wrong_recipient", "RECIPIENT_MISMATCH"],
    ["invalid_exact_stellar_payload_missing_payer_signature", "INVALID_SIGNATURE"],
    ["invalid_exact_stellar_signature_expiration_too_far", "AUTH_EXPIRED"],
    ["invalid_exact_stellar_payload_facilitator_is_payer", "INVALID_PAYMENT_PAYLOAD"],
    ["invalid_exact_stellar_payload_facilitator_in_auth", "INVALID_PAYMENT_PAYLOAD"],
    ["invalid_exact_stellar_payload_simulation_failed", "SETTLEMENT_FAILED"]
  ])("maps %s to stable failure code %s", async (invalidReason, failureCode) => {
    const adapter = createX402StellarAdapter({
      config,
      signerProvider,
      createVerifier: async () => ({
        async verify() {
          return { isValid: false, invalidReason };
        },
        async settle() {
          throw new Error("not used");
        }
      })
    });

    await expect(adapter.verifyExact(verificationInput)).resolves.toMatchObject({
      adapter: "@x402/stellar",
      failureCode,
      officialContext: { invalidReason },
      valid: false
    });
  });

  it("fails closed for verifier exceptions and incompatible responses", async () => {
    const throwing = createX402StellarAdapter({
      config,
      signerProvider,
      createVerifier: async () => ({
        async verify() {
          throw new Error("secret-bearing upstream error");
        },
        async settle() {
          throw new Error("not used");
        }
      })
    });
    const incompatible = createX402StellarAdapter({
      config,
      signerProvider,
      createVerifier: async () => ({
        async verify() {
          return { isValid: true } as never;
        },
        async settle() {
          throw new Error("not used");
        }
      })
    });

    const thrownResult = await throwing.verifyExact(verificationInput);
    expect(thrownResult).toMatchObject({ valid: false, failureCode: "SETTLEMENT_FAILED" });
    expect(JSON.stringify(thrownResult)).not.toContain("secret-bearing");
    await expect(incompatible.verifyExact(verificationInput)).resolves.toMatchObject({
      valid: false,
      failureCode: "SETTLEMENT_FAILED"
    });
  });

  it("settles through the official verifier and requires independent RPC finality", async () => {
    const settle = vi.fn().mockResolvedValue({
      success: true,
      transaction: "tx_confirmed",
      network: "stellar:testnet",
      payer: "GTEST"
    });
    const resolveFinality = vi.fn().mockResolvedValue({ status: "confirmed", ledger: 456 });
    const adapter = createX402StellarAdapter({
      config,
      signerProvider,
      createVerifier: async () => ({ verify: vi.fn(), settle }),
      resolveFinality
    });

    await expect(adapter.settleExact?.(verificationInput)).resolves.toEqual({
      adapter: "@x402/stellar",
      status: "confirmed",
      transactionHash: "tx_confirmed",
      ledger: 456
    });
    expect(settle).toHaveBeenCalledWith(testPaymentPayload, testPaymentRequirement);
    expect(resolveFinality).toHaveBeenCalledWith({
      network: "stellar:testnet",
      rpcUrl: config.networks["stellar:testnet"].rpcUrl,
      transactionHash: "tx_confirmed"
    });
  });

  it.each([
    ["invalid_exact_stellar_payload_simulation_failed", "simulation"],
    ["invalid_exact_stellar_payload_fee_exceeds_maximum", "simulation"],
    ["settle_exact_stellar_transaction_submission_failed", "submission"]
  ])("classifies official %s settlement failures as %s", async (errorReason, stage) => {
    const adapter = createX402StellarAdapter({
      config,
      signerProvider,
      createVerifier: async () => ({
        verify: vi.fn(),
        async settle() {
          return {
            success: false,
            transaction: "",
            network: "stellar:testnet",
            errorReason
          };
        }
      }),
      resolveFinality: vi.fn()
    });

    await expect(adapter.settleExact?.(verificationInput)).resolves.toMatchObject({
      status: "failed",
      failureCode: "SETTLEMENT_FAILED",
      officialContext: { stage, errorReason }
    });
  });

  it.each([
    ["pending", "timed_out", "timeout"],
    ["failed", "failed", "failed"]
  ] as const)(
    "maps %s RPC finality to %s settlement state",
    async (finalityStatus, settlementStatus, stage) => {
      const adapter = createX402StellarAdapter({
        config,
        signerProvider,
        createVerifier: async () => ({
          verify: vi.fn(),
          async settle() {
            return {
              success: true,
              transaction: "tx_unconfirmed",
              network: "stellar:testnet",
              payer: "GTEST"
            };
          }
        }),
        resolveFinality: async () => ({ status: finalityStatus })
      });

      await expect(adapter.settleExact?.(verificationInput)).resolves.toMatchObject({
        status: settlementStatus,
        transactionHash: "tx_unconfirmed",
        officialContext: { stage }
      });
    }
  );
});

describe("official x402 Stellar adapter with upstream ExactStellarScheme integration", () => {
  describe("valid signed testnet vectors pass upstream verification", () => {
    it("accepts a valid exact payment with correct signature, network, asset, amount, recipient, and expiry", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build valid transaction using the official SDK
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

      // Sign with payer
      transaction.sign(officialStellarSdk.Keypair.fromSecret(payer.secret()));

      // Create signed authorization entry
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

      // Rebuild transaction with authorization
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

      const transactionXdr = authorizedTransaction.toXDR();

      // Create the scheme and verify
      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transactionXdr }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: true,
        payer: payer.publicKey()
      });
    });
  });

  describe("wrong signature fails closed", () => {
    it("rejects payment with invalid signature", async () => {
      const payer = Keypair.random();
      const wrongSigner = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build transaction but sign with wrong key
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

      // Sign with wrong key
      transaction.sign(officialStellarSdk.Keypair.fromSecret(wrongSigner.secret()));

      const transactionXdr = transaction.toXDR();

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transactionXdr }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining("signature")
      });
    });
  });

  describe("network mismatch fails closed", () => {
    it("rejects payment with mismatched network", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build valid transaction for testnet
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

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      // Require pubnet but provide testnet transaction
      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:pubnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transaction.toXDR() }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: "network_mismatch"
      });
    });
  });

  describe("asset mismatch fails closed", () => {
    it("rejects payment with wrong asset contract", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();
      const wrongAsset = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";

      // Build transaction with wrong asset
      const transaction = new officialStellarSdk.TransactionBuilder(
        new officialStellarSdk.Account(payer.publicKey(), "0"),
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        }
      )
        .addOperation(
          officialStellarSdk.Operation.invokeContractFunction({
            contract: wrongAsset,
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

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transaction.toXDR() }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining("asset")
      });
    });
  });

  describe("amount mismatch fails closed", () => {
    it("rejects payment with insufficient amount", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build transaction with wrong amount (too low)
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
              officialStellarSdk.nativeToScVal(100000n, { type: "i128" }) // Too low
            ]
          })
        )
        .setTimeout(60)
        .build();

      transaction.sign(officialStellarSdk.Keypair.fromSecret(payer.secret()));

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transaction.toXDR() }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining("amount")
      });
    });
  });

  describe("recipient mismatch fails closed", () => {
    it("rejects payment to wrong recipient", async () => {
      const payer = Keypair.random();
      const correctRecipient = Keypair.random();
      const wrongRecipient = Keypair.random();
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

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: correctRecipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transaction.toXDR() }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining("recipient")
      });
    });
  });

  describe("operation mismatch fails closed", () => {
    it("rejects transaction with wrong operation type", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build transaction with payment operation instead of contract invocation
      const transaction = new officialStellarSdk.TransactionBuilder(
        new officialStellarSdk.Account(payer.publicKey(), "0"),
        {
          fee: BASE_FEE,
          networkPassphrase: Networks.TESTNET
        }
      )
        .addOperation(
          officialStellarSdk.Operation.payment({
            destination: recipient.publicKey(),
            asset: officialStellarSdk.Asset.native(),
            amount: "100"
          })
        )
        .setTimeout(60)
        .build();

      transaction.sign(officialStellarSdk.Keypair.fromSecret(payer.secret()));

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: transaction.toXDR() }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining("operation")
      });
    });
  });

  describe("expiry mismatch fails closed", () => {
    it("rejects transaction with authorization expiring too far in future", async () => {
      const payer = Keypair.random();
      const recipient = Keypair.random();
      const facilitator = Keypair.random();

      // Build transaction
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

      // Create authorization with expiry far in the future
      const authorization = await officialStellarSdk.authorizeInvocation({
        signer: officialStellarSdk.Keypair.fromSecret(payer.secret()),
        validUntilLedgerSeq: 200, // Beyond the maxTimeoutSeconds of 60
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

      const scheme = new ExactStellarScheme([
        createEd25519Signer(facilitator.secret(), "stellar:testnet")
      ]);

      const requirement: PaymentRequirements = {
        scheme: "exact",
        network: "stellar:testnet",
        asset: testAssetContractId,
        amount: "500000",
        payTo: recipient.publicKey(),
        maxTimeoutSeconds: 60,
        extra: { areFeesSponsored: true }
      };

      const payload: PaymentPayload = {
        x402Version: 2,
        accepted: requirement,
        payload: { transaction: authorizedTransaction.toXDR() }
      };

      const response = await scheme.verify(payload, requirement);
      expect(response).toMatchObject({
        isValid: false,
        invalidReason: expect.stringContaining("expiration")
      });
    });
  });

  describe("unexpected upstream errors never become valid", () => {
    it("fails closed when unexpected upstream error occurs", async () => {
      const adapter = createX402StellarAdapter({
        config,
        signerProvider,
        createVerifier: async () => ({
          async verify() {
            throw new Error("Unexpected upstream error");
          },
          async settle() {
            throw new Error("not used");
          }
        })
      });

      const result = await adapter.verifyExact(verificationInput);
      expect(result.valid).toBe(false);
      expect(result.failureCode).toBe("SETTLEMENT_FAILED");
      expect(JSON.stringify(result)).not.toContain("Unexpected upstream error");
    });

    it("rejects incompatible upstream responses", async () => {
      const adapter = createX402StellarAdapter({
        config,
        signerProvider,
        createVerifier: async () => ({
          async verify() {
            return { isValid: true } as never; // Missing required payer field
          },
          async settle() {
            throw new Error("not used");
          }
        })
      });

      const result = await adapter.verifyExact(verificationInput);
      expect(result.valid).toBe(false);
      expect(result.failureCode).toBe("SETTLEMENT_FAILED");
    });
  });
});
