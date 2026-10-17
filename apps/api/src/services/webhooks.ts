import { randomUUID } from "node:crypto";
import { URL } from "node:url";
import crypto from "node:crypto";
import { z } from "zod";

import {
  LumenError,
  type WebhookEndpoint,
  type WebhookSecret,
  WEBHOOK_SECRET_ROTATION_OVERLAP_SECONDS,
} from "@lumenbazaar/shared";

import { type AuditLogService } from "./audit.js";

/**
 * Validate that a webhook URL is safe from SSRF attacks.
 * - Must use HTTPS
 * - Must not contain credentials (user:pass)
 * - Must not resolve to private/loopback/link-local/metadata addresses
 * - Must not have redirects enabled on delivery
 *
 * @param urlString - The webhook URL to validate
 * @throws LumenError if URL is invalid
 */
export function validateWebhookUrl(urlString: string): URL {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch (e) {
    throw new LumenError("VALIDATION_FAILED", "Webhook URL is not a valid URL.");
  }

  // Must use HTTPS
  if (url.protocol !== "https:") {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Webhook URL must use HTTPS protocol."
    );
  }

  // Must not contain credentials
  if (url.username || url.password) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Webhook URL must not contain credentials."
    );
  }

  // Extract hostname for IP checking
  const hostname = url.hostname;

  // Check for private/loopback/link-local/metadata IP ranges
  // IPv4: 127.x, 10.x, 172.16-31.x, 192.168.x, 169.254.x, 169.254.169.254 (metadata)
  // IPv6: ::1 (loopback), fe80:: (link-local), fc00:: (ULA)
  const privateIpPatterns = [
    /^127\./, // Loopback
    /^10\./, // Private
    /^172\.(1[6-9]|2[0-9]|3[01])\./, // Private
    /^192\.168\./, // Private
    /^169\.254\./, // Link-local
    /^::1$/, // IPv6 loopback
    /^fe80:/, // IPv6 link-local
    /^fc00:/, // IPv6 ULA
    /^fd00:/, // IPv6 ULA
  ];

  if (privateIpPatterns.some((pattern) => pattern.test(hostname))) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Webhook URL resolves to a private or loopback address."
    );
  }

  // Reject localhost by name
  if (
    hostname === "localhost" ||
    hostname === "localhost.localdomain" ||
    hostname === "0.0.0.0" ||
    hostname === "::" ||
    hostname === "[::]"
  ) {
    throw new LumenError(
      "VALIDATION_FAILED",
      "Webhook URL resolves to localhost or all-hosts address."
    );
  }

  return url;
}

/**
 * Hash a webhook secret for secure storage.
 * Never store the plaintext secret in the database.
 *
 * @param plaintext - The plaintext secret
 * @returns Base64-encoded SHA256 hash
 */
export function hashWebhookSecret(plaintext: string): string {
  return crypto.createHash("sha256").update(plaintext).digest("base64");
}

/**
 * Generate a new webhook secret (random 32-byte value).
 *
 * @returns Base64-encoded secret
 */
export function generateWebhookSecret(): string {
  return crypto.randomBytes(32).toString("base64");
}

export const createWebhookEndpointSchema = z.object({
  url: z.string().trim().url(),
  isActive: z.boolean().default(true),
});

export type CreateWebhookEndpointInput = z.infer<typeof createWebhookEndpointSchema>;

export const updateWebhookEndpointSchema = z.object({
  url: z.string().trim().url().optional(),
  isActive: z.boolean().optional(),
});

export type UpdateWebhookEndpointInput = z.infer<typeof updateWebhookEndpointSchema>;

export type WebhookStore = {
  createWebhookEndpoint: (
    sellerId: string,
    url: string
  ) => Promise<WebhookEndpoint & { secret: string }>;
  getWebhookEndpoint: (endpointId: string) => Promise<WebhookEndpoint | undefined>;
  listWebhookEndpoints: (
    sellerId: string,
    limit: number,
    offset: number
  ) => Promise<{ endpoints: WebhookEndpoint[]; total: number }>;
  updateWebhookEndpoint: (
    endpointId: string,
    updates: Partial<Pick<WebhookEndpoint, "url" | "isActive">>
  ) => Promise<WebhookEndpoint>;
  deleteWebhookEndpoint: (endpointId: string) => Promise<void>;
  getCurrentSecret: (endpointId: string) => Promise<WebhookSecret | undefined>;
  rotateSecret: (
    endpointId: string
  ) => Promise<WebhookSecret & { secret: string }>;
  getValidSecrets: (
    endpointId: string
  ) => Promise<Array<WebhookSecret & { secret?: string }>>;
  updateLastDelivery: (
    endpointId: string,
    statusCode: number,
    timestamp: Date
  ) => Promise<void>;
};

/**
 * In-memory webhook store for testing and development.
 */
