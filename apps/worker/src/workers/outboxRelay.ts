import { type Job } from "bullmq";

import {
  type AppConfig,
  getPrismaClient,
  claimOutboxEventBatch,
  markOutboxEventDelivered,
  markOutboxEventFailed,
  isOutboxEventProcessed,
  recordProcessedOutboxEvent,
  type OutboxAggregateType
} from "@lumenbazaar/shared";
import { type PrismaClient } from "@prisma/client";

/**
 * Relay worker that processes outbox events and delivers them to appropriate handlers.
 * Implements:
 * - Row-level locking and leasing for crash recovery
 * - Per-aggregate ordering (events for same aggregate processed in order)
 * - Bounded retries with exponential backoff
 * - Dead-letter handling for poison events
 * - Idempotent delivery (consumers deduplicate on event ID)
 */

export type OutboxRelayJobData = {
  // Empty - this job is just a trigger to process the next batch
};

const BATCH_SIZE = 100;
const LEASE_DURATION_MS = 60_000; // 60 seconds
const MAX_RETRY_ATTEMPTS = 10;

// Consumer IDs for idempotency tracking
const CONSUMER_IDS = {
  resourceIndexing: "outbox.consumer.resource.indexing",
  settlementReconciliation: "outbox.consumer.settlement.reconciliation",
  receiptFinalization: "outbox.consumer.receipt.finalization",
  catalogIndexing: "outbox.consumer.catalog.indexing"
} as const;

export async function handleOutboxRelay(
  job: Job<OutboxRelayJobData>,
  config: AppConfig,
  dependencies: {
    db?: PrismaClient;
  } = {}
) {
  const db = dependencies.db ?? getPrismaClient();
  const workerId = `relay-${process.pid}-${Date.now()}`;

  let processedCount = 0;
  let failedCount = 0;
  let deliveredCount = 0;

  try {
    // Claim a batch of pending events with row locking
    const events = await claimOutboxEventBatch(db, workerId, BATCH_SIZE, LEASE_DURATION_MS);

    if (events.length === 0) {
      await job.log("No pending outbox events to process");
      return;
    }

    await job.log(`Processing batch of ${events.length} outbox events`);

    // Process events, maintaining per-aggregate order (already ordered by claim query)
    for (const event of events) {
      processedCount++;

      try {
        // Route to appropriate handler based on aggregate type and event type
        await deliverOutboxEvent(db, event, job);
        deliveredCount++;
      } catch (error) {
        failedCount++;
        const errorMsg = error instanceof Error ? error.message : String(error);
        await job.log(`Failed to deliver event ${event.id}: ${errorMsg}`);

        // Record failure and schedule retry
        await markOutboxEventFailed(db, event.id, error instanceof Error ? error : new Error(String(error)), MAX_RETRY_ATTEMPTS);
      }
    }

    await job.log(
      `Outbox relay batch complete: processed=${processedCount}, delivered=${deliveredCount}, failed=${failedCount}`
    );
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await job.log(`Outbox relay batch processing error: ${errorMsg}`);
    throw error;
  }
}

/**
 * Route and deliver an individual outbox event to its handler.
 * Handler is responsible for idempotency checks and recording processed status.
 */
async function deliverOutboxEvent(
  db: PrismaClient,
  event: {
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: any;
  },
  job: Job<OutboxRelayJobData>
) {
  // Determine consumer ID based on event type
  let consumerId: string;

  if (event.aggregateType === "resource" && event.eventType === "resource.indexed") {
    consumerId = CONSUMER_IDS.resourceIndexing;
  } else if (event.aggregateType === "settlement" && event.eventType === "settlement.reconciliation_enqueued") {
    consumerId = CONSUMER_IDS.settlementReconciliation;
  } else if (event.aggregateType === "receipt" && event.eventType === "receipt.status_changed") {
    consumerId = CONSUMER_IDS.receiptFinalization;
  } else if (event.aggregateType === "catalog" && event.eventType === "catalog.resource_cataloged") {
    consumerId = CONSUMER_IDS.catalogIndexing;
  } else {
    throw new Error(
      `Unknown outbox event type: ${event.aggregateType}.${event.eventType}`
    );
  }

  // Deliver to handler - handler is responsible for:
  // 1. Checking idempotency via isOutboxEventProcessed()
  // 2. Executing side effects (which may enqueue jobs, send notifications, etc.)
  // 3. Recording processed status via recordProcessedOutboxEvent() in same transaction
  // 4. Throwing if delivery fails (will trigger retry)
  await routeAndDeliver(db, event, consumerId, job);

  // After successful delivery, mark as delivered
  await markOutboxEventDelivered(db, event.id);
}

