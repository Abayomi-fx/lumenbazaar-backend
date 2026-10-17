import { type WebhookEventService } from "./webhookEvents.js";
import { type WebhookEventType } from "@lumenbazaar/shared";

/**
 * Settlement event emitter adapter.
 * Provides a way to emit webhook events when settlement status changes.
 * Used as a callback from the settlement service to notify webhook listeners.
 */
export class SettlementEventEmitter {
  constructor(private readonly webhookEventService: WebhookEventService) {}

  /**
   * Emit a settlement event for a confirmed settlement.
   * Called after recordConfirmed() transaction completes.
   */
  async emitConfirmedEvent(
    sellerId: string,
    settlement: {
      id: string;
      correlationId: string;
      paymentAttemptId: string;
      status: "confirmed" | "settled";
      amount: string;
      assetCode: string;
      assetIssuer: string;
      network: string;
      transactionHash: string | null;
      failureCode: string | null;
      failureReason: string | null;
    }
  ): Promise<void> {
    try {
      await this.webhookEventService.emitSettlementEvent(
        sellerId,
        "settlement.finalized",
        settlement
      );
    } catch (error) {
      // Don't throw - webhook emission should never block settlement
      console.error("Failed to emit settlement.finalized event:", error);
    }
  }

  /**
   * Emit a settlement event for a failed settlement.
   * Called after recordFailed() transaction completes.
   */
  async emitFailedEvent(
    sellerId: string,
    settlement: {
      id: string;
      correlationId: string;
      paymentAttemptId: string;
      status: "failed" | "timed_out";
      amount: string;
      assetCode: string;
      assetIssuer: string;
      network: string;
      transactionHash: string | null;
      failureCode: string | null;
      failureReason: string | null;
    }
  ): Promise<void> {
    try {
      await this.webhookEventService.emitSettlementEvent(
        sellerId,
        "settlement.failed",
        settlement
      );
    } catch (error) {
      // Don't throw - webhook emission should never block settlement
      console.error("Failed to emit settlement.failed event:", error);
    }
  }

  /**
   * Emit a settlement event for a reconciled settlement.
   * Called after settlement reconciliation on Horizon confirms success.
   */
  async emitReconciledEvent(
    sellerId: string,
    settlement: {
      id: string;
      correlationId: string;
      paymentAttemptId: string;
      status: "settled";
      amount: string;
      assetCode: string;
      assetIssuer: string;
      network: string;
      transactionHash: string | null;
      failureCode: string | null;
      failureReason: string | null;
    }
  ): Promise<void> {
    try {
      await this.webhookEventService.emitSettlementEvent(
        sellerId,
        "settlement.reconciled",
        settlement
      );
    } catch (error) {
      // Don't throw - webhook emission should never block settlement
      console.error("Failed to emit settlement.reconciled event:", error);
    }
  }

  /**
   * Emit a settlement event for a pending settlement.
   * Called for settlements awaiting reconciliation.
   */
  async emitPendingEvent(
    sellerId: string,
    settlement: {
      id: string;
      correlationId: string;
      paymentAttemptId: string;
      status: "pending";
      amount: string;
      assetCode: string;
      assetIssuer: string;
      network: string;
      transactionHash: string | null;
      failureCode: string | null;
      failureReason: string | null;
    }
  ): Promise<void> {
    try {
      await this.webhookEventService.emitSettlementEvent(
        sellerId,
        "settlement.pending",
        settlement
      );
    } catch (error) {
      // Don't throw - webhook emission should never block settlement
      console.error("Failed to emit settlement.pending event:", error);
    }
  }
}
