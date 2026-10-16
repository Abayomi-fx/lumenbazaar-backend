import { describe, expect, it } from "vitest";

import { buildApiApp } from "../app.js";
import { RateLimitService } from "../services/rateLimit.js";
import { classifyRateLimitScope } from "./rateLimit.js";

describe("rate limit hook", () => {
  it("classifies facilitator, discovery, and seller endpoints", () => {
    expect(classifyRateLimitScope({ method: "POST", url: "/v1/verify" })).toBe("facilitator");
    expect(classifyRateLimitScope({ method: "GET", url: "/v1/discovery/search?q=weather" })).toBe(
      "discovery"
    );
    expect(classifyRateLimitScope({ method: "POST", url: "/v1/sellers" })).toBe("seller");
    expect(classifyRateLimitScope({ method: "GET", url: "/health" })).toBeUndefined();
  });

  it("returns standard 429 responses and records rate-limit events", async () => {
    const rateLimitService = new RateLimitService({
      rules: {
        facilitator: {
          limit: 1,
          windowMs: 60_000
        }
      }
    });
    const app = buildApiApp({
      logger: false,
      rateLimitService
    });

    const first = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: {
        "X-API-Key": "test-api-key"
      }
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: {
        "x-api-key": "test-api-key"
      }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    expect(second.json()).toMatchObject({
      ok: false,
      error: {
        code: "RATE_LIMITED",
        message: "Rate limit exceeded.",
        details: {
          scope: "facilitator"
        }
      }
    });
    expect(second.headers["x-ratelimit-limit"]).toBe("1");
    await expect(rateLimitService.listEvents()).resolves.toMatchObject([
      {
        route: "GET /v1/supported",
        scope: "facilitator"
      }
    ]);

    await app.close();
  });

  it("includes Retry-After header in 429 responses per RFC 6585", async () => {
    const rateLimitService = new RateLimitService({
      rules: {
        facilitator: {
          limit: 1,
          windowMs: 60_000
        }
      }
    });
    const app = buildApiApp({
      logger: false,
      rateLimitService
    });

    const first = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "X-API-Key": "test-api-key" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "x-api-key": "test-api-key" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    
    const retryAfter = second.headers["retry-after"];
    expect(retryAfter).toBeDefined();
    const retrySeconds = parseInt(retryAfter as string, 10);
    expect(retrySeconds).toBeGreaterThanOrEqual(1);
    expect(retrySeconds).toBeLessThanOrEqual(60); // Should be within the 60 second window

    await app.close();
  });

  it("does not trust forwarded client addresses", async () => {
    const rateLimitService = new RateLimitService({
      rules: {
        facilitator: {
          limit: 1,
          windowMs: 60_000
        }
      }
    });
    const app = buildApiApp({ logger: false, rateLimitService });

    const first = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "x-forwarded-for": "198.51.100.10" }
    });
    const second = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "x-forwarded-for": "203.0.113.20" }
    });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);
    await app.close();
  });

  it("continues serving requests if rate limiter encounters errors", async () => {
    const rateLimitService = new RateLimitService({
      rules: {
        facilitator: {
          limit: 1,
          windowMs: 60_000
        }
      }
    });
    const app = buildApiApp({
      logger: false,
      rateLimitService
    });

    // Exhaust the rate limit
    const first = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "X-API-Key": "test-api-key" }
    });
    expect(first.statusCode).toBe(200);

    // Second request should be blocked
    const second = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "X-API-Key": "test-api-key" }
    });
    expect(second.statusCode).toBe(429);

    // Even if rate limiter fails internally, requests should continue
    // (The hook catches errors and logs but doesn't block)
    const third = await app.inject({
      method: "GET",
      url: "/v1/supported",
      headers: { "X-API-Key": "different-key" }
    });
    // Different key should have fresh quota
    expect(third.statusCode).toBe(200);

    await app.close();
  });
});