export class InMemoryWebhookStore implements WebhookStore {
  private readonly endpoints = new Map<
    string,
    WebhookEndpoint & { secretId: string }
  >();
  private readonly secrets = new Map<string, WebhookSecret & { secret: string }>();

  async createWebhookEndpoint(
    sellerId: string,
    url: string
  ): Promise<WebhookEndpoint & { secret: string }> {
    const endpointId = `webhook_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
    const secretId = `webhook_secret_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 24)}`;
    const secret = generateWebhookSecret();
    const now = new Date();

    const endpoint: WebhookEndpoint & { secretId: string } = {
      id: endpointId,
      sellerId,
      url,
      isActive: true,
      lastDeliveryAt: null,
      lastDeliveryStatus: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      secretId,
    };

    const webhookSecret: WebhookSecret & { secret: string } = {
      id: secretId,
      endpointId,
      secretHash: hashWebhookSecret(secret),
      isCurrent: true,
      createdAt: now.toISOString(),
      rotatedOutAt: null,
      secret,
    };

    this.endpoints.set(endpointId, endpoint);
    this.secrets.set(secretId, webhookSecret);

    return {
      ...endpoint,
      secret,
    };
  }

  async getWebhookEndpoint(endpointId: string): Promise<WebhookEndpoint | undefined> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) return undefined;
    const { secretId, ...rest } = endpoint;
    return rest;
  }

  async listWebhookEndpoints(
    sellerId: string,
    limit: number,
    offset: number
  ): Promise<{ endpoints: WebhookEndpoint[]; total: number }> {
    const all = Array.from(this.endpoints.values())
      .filter((e) => e.sellerId === sellerId)
      .sort((a, b) => {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return bTime - aTime;
      });

    const endpoints = all.slice(offset, offset + limit).map(({ secretId, ...rest }) => rest);
    return { endpoints, total: all.length };
  }

  async updateWebhookEndpoint(
    endpointId: string,
    updates: Partial<Pick<WebhookEndpoint, "url" | "isActive">>
  ): Promise<WebhookEndpoint> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new LumenError("WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook endpoint was not found.");
    }

    const updated: WebhookEndpoint & { secretId: string } = {
      ...endpoint,
      ...updates,
      updatedAt: new Date().toISOString(),
    };

    this.endpoints.set(endpointId, updated);
    const { secretId, ...rest } = updated;
    return rest;
  }

  async deleteWebhookEndpoint(endpointId: string): Promise<void> {
    this.endpoints.delete(endpointId);
    // Also delete secrets for this endpoint
    for (const [secretId, secret] of this.secrets.entries()) {
      if (secret.endpointId === endpointId) {
        this.secrets.delete(secretId);
      }
    }
  }

  async getCurrentSecret(endpointId: string): Promise<WebhookSecret | undefined> {
    for (const secret of this.secrets.values()) {
      if (secret.endpointId === endpointId && secret.isCurrent) {
        const { secret: _, ...rest } = secret;
        return rest;
      }
    }
    return undefined;
  }

  async rotateSecret(
    endpointId: string
  ): Promise<WebhookSecret & { secret: string }> {
    const endpoint = this.endpoints.get(endpointId);
    if (!endpoint) {
      throw new LumenError("WEBHOOK_ENDPOINT_NOT_FOUND", "Webhook endpoint was not found.");
    }

    const now = new Date();

    // Mark current secret as rotated out
    for (const [secretId, secret] of this.secrets.entries()) {
      if (secret.endpointId === endpointId && secret.isCurrent) {
        secret.isCurrent = false;
        secret.rotatedOutAt = now.toISOString();
        this.secrets.set(secretId, secret);
      }
    }

    // Create new current secret
    const newSecretId = `webhook_secret_${randomUUID()
      .replaceAll("-", "")
      .slice(0, 24)}`;
    const secret = generateWebhookSecret();
    const newSecret: WebhookSecret & { secret: string } = {
      id: newSecretId,
      endpointId,
      secretHash: hashWebhookSecret(secret),
      isCurrent: true,
      createdAt: now.toISOString(),
      rotatedOutAt: null,
      secret,
    };

    this.secrets.set(newSecretId, newSecret);
    endpoint.secretId = newSecretId;
    this.endpoints.set(endpointId, endpoint);

    return newSecret;
  }

  async getValidSecrets(
    endpointId: string
  ): Promise<Array<WebhookSecret & { secret?: string }>> {
    const now = Date.now();
    const result: Array<WebhookSecret & { secret?: string }> = [];

    for (const secret of this.secrets.values()) {
      if (secret.endpointId === endpointId) {
        if (secret.isCurrent) {
          // Current secret is always valid (exclude plaintext for this query)
          const { secret: _, ...rest } = secret;
          result.push(rest);
        } else if (secret.rotatedOutAt) {
          // Check if rotated secret is still within overlap window
          const rotatedTime = new Date(secret.rotatedOutAt).getTime();
          const ageSeconds = (now - rotatedTime) / 1000;
          if (ageSeconds <= WEBHOOK_SECRET_ROTATION_OVERLAP_SECONDS) {
            // Still valid; exclude plaintext
            const { secret: _, ...rest } = secret;
            result.push(rest);
          }
        }
      }
    }

    return result;
  }

  async updateLastDelivery(
    endpointId: string,
    statusCode: number,
    timestamp: Date
  ): Promise<void> {
    const endpoint = this.endpoints.get(endpointId);
    if (endpoint) {
      endpoint.lastDeliveryAt = timestamp.toISOString();
      endpoint.lastDeliveryStatus = statusCode;
      endpoint.updatedAt = new Date().toISOString();
      this.endpoints.set(endpointId, endpoint);
    }
  }
}

export class WebhookService {
  constructor(
    private readonly store: WebhookStore = new InMemoryWebhookStore(),
    private readonly auditLogService?: AuditLogService
  ) {}

  async createWebhookEndpoint(
    sellerId: string,
    input: unknown
  ): Promise<WebhookEndpoint & { secret: string }> {
    const request = createWebhookEndpointSchema.parse(input);

    // Validate URL for SSRF
    validateWebhookUrl(request.url);

    const result = await this.store.createWebhookEndpoint(sellerId, request.url);

    await this.auditLogService?.record({
      action: "webhook.endpoint.created",
      actorId: sellerId,
      actorType: "seller",
      targetId: result.id,
      targetType: "webhook_endpoint",
      metadata: {
        url: request.url,
        isActive: request.isActive,
      },
    });

    return result;
  }

  async getWebhookEndpoint(sellerId: string, endpointId: string): Promise<WebhookEndpoint> {
    const endpoint = await this.store.getWebhookEndpoint(endpointId);

    if (!endpoint || endpoint.sellerId !== sellerId) {
      throw new LumenError(
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "Webhook endpoint was not found."
      );
    }

    return endpoint;
  }

  async listWebhookEndpoints(
    sellerId: string,
    limit: number,
    offset: number
  ): Promise<{ endpoints: WebhookEndpoint[]; total: number }> {
    return this.store.listWebhookEndpoints(sellerId, limit, offset);
  }

  async updateWebhookEndpoint(
    sellerId: string,
    endpointId: string,
    input: unknown
  ): Promise<WebhookEndpoint> {
    const endpoint = await this.store.getWebhookEndpoint(endpointId);

    if (!endpoint || endpoint.sellerId !== sellerId) {
      throw new LumenError(
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "Webhook endpoint was not found."
      );
    }

    const request = updateWebhookEndpointSchema.parse(input);

    // Validate new URL if provided
    if (request.url) {
      validateWebhookUrl(request.url);
    }

    const updated = await this.store.updateWebhookEndpoint(endpointId, request);

    await this.auditLogService?.record({
      action: "webhook.endpoint.updated",
      actorId: sellerId,
      actorType: "seller",
      targetId: endpointId,
      targetType: "webhook_endpoint",
      metadata: {
        changes: request,
      },
    });

    return updated;
  }

  async deleteWebhookEndpoint(sellerId: string, endpointId: string): Promise<void> {
    const endpoint = await this.store.getWebhookEndpoint(endpointId);

    if (!endpoint || endpoint.sellerId !== sellerId) {
      throw new LumenError(
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "Webhook endpoint was not found."
      );
    }

    await this.store.deleteWebhookEndpoint(endpointId);

    await this.auditLogService?.record({
      action: "webhook.endpoint.deleted",
      actorId: sellerId,
      actorType: "seller",
      targetId: endpointId,
      targetType: "webhook_endpoint",
      metadata: {
        url: endpoint.url,
      },
    });
  }

  async rotateSecret(sellerId: string, endpointId: string): Promise<WebhookSecret & { secret: string }> {
    const endpoint = await this.store.getWebhookEndpoint(endpointId);

    if (!endpoint || endpoint.sellerId !== sellerId) {
      throw new LumenError(
        "WEBHOOK_ENDPOINT_NOT_FOUND",
        "Webhook endpoint was not found."
      );
    }

    const rotated = await this.store.rotateSecret(endpointId);

    await this.auditLogService?.record({
      action: "webhook.secret.rotated",
      actorId: sellerId,
      actorType: "seller",
      targetId: endpointId,
      targetType: "webhook_endpoint",
      metadata: {
        newSecretId: rotated.id,
        rotationOverlapSeconds: WEBHOOK_SECRET_ROTATION_OVERLAP_SECONDS,
      },
    });

    return rotated;
  }

  getStore() {
    return this.store;
  }
}