/**
 * Route event to appropriate handler and deliver it.
 */
async function routeAndDeliver(
  db: PrismaClient,
  event: {
    id: string;
    aggregateType: string;
    aggregateId: string;
    eventType: string;
    payload: any;
  },
  consumerId: string,
  job: Job<OutboxRelayJobData>
): Promise<void> {
  const { aggregateType, eventType, payload } = event;

  if (aggregateType === "resource" && eventType === "resource.indexed") {
    // Resource indexing - payload should have { resourceId, versionId }
    await deliverResourceIndexingEvent(db, payload, consumerId, event.id, job);
  } else if (aggregateType === "settlement" && eventType === "settlement.reconciliation_enqueued") {
    // Settlement reconciliation - payload should have settlement details
    await deliverSettlementReconciliationEvent(db, payload, consumerId, event.id, job);
  } else if (aggregateType === "receipt" && eventType === "receipt.status_changed") {
    // Receipt finalization - payload should have receipt details
    await deliverReceiptFinalizationEvent(db, payload, consumerId, event.id, job);
  } else if (aggregateType === "catalog" && eventType === "catalog.resource_cataloged") {
    // Catalog indexing - payload should have resource details
    await deliverCatalogIndexingEvent(db, payload, consumerId, event.id, job);
  } else {
    throw new Error(
      `No handler for outbox event: ${aggregateType}.${eventType}`
    );
  }
}

/**
 * Deliver resource indexing event.
 * Idempotency: If already processed, skip handler execution.
 * Side effects: Enqueue resource indexing job (idempotent on resource ID + version ID).
 */
async function deliverResourceIndexingEvent(
  db: PrismaClient,
  payload: any,
  consumerId: string,
  eventId: string,
  job: Job<OutboxRelayJobData>
): Promise<void> {
  const { resourceId, versionId } = payload;
  if (!resourceId || !versionId) {
    throw new Error("Invalid resource indexing event payload: missing resourceId or versionId");
  }

  // Idempotency: Check if already processed
  const alreadyProcessed = await isOutboxEventProcessed(db, eventId, consumerId);
  if (alreadyProcessed) {
    await job.log(`Resource indexing already processed for event ${eventId}`);
    return;
  }

  // TODO: Enqueue actual resource indexing job
  // Example: await resourceIndexingQueue.add({ resourceId, versionId });
  // For now, this is a placeholder for the actual integration.

  // Record as processed (idempotency tracking) in transaction
  // This ensures if the process crashes after enqueueing but before committing,
  // the event won't be reprocessed by another relay instance.
  await db.$transaction(async (tx) => {
    await recordProcessedOutboxEvent(tx, eventId, consumerId, "resource", resourceId, "resource.indexed");
  });

  await job.log(`Delivered resource indexing event for resource ${resourceId} version ${versionId}`);
}

/**
 * Deliver settlement reconciliation event.
 * Idempotency: If already processed, skip handler execution.
 * Side effects: Enqueue settlement confirmation job to check blockchain for confirmation.
 */
