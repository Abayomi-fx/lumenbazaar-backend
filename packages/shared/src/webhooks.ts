import { z } from "zod";
import type { SettlementStatus, NetworkId } from "./models.js";

/**
 * Webhook event schema version.
 * Increment this whenever the payload structure changes materially.
 * Receivers should validate this and reject unknown versions.
 */
export const WEBHOOK_SCHEMA_VERSION = "1.0.0";

/**
 * Webhook event types that trigger deliveries.
 */
export type WebhookEventType =
  | "settlement.pending"
  | "settlement.finalized"
  | "settlement.failed"
  | "settlement.reconciled";

/**
 * Allowlist of fields that are safe to include in webhook payloads.
 * Never spread entire payment or settlement records; only include these fields explicitly.
 */
const ALLOWED_PAYLOAD_FIELDS = [
  "schemaVersion",
  "eventId",
  "eventType",
  "timestamp",
  "paymentId",
  "settlementId",
  "status",
  "network",
  "amount",
  "assetCode",
  "assetIssuer",
  "transactionHash",
  "failureCode",
  "failureReason",
] as const;

export type AllowedPayloadField = (typeof ALLOWED_PAYLOAD_FIELDS)[number];

/**
 * Settlement webhook payload with explicit field mapping.
 * Never include raw payment signatures, authorization entries, or other sensitive fields.
 */
export const webhookPayloadSchema = z.object({
  schemaVersion: z.literal(WEBHOOK_SCHEMA_VERSION),
  eventId: z.string().describe("Stable unique event ID for idempotency"),
  eventType: z.enum([
    "settlement.pending",
    "settlement.finalized",
    "settlement.failed",
    "settlement.reconciled",
  ]),
  timestamp: z.string().datetime().describe("ISO 8601 timestamp (UTC)"),
  paymentId: z.string().describe("Payment attempt ID"),
  settlementId: z.string().describe("Settlement record ID"),
  status: z.enum([
    "pending",
    "submitted",
    "confirmed",
    "settled",
    "timed_out",
    "failed",
  ] as const),
  network: z.string().describe("Network identifier (testnet, mainnet)"),
  amount: z.string().describe("Settlement amount in stroops"),
  assetCode: z.string().describe("Stellar asset code"),
  assetIssuer: z.string().describe("Stellar asset issuer public key"),
  transactionHash: z
    .string()
    .optional()
    .describe("Stellar transaction hash (null until confirmed)"),
  failureCode: z
    .string()
    .optional()
    .describe("Machine-readable failure code if status is failed"),
  failureReason: z
    .string()
    .optional()
    .describe("Human-readable failure reason if status is failed"),
});

export type WebhookPayload = z.infer<typeof webhookPayloadSchema>;

/**
 * Build a webhook payload from a settlement record.
 * Explicitly map only allowlisted fields; never spread the settlement object.
 *
 * @param eventId - Unique stable event identifier
 * @param eventType - Type of event that triggered this webhook
 * @param settlement - Settlement database record (only allowlisted fields are extracted)
 * @param timestamp - Event timestamp in ISO 8601 format
 * @returns Validated webhook payload
 */
export function buildWebhookPayload(
  eventId: string,
  eventType: WebhookEventType,
  settlement: {
    id: string;
    paymentAttemptId: string;
    status: SettlementStatus;
    network: NetworkId;
    amount: string;
    assetCode: string;
    assetIssuer: string;
    transactionHash: string | null;
    failureCode: string | null;
    failureReason: string | null;
  },
  timestamp: string
): WebhookPayload {
  const payload: WebhookPayload = {
    schemaVersion: WEBHOOK_SCHEMA_VERSION,
    eventId,
    eventType,
    timestamp,
    paymentId: settlement.paymentAttemptId,
    settlementId: settlement.id,
    status: settlement.status,
    network: settlement.network,
    amount: settlement.amount,
    assetCode: settlement.assetCode,
    assetIssuer: settlement.assetIssuer,
  };

  // Only include optional fields if they have values
  if (settlement.transactionHash) {
    payload.transactionHash = settlement.transactionHash;
  }
  if (settlement.failureCode) {
    payload.failureCode = settlement.failureCode;
  }
  if (settlement.failureReason) {
    payload.failureReason = settlement.failureReason;
  }

  return webhookPayloadSchema.parse(payload);
}

/**
 * HMAC-SHA256 signature configuration.
 */
export const WEBHOOK_SIGNATURE_ALGORITHM = "sha256";
export const WEBHOOK_SIGNATURE_HEADER = "x-lumenbazaar-signature";
export const WEBHOOK_EVENT_ID_HEADER = "x-lumenbazaar-event-id";
export const WEBHOOK_TIMESTAMP_HEADER = "x-lumenbazaar-timestamp";

