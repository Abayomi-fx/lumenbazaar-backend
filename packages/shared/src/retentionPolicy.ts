import { type PaymentStatus, type PaymentSessionStatus } from "./models.js";

/**
 * Payment Data Retention and Redaction Policy
 * 
 * This file defines the retention windows, sensitive field patterns, and redaction
 * rules for payment data across the LumenRoute backend.
 * 
 * Principles:
 * 1. Financial evidence is retained indefinitely for audit and compliance
 * 2. Sensitive operational fields are redacted at storage, log, and response layers
 * 3. Retention decisions are configurable per environment
 * 4. All cleanup operations are idempotent and auditable
 */

/**
 * Sensitive field patterns that should never be logged or persisted
 * Matched against metadata keys and error message values
 */
export const SENSITIVE_FIELD_PATTERNS = [
  // Secret/credential indicators
  /^(secret|seed|private|token|authorization|password|api[_-]?key)$/i,
  // Blockchain/contract identifiers (linkable to user activity)
  /^(payment[_-]?hash|idempotency[_-]?key|transaction[_-]?hash|contract[_-]?(id|session[_-]?id)|usage[_-]?hash)$/i
] as const;

/**
 * Sensitive value patterns in error messages and logs
 */
export const SENSITIVE_VALUE_PATTERNS = [
  // Bearer tokens
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/giu,
  // Stellar secret keys (start with 'S', followed by 55 Base32 characters)
  /\bS[A-Z2-7]{55}\b/gu,
  // Key-value pairs for sensitive fields
  /\b(secret|seed|token|password|api[_-]?key|private[_-]?key|signing[_-]?key)\s*[=:]\s*[^\s,;]+/giu
] as const;

/**
 * Configuration for which fields to redact from a data object
 */
export interface RedactionConfig {
  /** Pattern to match field names that should be redacted */
  fieldPatterns: RegExp[];
  /** Value patterns that should be redacted from error messages */
  valuePatterns: RegExp[];
  /** Maximum length of error messages after redaction */
  maxErrorMessageLength: number;
}

/**
 * Retention window in milliseconds for different payment data types
 */
export interface RetentionWindows {
  /** Time to keep PaymentAttempt records after creation (default: infinite for financial evidence) */
  paymentAttemptMs: number;
  /** Time to keep failed PaymentAttempt records after failure (default: infinite) */
  failedPaymentAttemptMs: number;
  /** Time to keep expired PaymentAttempt records (default: infinite) */
  expiredPaymentAttemptMs: number;
  /** Time to keep Settlement records (default: infinite for blockchain evidence) */
  settlementMs: number;
  /** Time to keep Receipt records (default: infinite for customer evidence) */
  receiptMs: number;
  /** Time to keep PaymentSession records after settlement/expiration (default: infinite) */
  paymentSessionMs: number;
  /** Time to keep AuditLog records (default: infinite for compliance) */
  auditLogMs: number;
  /** Stale payment age threshold for marking as expired (default: 7 days) */
  stalePaymentAgeMs: number;
  /** Cutoff age for archiving settled/confirmed payments (default: 90 days) */
  archivePaymentAgeMs: number;
}

/**
 * Policy for cleaning up stale payment records
 */
export interface CleanupPolicy {
  /** Enable automatic cleanup of expired payments */
  enableExpiredCleanup: boolean;
  /** Enable archival of settled payments */
  enableArchival: boolean;
  /** Age threshold for marking payments as expired (ms) */
  expiredPaymentThresholdMs: number;
  /** Age threshold for archiving settled payments (ms) */
  archiveThresholdMs: number;
  /** Whether to run cleanup as a background job */
  runAsBackgroundJob: boolean;
  /** Cleanup job batch size (number of records to process per iteration) */
  batchSize: number;
  /** Maximum number of cleanup retries on failure */
  maxRetries: number;
}

/**
 * Full payment data retention policy configuration
 */
export interface PaymentRetentionPolicy {
  /** Whether the policy is active */
  enabled: boolean;
  /** Environment name (e.g., "testnet", "mainnet") */
  environment: "local" | "testnet" | "staging" | "mainnet";
  /** Retention windows for different data types */
  retentionWindows: RetentionWindows;
  /** Cleanup policy configuration */
  cleanup: CleanupPolicy;
  /** Redaction configuration */
  redaction: RedactionConfig;
}

/**
 * Default retention policy for testnet/development
 * In development, retention is effectively infinite; cleanup is disabled
 */
