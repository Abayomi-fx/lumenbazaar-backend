import { createHash } from "node:crypto";

import {
  LumenError,
  type PaymentAttempt,
  type Receipt,
  type Settlement
} from "@lumenbazaar/shared";

import { InMemoryReceiptStore, type ReceiptStore } from "./receiptStore.js";

export type ReceiptServiceOptions = {
  receiptStore?: ReceiptStore;
};

export class ReceiptService {
  private readonly receiptStore: ReceiptStore;

  constructor(options: ReceiptServiceOptions = {}) {
    this.receiptStore = options.receiptStore ?? new InMemoryReceiptStore();
  }

  async finalizeSettlementReceipt(paymentAttempt: PaymentAttempt, settlement: Settlement) {
    const existing = await this.receiptStore.getReceiptByAttempt(paymentAttempt.id);

    if (existing !== undefined) {
      return existing;
    }

    return this.receiptStore.createReceipt({
      correlationId: paymentAttempt.correlationId,
      paymentAttemptId: paymentAttempt.id,
      resourceId: paymentAttempt.resourceId,
      sellerId: paymentAttempt.sellerId,
      transactionHash: settlement.transactionHash,
      ledger: settlement.ledger,
      network: paymentAttempt.network,
      amount: paymentAttempt.amount,
      assetCode: paymentAttempt.assetCode,
      assetIssuer: paymentAttempt.assetIssuer,
      status: settlement.status === "confirmed" ? "finalized" : "pending",
      settledAt: settlement.settledAt,
      failureCode: paymentAttempt.failureCode,
      failureReason: paymentAttempt.failureReason,
      evidenceHash: receiptEvidenceHash(paymentAttempt, settlement)
    });
  }

  async getReceipt(receiptId: string): Promise<Receipt> {
    const receipt = await this.receiptStore.getReceipt(receiptId);

    if (receipt === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Receipt was not found.");
    }

    return receipt;
  }

  async getReceiptByAttempt(paymentAttemptId: string) {
    return this.receiptStore.getReceiptByAttempt(paymentAttemptId);
  }

  async listReceiptsBySeller(sellerId: string, limit?: number) {
    return this.receiptStore.listReceiptsBySeller(sellerId, limit);
  }
}

export function receiptEvidenceHash(paymentAttempt: PaymentAttempt, settlement: Settlement) {
  return createHash("sha256")
    .update(
      [
        paymentAttempt.id,
        paymentAttempt.paymentHash,
        settlement.transactionHash ?? "",
        String(settlement.ledger ?? ""),
        settlement.network,
        settlement.amount,
        settlement.assetIssuer
      ].join(":"),
      "utf8"
    )
    .digest("hex");
}