/**
 * Compute HMAC-SHA256 signature for webhook delivery.
 * Signature is computed over: `{timestamp}.{rawBody}` where timestamp is the ISO 8601 UTC time.
 *
 * @param secret - Webhook secret (base64 encoded or raw bytes)
 * @param timestamp - ISO 8601 timestamp (must match header)
 * @param rawBody - Raw JSON body as sent to receiver (do not parse/re-encode)
 * @returns Hex-encoded signature
 */
export function computeWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string
): string {
  const crypto = require("crypto");

  // Decode secret if base64 (attempt; if fails, treat as raw string)
  let secretBytes: Buffer;
  try {
    secretBytes = Buffer.from(secret, "base64");
    // Validate that base64 round-trips to avoid collisions
    if (secretBytes.toString("base64") !== secret) {
      secretBytes = Buffer.from(secret);
    }
  } catch {
    secretBytes = Buffer.from(secret);
  }

  const signedContent = `${timestamp}.${rawBody}`;
  const signature = crypto
    .createHmac(WEBHOOK_SIGNATURE_ALGORITHM, secretBytes)
    .update(signedContent)
    .digest("hex");

  return signature;
}

/**
 * Verify webhook signature using constant-time comparison to prevent timing attacks.
 *
 * @param secret - Webhook secret (must match the one used to create signature)
 * @param timestamp - ISO 8601 timestamp from header
 * @param rawBody - Raw JSON body as received
 * @param signature - Hex-encoded signature from header
 * @param replayWindowSeconds - Maximum age of timestamp (default 5 minutes)
 * @returns true if signature is valid and timestamp is within replay window
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  rawBody: string,
  signature: string,
  replayWindowSeconds: number = 300
): boolean {
  const crypto = require("crypto");

  // Verify timestamp is within replay window
  const receivedTime = new Date(timestamp);
  if (isNaN(receivedTime.getTime())) {
    return false;
  }

  const nowTime = new Date();
  const ageSeconds = (nowTime.getTime() - receivedTime.getTime()) / 1000;

  if (ageSeconds < 0 || ageSeconds > replayWindowSeconds) {
    return false;
  }

  // Compute expected signature
  const expectedSignature = computeWebhookSignature(secret, timestamp, rawBody);

  // Constant-time comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(signature, "hex"),
    Buffer.from(expectedSignature, "hex")
  );
}

/**
 * Webhook event record stored in database.
 * Used for idempotency and delivery history.
 */
export type WebhookEvent = {
  id: string;
  eventId: string; // Stable unique event ID (for idempotency)
  sellerId: string;
  eventType: WebhookEventType;
  paymentAttemptId: string;
  settlementId: string;
  status: SettlementStatus;
  payload: WebhookPayload;
  createdAt: string;
};

/**
 * Webhook endpoint configuration (seller-owned).
 */
export type WebhookEndpoint = {
  id: string;
  sellerId: string;
  url: string;
  isActive: boolean;
  lastDeliveryAt: string | null;
  lastDeliveryStatus: number | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Webhook secret record for a specific endpoint.
 * Secrets are stored encrypted and never exposed after creation.
 * During rotation, the previous secret remains valid for an overlap window.
 */
export type WebhookSecret = {
  id: string;
  endpointId: string;
  secretHash: string; // Hash of the secret (never the plaintext)
  isCurrent: boolean; // Only one secret is current per endpoint
  createdAt: string;
  rotatedOutAt: string | null; // When this secret was rotated out (enters overlap window)
};

/**
 * Secret rotation overlap window: time during which the previous secret remains valid.
 * This allows receivers to transition to the new secret gracefully.
 */
export const WEBHOOK_SECRET_ROTATION_OVERLAP_SECONDS = 3600; // 1 hour

/**
 * Webhook delivery attempt record.
 * Captures request/response details (with response body truncated and redacted for security).
 */
export type WebhookDeliveryAttempt = {
  id: string;
  eventId: string;
  endpointId: string;
  attemptNumber: number;
  requestUrl: string;
  requestHeaders: Record<string, string>; // Excludes secret/sensitive auth headers
  statusCode: number | null; // null if connection failed
  responseBodyTruncated: string | null; // Max 500 chars, redacted
  latencyMs: number;
  errorClass: string | null; // e.g., "TimeoutError", "ConnectionRefused"
  createdAt: string;
};

/**
 * Maximum number of delivery retry attempts (including initial attempt).
 */
export const WEBHOOK_MAX_DELIVERY_ATTEMPTS = 5;

/**
 * Request timeout for webhook delivery in milliseconds.
 */
export const WEBHOOK_DELIVERY_REQUEST_TIMEOUT_MS = 10000; // 10 seconds

/**
 * Initial backoff delay for webhook delivery retries (exponential).
 */
export const WEBHOOK_DELIVERY_INITIAL_BACKOFF_MS = 5000; // 5 seconds
