import {
  type PaymentAttempt,
  type Receipt,
  type ReceiptStreamChange,
  type Settlement
} from "@lumenbazaar/shared";

import { type CreateSettlementInput } from "./settlementStore.js";

export type ConfirmedPaymentStateInput = {
  attempt: PaymentAttempt;
  settlement: CreateSettlementInput & {
    transactionHash: string;
    ledger: number;
    settledAt: string;
    status: "confirmed";
  };
};

export type FailedPaymentStateInput = {
  attempt: PaymentAttempt;
  settlement: CreateSettlementInput & {
    status: "failed" | "timed_out";
  };
  failureCode: string;
  failureReason: string;
};

export type ReceiptStatusChangeListener = (change: ReceiptStreamChange) => void;

export function receiptStatusChange(receipt: Receipt): ReceiptStreamChange {
  return {
    receiptId: receipt.id,
    status: receipt.status,
    network: receipt.network,
    sellerId: receipt.sellerId,
    resourceId: receipt.resourceId,
    failureCode: receipt.failureCode,
    settledAt: receipt.settledAt,
    occurredAt: receipt.updatedAt
  };
}

export type PaymentStatePersistence = {
  recordConfirmed(input: ConfirmedPaymentStateInput): Promise<{
    attempt: PaymentAttempt;
    settlement: Settlement;
    receipt: Receipt;
  }>;
  recordFailed(input: FailedPaymentStateInput): Promise<{
    attempt: PaymentAttempt;
    settlement: Settlement;
  }>;
  subscribeToReceiptStatusChanges(listener: ReceiptStatusChangeListener): () => void;
};
