import { type Job } from "bullmq";

import { type PrismaClient } from "@prisma/client";

import {
  getPrismaClient,
  getGlobalRedactionService,
  type PaymentRetentionPolicy,
  DEFAULT_TESTNET_POLICY,
  calculateRecordAge,
  isRecordExpired
} from "@lumenbazaar/shared";

export type StalePaymentCleanupJobData = {
  action: "cleanup_expired" | "cleanup_failed" | "archive";
  maxAgeMs?: number; // How long to keep records (default from policy)
  policy?: PaymentRetentionPolicy; // Optional policy override
};

/**
 * Stale Payment Cleanup Worker
 * 
 * Enforces retention policy on payment records by:
 * 1. Marking stale received attempts as expired
 * 2. Recording retention of failed payments for audit trail
 * 3. Archiving old settled/confirmed payments
 * 
 * All operations are idempotent and auditable. No data is deleted.
 */
export async function handleStalePaymentCleanup(
  job: Job<StalePaymentCleanupJobData>,
  db: PrismaClient = getPrismaClient(),
  policy: PaymentRetentionPolicy = DEFAULT_TESTNET_POLICY
) {
  const { action, maxAgeMs } = job.data;
  const redaction = getGlobalRedactionService();

  // Use custom policy if provided, otherwise use default
  const effectivePolicy = job.data.policy ?? policy;
  const config = effectivePolicy.cleanup;

  try {
    // Determine retention window based on action
    let retentionWindowMs = maxAgeMs;
    if (!retentionWindowMs) {
      if (action === "cleanup_expired") {
        retentionWindowMs = config.expiredPaymentThresholdMs;
      } else if (action === "archive") {
        retentionWindowMs = config.archiveThresholdMs;
      } else {
        retentionWindowMs = config.expiredPaymentThresholdMs; // Default to expired threshold
      }
    }

    const cutoffDate = new Date(Date.now() - retentionWindowMs);

    job.log(
      `Starting ${action} cleanup with retention window of ${retentionWindowMs}ms (cutoff: ${cutoffDate.toISOString()})`
    );

    if (action === "cleanup_expired") {
      await cleanupExpiredPayments(job, db, cutoffDate, config, redaction);
    } else if (action === "cleanup_failed") {
      await cleanupFailedPayments(job, db, cutoffDate, config, redaction);
    } else if (action === "archive") {
      await archiveSettledPayments(job, db, cutoffDate, config, redaction);
    }

    job.log("Financial and audit evidence retention rules applied");
  } catch (err) {
    const errorMsg = redaction.redactJobError(err);
    job.log(`Stale payment cleanup job failed: ${errorMsg}`);
    throw err;
  }
}


/**
 * Clean up expired payment attempts (older than retention window)
 * Idempotent: marking a record as expired multiple times is safe
 */
async function cleanupExpiredPayments(
  job: Job<StalePaymentCleanupJobData>,
  db: PrismaClient,
  cutoffDate: Date,
  config: PaymentRetentionPolicy["cleanup"],
  redaction: ReturnType<typeof getGlobalRedactionService>
): Promise<void> {
  job.log("Cleaning up expired payment attempts");

  let offset = 0;
  let totalExpired = 0;
  let hasMore = true;

  while (hasMore) {
    const expiredAttempts = await db.paymentAttempt.findMany({
      where: {
        status: "received",
        createdAt: { lt: cutoffDate }
      },
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: config.batchSize
    });

    if (expiredAttempts.length === 0) {
      hasMore = false;
      break;
    }

    for (const attempt of expiredAttempts) {
      let retries = 0;
      let success = false;

      while (retries < config.maxRetries && !success) {
        try {
          // Mark as expired (idempotent)
          await db.paymentAttempt.update({
            where: { id: attempt.id },
            data: {
              status: "expired",
              failureCode: "AUTH_EXPIRED",
              failureReason: `Payment authorization expired after ${cutoffDate.getTime()}ms inactivity`
            }
          });

          // Log the expiration in audit trail
          await db.auditLog.create({
            data: {
              actorType: "system",
              action: "payment.attempt.expired",
              targetType: "payment_attempt",
              targetId: attempt.id,
              correlationId: attempt.correlationId,
              metadata: {
                reason: "age_based_expiration",
                originalStatus: "received",
                expirationThresholdMs: cutoffDate.getTime()
              }
            }
          });

          totalExpired++;
          success = true;
        } catch (err) {
          retries++;
          if (retries >= config.maxRetries) {
            const errorMsg = redaction.redactJobError(err);
            job.log(`Failed to expire payment ${attempt.id} after ${config.maxRetries} retries: ${errorMsg}`);
          }
        }
      }
    }

    offset += config.batchSize;
  }

  job.log(`Marked ${totalExpired} payments as expired`);
}