async function deliverSettlementReconciliationEvent(
  db: PrismaClient,
  payload: any,
  consumerId: string,
  eventId: string,
  job: Job<OutboxRelayJobData>
): Promise<void> {
  const { settlementId, paymentAttemptId, correlationId, network, transactionHash } = payload;
  if (!settlementId || !paymentAttemptId || !network) {
    throw new Error(
      "Invalid settlement reconciliation event payload: missing settlementId, paymentAttemptId, or network"
    );
  }

  // Idempotency: Check if already processed
  const alreadyProcessed = await isOutboxEventProcessed(db, eventId, consumerId);
  if (alreadyProcessed) {
    await job.log(`Settlement reconciliation already processed for event ${eventId}`);
    return;
  }

  // TODO: Enqueue actual settlement confirmation job
  // Example: await settlementQueue.add(SettlementReconciliationJob { 
  //   paymentAttemptId, settlementId, transactionHash, network, correlationId 
  // });
  // For now, this is a placeholder for the actual integration.

  // Record as processed (idempotency tracking) in transaction
  await db.$transaction(async (tx) => {
    await recordProcessedOutboxEvent(
      tx,
      eventId,
      consumerId,
      "settlement",
      settlementId,
      "settlement.reconciliation_enqueued"
    );
  });

  await job.log(
    `Delivered settlement reconciliation event for settlement ${settlementId} (${transactionHash})`
  );
}

/**
 * Deliver receipt finalization event.
 * Idempotency: If already processed, skip handler execution.
 * Side effects: Send webhook notifications, update receipt status listeners.
 */
async function deliverReceiptFinalizationEvent(
  db: PrismaClient,
  payload: any,
  consumerId: string,
  eventId: string,
  job: Job<OutboxRelayJobData>
): Promise<void> {
  const { receiptId, sellerId, status, transactionHash } = payload;
  if (!receiptId || !sellerId || !status) {
    throw new Error("Invalid receipt finalization event payload: missing receiptId, sellerId, or status");
  }

  // Idempotency: Check if already processed
  const alreadyProcessed = await isOutboxEventProcessed(db, eventId, consumerId);
  if (alreadyProcessed) {
    await job.log(`Receipt finalization already processed for event ${eventId}`);
    return;
  }

  // TODO: Integrate with webhook notification system
  // Example: await webhookService.sendReceiptStatusChanged({
  //   sellerId, receiptId, status, transactionHash
  // });
  // For now, this is a placeholder for the actual integration.

  // Record as processed (idempotency tracking) in transaction
  // Important: This MUST be done in the same transaction as the webhook/notification side effects
  // so that if the process crashes, the idempotency record exists and prevents reprocessing.
  await db.$transaction(async (tx) => {
    await recordProcessedOutboxEvent(tx, eventId, consumerId, "receipt", receiptId, "receipt.status_changed");
  });

  await job.log(
    `Delivered receipt finalization event for receipt ${receiptId} seller ${sellerId} status ${status}`
  );
}

/**
 * Deliver catalog indexing event.
 * Idempotency: If already processed, skip handler execution.
 * Side effects: Enqueue resource indexing job or update search indexes.
 */
async function deliverCatalogIndexingEvent(
  db: PrismaClient,
  payload: any,
  consumerId: string,
  eventId: string,
  job: Job<OutboxRelayJobData>
): Promise<void> {
  const { resourceId, catalogEventId, versionId, sellerId } = payload;
  if (!resourceId || !catalogEventId) {
    throw new Error("Invalid catalog indexing event payload: missing resourceId or catalogEventId");
  }

  // Idempotency: Check if already processed
  const alreadyProcessed = await isOutboxEventProcessed(db, eventId, consumerId);
  if (alreadyProcessed) {
    await job.log(`Catalog indexing already processed for event ${eventId}`);
    return;
  }

  // TODO: Integrate with actual resource indexing queue or search service
  // Example: await searchService.indexResource({
  //   resourceId, versionId, sellerId
  // });
  // Or: await resourceIndexingQueue.add({ resourceId, versionId, catalogEventId });
  // For now, this is a placeholder for the actual integration.

  // Record as processed (idempotency tracking) in transaction
  await db.$transaction(async (tx) => {
    await recordProcessedOutboxEvent(
      tx,
      eventId,
      consumerId,
      "catalog",
      catalogEventId,
      "catalog.resource_cataloged"
    );
  });

  await job.log(
    `Delivered catalog indexing event for resource ${resourceId} catalog event ${catalogEventId}`
  );
}