export const DEFAULT_TESTNET_POLICY: PaymentRetentionPolicy = {
  enabled: true,
  environment: "testnet",
  retentionWindows: {
    // All windows set to effectively infinite (1000 years)
    paymentAttemptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    failedPaymentAttemptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    expiredPaymentAttemptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    settlementMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    receiptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    paymentSessionMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    auditLogMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    // Mark payments as expired after 7 days of inactivity
    stalePaymentAgeMs: 7 * 24 * 60 * 60 * 1000,
    // Archive settled payments after 90 days
    archivePaymentAgeMs: 90 * 24 * 60 * 60 * 1000
  },
  cleanup: {
    enableExpiredCleanup: true,
    enableArchival: true,
    expiredPaymentThresholdMs: 7 * 24 * 60 * 60 * 1000,
    archiveThresholdMs: 90 * 24 * 60 * 60 * 1000,
    runAsBackgroundJob: true,
    batchSize: 100,
    maxRetries: 3
  },
  redaction: {
    fieldPatterns: Array.from(SENSITIVE_FIELD_PATTERNS),
    valuePatterns: Array.from(SENSITIVE_VALUE_PATTERNS),
    maxErrorMessageLength: 500
  }
};

/**
 * Default retention policy for mainnet production
 * Longer archival window and stricter batch sizes for production stability
 */
export const DEFAULT_MAINNET_POLICY: PaymentRetentionPolicy = {
  enabled: true,
  environment: "mainnet",
  retentionWindows: {
    // Mainnet: all records retained indefinitely for compliance
    paymentAttemptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    failedPaymentAttemptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    expiredPaymentAttemptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    settlementMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    receiptMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    paymentSessionMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    auditLogMs: 1000 * 365.25 * 24 * 60 * 60 * 1000,
    // Mark payments as expired after 7 days
    stalePaymentAgeMs: 7 * 24 * 60 * 60 * 1000,
    // Archive after 180 days (6 months) for mainnet
    archivePaymentAgeMs: 180 * 24 * 60 * 60 * 1000
  },
  cleanup: {
    enableExpiredCleanup: true,
    enableArchival: true,
    expiredPaymentThresholdMs: 7 * 24 * 60 * 60 * 1000,
    archiveThresholdMs: 180 * 24 * 60 * 60 * 1000,
    runAsBackgroundJob: true,
    batchSize: 50, // Smaller batch for production safety
    maxRetries: 5
  },
  redaction: {
    fieldPatterns: Array.from(SENSITIVE_FIELD_PATTERNS),
    valuePatterns: Array.from(SENSITIVE_VALUE_PATTERNS),
    maxErrorMessageLength: 300 // Stricter limit for production
  }
};

/**
 * Get the default policy for a given environment
 */
export function getDefaultPolicy(
  environment: PaymentRetentionPolicy["environment"]
): PaymentRetentionPolicy {
  switch (environment) {
    case "mainnet":
    case "staging":
      return DEFAULT_MAINNET_POLICY;
    case "testnet":
    case "local":
      return DEFAULT_TESTNET_POLICY;
    default:
      const _exhaustive: never = environment;
      return _exhaustive;
  }
}

/**
 * Determine if a field name should be redacted based on policy
 */
export function shouldRedactField(fieldName: string, policy: PaymentRetentionPolicy): boolean {
  return policy.redaction.fieldPatterns.some((pattern) => pattern.test(fieldName));
}

/**
 * Determine if a payment status should trigger immediate cleanup
 */
export function shouldCleanupStatus(
  status: PaymentStatus | PaymentSessionStatus
): boolean {
  return status === "expired" || status === "failed" || status === "cancelled";
}

/**
 * Calculate the age of a record in milliseconds
 */
export function calculateRecordAge(createdAtIso: string): number {
  const createdAt = new Date(createdAtIso);
  const now = new Date();
  return now.getTime() - createdAt.getTime();
}

/**
 * Check if a record exceeds its retention window
 */
export function isRecordExpired(
  createdAtIso: string,
  retentionWindowMs: number
): boolean {
  return calculateRecordAge(createdAtIso) > retentionWindowMs;
}

/**
 * Justification for retention windows
 */
export const RETENTION_JUSTIFICATION = {
  paymentAttempt: "Retained indefinitely for audit trail, replay protection, and financial reconciliation",
  settlement: "Retained indefinitely as immutable blockchain evidence for dispute resolution",
  receipt: "Retained indefinitely for customer evidence and proof of payment",
  paymentSession: "Retained indefinitely for Upto scheme session history and reconciliation",
  auditLog: "Retained indefinitely for compliance, non-repudiation, and investigation",
  stalePaymentCleanup: "Payments marked as expired after 7 days of inactivity to manage active payment lifecycle",
  archival: "Settled payments marked as archived after 90+ days to distinguish active vs. historical records"
};
