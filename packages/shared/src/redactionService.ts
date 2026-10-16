import { redactSensitiveText } from "./redaction.js";
import { shouldRedactField, type PaymentRetentionPolicy } from "./retentionPolicy.js";
import { type JsonObject, type JsonValue } from "./models.js";

/**
 * Service for applying redaction rules to payment data at multiple layers:
 * - Storage (metadata sanitization)
 * - Output (error responses, structured logs)
 * - Operational logs (worker job logs)
 */
export class RedactionService {
  constructor(private readonly policy: PaymentRetentionPolicy) {}

  /**
   * Sanitize metadata for storage, redacting sensitive keys and values
   */
  sanitizeMetadata(metadata: Record<string, unknown>): JsonObject {
    return Object.fromEntries(
      Object.entries(metadata).map(([key, value]) => [
        key,
        shouldRedactField(key, this.policy) ? "[redacted]" : this.toJsonValue(value)
      ])
    ) as JsonObject;
  }

  /**
   * Redact sensitive fields from an object for display/logging
   */
  redactObject(obj: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(obj).map(([key, value]) => [
        key,
        shouldRedactField(key, this.policy) ? "[redacted]" : this.redactNestedValue(value)
      ])
    );
  }

  /**
   * Redact error details for HTTP responses
   */
  redactErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
    const redacted = this.redactObject(details);
    return this.truncateErrorDetails(redacted);
  }

  /**
   * Redact text in error messages (e.g., stack traces, logs)
   * Applies value pattern matching to remove tokens, keys, etc.
   */
  redactErrorMessage(message: string): string {
    const redacted = redactSensitiveText(message);
    return this.truncateErrorMessage(redacted);
  }

  /**
   * Redact error for worker job logging
   * Includes message redaction and optional truncation
   */
  redactJobError(error: Error | string): string {
    const message = typeof error === "string" ? error : error.message;
    return this.redactErrorMessage(message);
  }

  /**
   * Redact a payment-related object (attempts, sessions, receipts, etc.)
   * Handles nested structures and applies field and value redaction
   */
  redactPaymentRecord<T extends Record<string, unknown>>(record: T): T {
    const redacted = this.redactObject(record) as T;
    return redacted;
  }

  /**
   * Check if a given field value should be redacted
   */
  isFieldRedacted(fieldName: string): boolean {
    return shouldRedactField(fieldName, this.policy);
  }

  /**
   * Get redaction status for diagnostics
   */
  getRedactionStatus(): {
    enabled: boolean;
    environment: string;
    fieldPatternsCount: number;
    valuePatternCount: number;
    maxErrorMessageLength: number;
  } {
    return {
      enabled: this.policy.enabled,
      environment: this.policy.environment,
      fieldPatternsCount: this.policy.redaction.fieldPatterns.length,
      valuePatternCount: this.policy.redaction.valuePatterns.length,
      maxErrorMessageLength: this.policy.redaction.maxErrorMessageLength
    };
  }

  /**
   * Internal: Convert a value to JSON-safe type with redaction
   */
  private toJsonValue(value: unknown): JsonValue {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (typeof value === "string") {
      return redactSensitiveText(value);
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.toJsonValue(item));
    }

    if (typeof value === "object") {
      return this.sanitizeMetadata(value as Record<string, unknown>);
    }

    return String(value);
  }

  /**
   * Internal: Redact nested values in objects
   */
  private redactNestedValue(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.redactNestedValue(item));
    }

    if (value !== null && typeof value === "object") {
      return this.redactObject(value as Record<string, unknown>);
    }

    return value;
  }

  /**
   * Internal: Truncate error details to prevent log spam
   */
  private truncateErrorDetails(details: Record<string, unknown>): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(details)) {
      if (typeof value === "string" && value.length > this.policy.redaction.maxErrorMessageLength) {
        result[key] = value.slice(0, this.policy.redaction.maxErrorMessageLength) + "...";
      } else {
        result[key] = value;
      }
    }

    return result;
  }

  /**
   * Internal: Truncate error message after redaction
   */
  private truncateErrorMessage(message: string): string {
    if (message.length > this.policy.redaction.maxErrorMessageLength) {
      return message.slice(0, this.policy.redaction.maxErrorMessageLength) + "...";
    }
    return message;
  }
}

/**
 * Factory function to create a redaction service from a policy or environment
 */
export function createRedactionService(
  policyOrEnvironment: PaymentRetentionPolicy | "local" | "testnet" | "staging" | "mainnet"
): RedactionService {
  if (typeof policyOrEnvironment === "string") {
    // Import here to avoid circular dependency at module load time
    const { getDefaultPolicy } = require("./retentionPolicy.js") as {
      getDefaultPolicy: (env: string) => PaymentRetentionPolicy;
    };
    const policy = getDefaultPolicy(policyOrEnvironment);
    return new RedactionService(policy);
  }

  return new RedactionService(policyOrEnvironment);
}

/**
 * Singleton instance for use across the application
 * This is lazily initialized and can be replaced for testing
 */
let globalRedactionService: RedactionService | null = null;

export function setGlobalRedactionService(service: RedactionService): void {
  globalRedactionService = service;
}

export function getGlobalRedactionService(): RedactionService {
  if (!globalRedactionService) {
    // Default to testnet policy if not explicitly set
    globalRedactionService = createRedactionService("testnet");
  }
  return globalRedactionService;
}

/**
 * Initialize the global redaction service with a specific policy
 */
export function initializeRedactionService(
  policy: PaymentRetentionPolicy
): RedactionService {
  const service = new RedactionService(policy);
  setGlobalRedactionService(service);
  return service;
}
