import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  type Settlement,
  type SettlementStatus,
  type WebhookEventType,
  buildWebhookPayload,
  type WebhookPayload,
} from "@lumenbazaar/shared";

/**
 * Webhook event type to settlement status mapping.
 * Defines which settlement status transitions trigger which webhook events.
 */
export const WEBHOOK_EVENT_TYPE_TO_STATUS: Record<WebhookEventType, SettlementStatus[]> = {
  "settlement.pending": ["pending"],
  "settlement.finalized": ["confirmed", "settled"],
  "settlement.failed": ["failed", "timed_out"],
  "settlement.reconciled": ["settled"], // reconciliationState = "reconciled"
};

/**
 * WebhookEventStore handles persistence of webhook events and delivery attempts.
 * Events are idempotent: same eventId can be stored multiple times without duplication.
 */
export type WebhookEventStore = {
  /**
   * Create or get an existing webhook event (idempotent).
   * Returns the event if it already exists with the same eventId.
   */
  createOrGetWebhookEvent: (
    sellerId: string,
    eventId: string,
    eventType: WebhookEventType,
    paymentAttemptId: string,
    settlementId: string,
    status: SettlementStatus,
    payload: WebhookPayload
  ) => Promise<{ id: string; eventId: string; isNew: boolean }>;

  /**
   * List webhook events for a seller (paginated).
   */
  listWebhookEvents: (
    sellerId: string,
    limit: number,
    offset: number
  ) => Promise<{
    events: Array<{
      id: string;
      eventId: string;
      eventType: WebhookEventType;
      status: SettlementStatus;
      createdAt: string;
    }>;
    total: number;
  }>;
};

/**
 * In-memory webhook event store for testing and development.
 */
export class InMemoryWebhookEventStore implements WebhookEventStore {
  private readonly events = new Map<
    string,
    {
      id: string;
      eventId: string;
      sellerId: string;
      eventType: WebhookEventType;
      paymentAttemptId: string;
      settlementId: string;
      status: SettlementStatus;
      payload: WebhookPayload;
      createdAt: string;
    }
  >();

  async createOrGetWebhookEvent(
    sellerId: string,
    eventId: string,
    eventType: WebhookEventType,
    paymentAttemptId: string,
    settlementId: string,
    status: SettlementStatus,
    payload: WebhookPayload
  ): Promise<{ id: string; eventId: string; isNew: boolean }> {
    // Check if event already exists
    for (const event of this.events.values()) {
      if (event.eventId === eventId && event.sellerId === sellerId) {
        return { id: event.id, eventId: event.eventId, isNew: false };
      }
    }

    // Create new event
    const id = `webhook_event_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const now = new Date().toISOString();

    this.events.set(id, {
      id,
      eventId,
      sellerId,
      eventType,
      paymentAttemptId,
      settlementId,
      status,
      payload,
      createdAt: now,
    });

    return { id, eventId, isNew: true };
  }

  async listWebhookEvents(
    sellerId: string,
    limit: number,
    offset: number
  ): Promise<{
    events: Array<{
      id: string;
      eventId: string;
      eventType: WebhookEventType;
      status: SettlementStatus;
      createdAt: string;
    }>;
    total: number;
  }> {
    const all = Array.from(this.events.values())
      .filter((e) => e.sellerId === sellerId)
      .sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime;
      });

    const events = all.slice(offset, offset + limit).map((e) => ({
      id: e.id,
      eventId: e.eventId,
      eventType: e.eventType,
      status: e.status,
      createdAt: e.createdAt,
    }));

    return { events, total: all.length };
  }
}

/**
 * Webhook event listener callback type.
 * Called whenever a new webhook event is created.
 */
export type WebhookEventListener = (event: {
  id: string;
  eventId: string;
  sellerId: string;
  eventType: WebhookEventType;
  paymentAttemptId: string;
  settlementId: string;
  status: SettlementStatus;
  payload: WebhookPayload;
  createdAt: string;
}) => void;

/**
 * Webhook event emitter service.
 * Manages webhook event creation and listener notification.
 * Should be used at settlement status transition points to emit events.
 */
export class WebhookEventService {
  private readonly listeners: WebhookEventListener[] = [];

  constructor(
    private readonly store: WebhookEventStore = new InMemoryWebhookEventStore()
  ) {}

  /**
   * Subscribe to webhook events.
   * Returns an unsubscribe function.
   */
  subscribe(listener: WebhookEventListener): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Emit a webhook event for a settlement status change.
   * Generates a stable eventId from the settlement correlationId and event type.
   * Events are idempotent: same eventId won't create duplicate records.
   *
   * Listener failures are swallowed to prevent blocking settlement persistence.
   *
   * @param sellerId - The seller ID (for authorization)
   * @param eventType - The type of webhook event
   * @param settlement - The settlement record with status
   * @throws LumenError if settlement has no sellerId
   */
  async emitSettlementEvent(
    sellerId: string,
    eventType: WebhookEventType,
    settlement: {
      id: string;
      correlationId: string;
      paymentAttemptId: string;
      status: SettlementStatus;
      amount: string;
      assetCode: string;
      assetIssuer: string;
      network: string;
      transactionHash: string | null;
      failureCode: string | null;
      failureReason: string | null;
    }
  ): Promise<void> {
    // Generate stable unique event ID from correlationId + eventType
    // This ensures retries/replays produce the same eventId for idempotency
    const eventId = `${settlement.correlationId}.${eventType}`;

    // Build webhook payload with explicit field mapping (no spreading)
    const payload = buildWebhookPayload(eventId, eventType, settlement, new Date().toISOString());

    // Store event (idempotent)
    const result = await this.store.createOrGetWebhookEvent(
      sellerId,
      eventId,
      eventType,
      settlement.paymentAttemptId,
      settlement.id,
      settlement.status,
      payload
    );

    // Only notify listeners if this is a new event
    // This prevents duplicate webhook deliveries on replay
    if (result.isNew) {
      const event = {
        id: result.id,
        eventId: result.eventId,
        sellerId,
        eventType,
        paymentAttemptId: settlement.paymentAttemptId,
        settlementId: settlement.id,
        status: settlement.status,
        payload,
        createdAt: new Date().toISOString(),
      };

      // Notify all listeners (webhook delivery workers)
      // Failures are swallowed to prevent blocking settlement operations
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch (e) {
          // Log but don't re-throw
          console.error("Webhook event listener failed:", e);
        }
      }
    }
  }

  /**
   * List webhook events for a seller.
   */
  async listWebhookEvents(
    sellerId: string,
    limit: number,
    offset: number
  ): Promise<{
    events: Array<{
      id: string;
      eventId: string;
      eventType: WebhookEventType;
      status: SettlementStatus;
      createdAt: string;
    }>;
    total: number;
  }> {
    return this.store.listWebhookEvents(sellerId, limit, offset);
  }

  getStore() {
    return this.store;
  }
}