/**
 * Clean up failed payment records
 * Records retention review in audit log for compliance
 * Idempotent: creating multiple audit entries for same payment is tracked by timestamp
 */
async function cleanupFailedPayments(
  job: Job<StalePaymentCleanupJobData>,
  db: PrismaClient,
  cutoffDate: Date,
  config: PaymentRetentionPolicy["cleanup"],
  redaction: ReturnType<typeof getGlobalRedactionService>
): Promise<void> {
  job.log("Reviewing failed payment records for retention");

  let offset = 0;
  let totalRetained = 0;
  let hasMore = true;

  while (hasMore) {
    const failedAttempts = await db.paymentAttempt.findMany({
      where: {
        status: "failed",
        createdAt: { lt: cutoffDate }
      },
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: config.batchSize
    });

    if (failedAttempts.length === 0) {
      hasMore = false;
      break;
    }

    for (const attempt of failedAttempts) {
      let retries = 0;
      let success = false;

      while (retries < config.maxRetries && !success) {
        try {
          // Record retention review in audit log
          await db.auditLog.create({
            data: {
              actorType: "system",
              action: "payment.retention.reviewed",
              targetType: "payment_attempt",
              targetId: attempt.id,
              correlationId: attempt.correlationId,
              metadata: {
                retained: true,
                reason: "financial_evidence_required",
                status: attempt.status,
                failureCode: attempt.failureCode ?? undefined,
                reviewedAt: new Date().toISOString()
              }
            }
          });

          totalRetained++;
          success = true;
        } catch (err) {
          retries++;
          if (retries >= config.maxRetries) {
            const errorMsg = redaction.redactJobError(err);
            job.log(
              `Failed to record retention review for ${attempt.id} after ${config.maxRetries} retries: ${errorMsg}`
            );
          }
        }
      }
    }

    offset += config.batchSize;
  }

  job.log(`Retained ${totalRetained} failed payment records (audit trail created)`);
}

/**
 * Archive old settled/confirmed payments
 * Creates CatalogEvent record to mark payment as archived
 * Original records remain in database (not deleted)
 * Idempotent: check if already archived before creating event
 */
async function archiveSettledPayments(
  job: Job<StalePaymentCleanupJobData>,
  db: PrismaClient,
  cutoffDate: Date,
  config: PaymentRetentionPolicy["cleanup"],
  redaction: ReturnType<typeof getGlobalRedactionService>
): Promise<void> {
  job.log("Archiving old settled payments");

  let offset = 0;
  let totalArchived = 0;
  let hasMore = true;

  while (hasMore) {
    const settledAttempts = await db.paymentAttempt.findMany({
      where: {
        status: {
          in: ["settled", "confirmed"]
        },
        createdAt: { lt: cutoffDate }
      },
      orderBy: { createdAt: "asc" },
      skip: offset,
      take: config.batchSize,
      include: {
        settlement: true,
        receipt: true
      }
    });

    if (settledAttempts.length === 0) {
      hasMore = false;
      break;
    }

    for (const attempt of settledAttempts) {
      let retries = 0;
      let success = false;

      while (retries < config.maxRetries && !success) {
        try {
          // Check if already archived
          const existingArchive = await db.catalogEvent.findFirst({
            where: {
              type: "payment_archived",
              metadata: {
                path: ["paymentAttemptId"],
                equals: attempt.id
              }
            }
          });

          if (!existingArchive) {
            // Record archival in catalog event for audit trail
            await db.catalogEvent.create({
              data: {
                type: "payment_archived",
                status: "success",
                reason: "Archival of settled payment record based on retention policy",
                metadata: {
                  paymentAttemptId: attempt.id,
                  status: attempt.status,
                  settledAt: attempt.settlement?.settledAt?.toISOString(),
                  createdAt: attempt.createdAt.toISOString(),
                  archivedAt: new Date().toISOString()
                }
              }
            });

            totalArchived++;
            job.log(`Archived payment ${attempt.id}`);
          } else {
            job.log(`Payment ${attempt.id} already archived, skipping`);
          }

          success = true;
        } catch (err) {
          retries++;
          if (retries >= config.maxRetries) {
            const errorMsg = redaction.redactJobError(err);
            job.log(
              `Failed to archive payment ${attempt.id} after ${config.maxRetries} retries: ${errorMsg}`
            );
          }
        }
      }
    }

    offset += config.batchSize;
  }

  job.log(`Archived ${totalArchived} settled payment records`);
}
}
