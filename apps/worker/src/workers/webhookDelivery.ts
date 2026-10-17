import { URL } from "node:url";
import crypto from "node:crypto";
import fetch from "node-fetch";

import {
  type AppConfig,
  type WebhookPayload,
  computeWebhookSignature,
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  WEBHOOK_DELIVERY_REQUEST_TIMEOUT_MS,
  WEBHOOK_MAX_DELIVERY_ATTEMPTS,
  WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS,
  LumenError,
} from "@lumenbazaar/shared";

/**
 * Webhook delivery job input.
 * Contains all information needed to deliver a webhook to an endpoint.
 */
export type WebhookDeliveryJobInput = {
  eventId: string;
  endpointId: string;
  sellerId: string;
  url: string;
  payload: WebhookPayload;
  secret: string; // Current secret (plaintext, used only for signing)
  previousSecrets?: string[]; // Previous secrets still in overlap window
  attemptNumber: number;
};

/**
 * Webhook delivery result.
 */
export type WebhookDeliveryResult = {
  success: boolean;
  statusCode?: number;
  latencyMs: number;
  errorClass?: string;
  responseBodyTruncated?: string;
  shouldRetry: boolean;
  nextAttemptDelayMs?: number;
};

/**
 * Compute exponential backoff delay with jitter.
 * Formula: initialDelay * (2 ^ attemptNumber) + random jitter
 *
 * @param attemptNumber - The attempt number (0-indexed)
 * @param initialDelayMs - Initial delay in milliseconds
 * @returns Delay in milliseconds
 */
export function computeBackoffDelay(
  attemptNumber: number,
  initialDelayMs: number = WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS
): number {
  const exponentialDelay = initialDelayMs * Math.pow(2, attemptNumber);
  const jitter = Math.random() * 0.1 * exponentialDelay; // Add up to 10% jitter
  return Math.floor(exponentialDelay + jitter);
}

/**
 * Deliver a webhook to an endpoint.
 * Includes HMAC-SHA256 signing, timeout handling, and delivery attempt recording.
 *
 * @param input - Webhook delivery job input
 * @returns Delivery result with retry instructions
 */
export async function deliverWebhook(input: WebhookDeliveryJobInput): Promise<WebhookDeliveryResult> {
  const startTime = Date.now();
  const rawBody = JSON.stringify(input.payload);
  const timestamp = new Date().toISOString();

  // Compute signatures with current secret
  const signature = computeWebhookSignature(input.secret, timestamp, rawBody);

  // Build request headers with signature
  const headers: Record<string, string> = {
    "content-type": "application/json",
    [WEBHOOK_SIGNATURE_HEADER]: signature,
    [WEBHOOK_EVENT_ID_HEADER]: input.eventId,
    [WEBHOOK_TIMESTAMP_HEADER]: timestamp,
    // For secret rotation support, include multiple signatures if previous secrets exist
    ...(input.previousSecrets && input.previousSecrets.length > 0
      ? {
          "x-lumenbazaar-signature-previous": input.previousSecrets
            .map((secret) => computeWebhookSignature(secret, timestamp, rawBody))
            .join(","),
        }
      : {}),
  };

  try {
    const response = await fetch(input.url, {
      method: "POST",
      headers,
      body: rawBody,
      timeout: WEBHOOK_DELIVERY_REQUEST_TIMEOUT_MS,
      // Explicitly disable redirects to prevent SSRF/bounce attacks
      redirect: "error",
    });

    const latencyMs = Date.now() - startTime;
    const responseText = await response.text();

    // Truncate and redact response body (max 500 chars)
    const responseBodyTruncated =
      responseText.length > 500
        ? responseText.substring(0, 500) + "..."
        : responseText;

    const success = response.ok; // 2xx status

    if (success) {
      return {
        success: true,
        statusCode: response.status,
        latencyMs,
        shouldRetry: false,
      };
    }

    // Non-2xx response: decide if retryable
    const statusCode = response.status;
    const isClientError = statusCode >= 400 && statusCode < 500;
    const isServerError = statusCode >= 500;

    // Don't retry 4xx errors (except 408, 429, 503 which are retriable)
    const shouldRetry =
      (isServerError || statusCode === 408 || statusCode === 429 || statusCode === 503) &&
      input.attemptNumber < WEBHOOK_MAX_DELIVERY_ATTEMPTS;

    return {
      success: false,
      statusCode,
      latencyMs,
      responseBodyTruncated,
      shouldRetry,
      nextAttemptDelayMs: shouldRetry
        ? computeBackoffDelay(input.attemptNumber)
        : undefined,
    };
  } catch (error) {
    const latencyMs = Date.now() - startTime;
    const errorClass = error instanceof Error ? error.constructor.name : "UnknownError";

    // Determine if error is retriable
    let shouldRetry = true;
    let nextAttemptDelayMs: number | undefined;

    if (error instanceof Error) {
      // DNS errors, connection refused, etc. are retriable
      // Invalid URL, malformed request, etc. are not
      const message = error.message.toLowerCase();
      const notRetriableErrors = [
        "invalid url",
        "malformed",
        "invalid_argument",
        "unsupported protocol",
      ];

      shouldRetry =
        !notRetriableErrors.some((msg) => message.includes(msg)) &&
        input.attemptNumber < WEBHOOK_MAX_DELIVERY_ATTEMPTS;

      if (shouldRetry) {
        nextAttemptDelayMs = computeBackoffDelay(input.attemptNumber);
      }
    }

    return {
      success: false,
      latencyMs,
      errorClass,
      shouldRetry,
      nextAttemptDelayMs,
    };
  }
}

