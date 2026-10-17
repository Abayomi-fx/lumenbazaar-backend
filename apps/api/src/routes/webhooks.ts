import { type FastifyInstance } from "fastify";
import { z } from "zod";

import { parseBody, parseParams, parseQuery } from "../http/validation.js";
import { WebhookService } from "../services/webhooks.js";

export type WebhookRouteOptions = {
  webhookService?: WebhookService;
};

export function registerWebhookRoutes(
  app: FastifyInstance,
  options: WebhookRouteOptions = {}
) {
  const webhookService = options.webhookService ?? new WebhookService();

  /**
   * POST /v1/sellers/:sellerId/webhooks
   * Create a new webhook endpoint for a seller.
   * Returns the endpoint and a one-time secret (shown only once).
   */
  app.post("/v1/sellers/:sellerId/webhooks", async (request) => {
    const params = parseParams(
      request,
      z.object({ sellerId: z.string().min(1) })
    );
    return webhookService.createWebhookEndpoint(
      params.sellerId,
      parseBody(request, z.unknown())
    );
  });

  /**
   * GET /v1/sellers/:sellerId/webhooks
   * List all webhook endpoints for a seller (paginated).
   */
  app.get("/v1/sellers/:sellerId/webhooks", async (request) => {
    const params = parseParams(
      request,
      z.object({ sellerId: z.string().min(1) })
    );
    const query = parseQuery(
      request,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
    );
    return webhookService.listWebhookEndpoints(
      params.sellerId,
      query.limit,
      query.offset
    );
  });

  /**
   * GET /v1/sellers/:sellerId/webhooks/:endpointId
   * Get details about a specific webhook endpoint.
   * Note: The endpoint does not include the secret (never exposed after creation).
   */
  app.get("/v1/sellers/:sellerId/webhooks/:endpointId", async (request) => {
    const params = parseParams(
      request,
      z.object({
        sellerId: z.string().min(1),
        endpointId: z.string().min(1),
      })
    );
    return webhookService.getWebhookEndpoint(params.sellerId, params.endpointId);
  });

  /**
   * PATCH /v1/sellers/:sellerId/webhooks/:endpointId
   * Update a webhook endpoint (url, isActive).
   */
  app.patch("/v1/sellers/:sellerId/webhooks/:endpointId", async (request) => {
    const params = parseParams(
      request,
      z.object({
        sellerId: z.string().min(1),
        endpointId: z.string().min(1),
      })
    );
    return webhookService.updateWebhookEndpoint(
      params.sellerId,
      params.endpointId,
      parseBody(request, z.unknown())
    );
  });

  /**
   * DELETE /v1/sellers/:sellerId/webhooks/:endpointId
   * Delete a webhook endpoint and all its delivery history.
   */
  app.delete("/v1/sellers/:sellerId/webhooks/:endpointId", async (request) => {
    const params = parseParams(
      request,
      z.object({
        sellerId: z.string().min(1),
        endpointId: z.string().min(1),
      })
    );
    await webhookService.deleteWebhookEndpoint(params.sellerId, params.endpointId);
    return { success: true };
  });

  /**
   * POST /v1/sellers/:sellerId/webhooks/:endpointId/rotate-secret
   * Rotate the webhook secret. The new secret is returned (shown only once).
   * The previous secret remains valid for WEBHOOK_SECRET_ROTATION_OVERLAP_SECONDS.
   */
  app.post(
    "/v1/sellers/:sellerId/webhooks/:endpointId/rotate-secret",
    async (request) => {
      const params = parseParams(
        request,
        z.object({
          sellerId: z.string().min(1),
          endpointId: z.string().min(1),
        })
      );
      return webhookService.rotateSecret(params.sellerId, params.endpointId);
    }
  );

  /**
   * GET /v1/sellers/:sellerId/webhooks/:endpointId/deliveries
   * List webhook delivery attempts for an endpoint (paginated).
   * Shows status, timestamp, latency, and error details (never response bodies or secrets).
   */
  app.get(
    "/v1/sellers/:sellerId/webhooks/:endpointId/deliveries",
    async (request) => {
      const params = parseParams(
        request,
        z.object({
          sellerId: z.string().min(1),
          endpointId: z.string().min(1),
        })
      );
      const query = parseQuery(
        request,
        z.object({
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0),
        })
      );

      // TODO: Verify seller owns endpoint
      // TODO: Return paginated delivery history (redacted)
      return {
        deliveries: [],
        total: 0,
      };
    }
  );

  /**
   * GET /v1/sellers/:sellerId/webhooks/events
   * List webhook events for a seller (paginated).
   * Shows event type, status, timestamp, and event ID for debugging.
   */
  app.get("/v1/sellers/:sellerId/webhooks/events", async (request) => {
    const params = parseParams(
      request,
      z.object({
        sellerId: z.string().min(1),
      })
    );
    const query = parseQuery(
      request,
      z.object({
        limit: z.coerce.number().int().min(1).max(100).default(20),
        offset: z.coerce.number().int().min(0).default(0),
      })
    );

    // TODO: Return paginated webhook events for seller
    return {
      events: [],
      total: 0,
    };
  });
}
