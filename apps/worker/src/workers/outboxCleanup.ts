import { type Job } from "bullmq";

import { getPrismaClient, cleanupDeliveredOutboxEvents, type AppConfig } from "@lumenbazaar/shared";
import { type PrismaClient } from "@prisma/client";

/**
 * Cleanup worker that removes old delivered outbox events and their processed records.
 * Runs periodically (e.g., daily) to prevent table bloat while maintaining audit trail.
 *
 * Retention policy: delivered events are kept for 30 days, then deleted along with
 * their processed records. Dead-letter events are kept indefinitely for inspection
 * and manual requeue.
 */

export type OutboxCleanupJobData = {
  retentionDays?: number; // Number of days to retain delivered events (default 30)
};

const DEFAULT_RETENTION_DAYS = 30;

export async function handleOutboxCleanup(
  job: Job<OutboxCleanupJobData>,
  config: AppConfig,
  dependencies: {
    db?: PrismaClient;
  } = {}
) {
  const db = dependencies.db ?? getPrismaClient();
  const retentionDays = job.data.retentionDays ?? DEFAULT_RETENTION_DAYS;

  try {
    const deletedCount = await cleanupDeliveredOutboxEvents(db, retentionDays);

    await job.log(`Outbox cleanup complete: deleted ${deletedCount} delivered events (retention: ${retentionDays} days)`);

    return {
      deletedCount,
      retentionDays
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    await job.log(`Outbox cleanup failed: ${errorMsg}`);
    throw error;
  }
}
