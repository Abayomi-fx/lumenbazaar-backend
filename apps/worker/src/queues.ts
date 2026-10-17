import { Queue, type JobsOptions } from "bullmq";
import { Redis } from "ioredis";

import { type AppConfig } from "@lumenbazaar/shared";
import { settlementReconciliationQueueName } from "@lumenbazaar/stellar-payments";

export const queueNames = {
  settlementConfirmation: settlementReconciliationQueueName,
  resourceIndexing: "resource-indexing",
  searchSync: "search-sync",
  conformanceRunner: "conformance-runner",
  networkHealth: "network-health",
  receiptFinalizer: "receipt-finalizer",
  stalePaymentCleanup: "stale-payment-cleanup",
  webhookDelivery: "webhook-delivery",
  deadLetter: "dead-letter"
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 1000
  },
  removeOnComplete: 100,
  removeOnFail: false
};

export function createBullMqConnection(config: AppConfig) {
  return new Redis(config.redisUrl, {
    maxRetriesPerRequest: null
  });
}

export function createBullMqQueue(name: QueueName, config: AppConfig) {
  return new Queue(name, {
    connection: createBullMqConnection(config),
    defaultJobOptions
  });
}