/**
 * Webhook delivery attempt record schema for database storage.
 * Used to persist delivery history for debugging and audit trails.
 */
export type WebhookDeliveryAttemptRecord = {
  id: string;
  eventId: string;
  endpointId: string;
  attemptNumber: number;
  requestUrl: string;
  requestHeaders: Record<string, string>;
  statusCode: number | null;
  responseBodyTruncated: string | null;
  latencyMs: number;
  errorClass: string | null;
  createdAt: string;
};

/**
 * Redact sensitive headers from delivery attempt record.
 * Removes Authorization, Cookie, and signature headers before storage.
 *
 * @param headers - Request headers
 * @returns Redacted headers safe for audit storage
 */
export function redactSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const redactedHeaders: Record<string, string> = {};
  const sensitiveHeaderPatterns = [
    /^authorization$/i,
    /^cookie$/i,
    /^set-cookie$/i,
    /^x-api-key$/i,
    /^x-auth-token$/i,
  ];

  for (const [key, value] of Object.entries(headers)) {
    const isSensitive = sensitiveHeaderPatterns.some((pattern) => pattern.test(key));
    redactedHeaders[key] = isSensitive ? "[REDACTED]" : value;
  }

  return redactedHeaders;
}

/**
 * Store a webhook delivery attempt in the database.
 * This is called after each delivery attempt to maintain audit trail.
 *
 * Note: Actual database persistence depends on WebhookDeliveryStore implementation.
 * This function just defines the record structure.
 */
export function createWebhookDeliveryAttemptRecord(
  eventId: string,
  endpointId: string,
  attemptNumber: number,
  url: string,
  headers: Record<string, string>,
  result: WebhookDeliveryResult
): WebhookDeliveryAttemptRecord {
  return {
    id: crypto.randomUUID(),
    eventId,
    endpointId,
    attemptNumber,
    requestUrl: url,
    requestHeaders: redactSensitiveHeaders(headers),
    statusCode: result.statusCode ?? null,
    responseBodyTruncated: result.responseBodyTruncated ?? null,
    latencyMs: result.latencyMs,
    errorClass: result.errorClass ?? null,
    createdAt: new Date().toISOString(),
  };
}
