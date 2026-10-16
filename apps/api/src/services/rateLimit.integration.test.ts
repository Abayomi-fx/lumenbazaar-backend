import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { InMemoryRateLimitCounterStore, RateLimitService, RedisRateLimitCounterStore } from "./rateLimit.js";

const redisUrl = process.env.RATE_LIMIT_TEST_REDIS_URL;
const describeRedis = redisUrl === undefined ? describe.skip : describe;

describeRedis("Redis rate limiting", () => {
  const clients: Redis[] = [];

  beforeEach(async () => {
    const cleanup = new Redis(redisUrl ?? "redis://integration-test-is-disabled");
    clients.push(cleanup);
    const keys = await cleanup.keys("lumenbazaar:rate-limit:*");
    if (keys.length > 0) {
      await cleanup.del(...keys);
    }
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => client.quit()));
  });

  it("enforces one limit across independent API process clients", async () => {
    const services = [createService(), createService(), createService()];
    const request = {
      key: "multi-replica-client",
      route: "POST /v1/settle",
      scope: "facilitator" as const
    };

    const results = await Promise.all(services.map(async (service) => service.consume(request)));

    expect(results.filter((result) => result.allowed)).toHaveLength(2);
    expect(results.filter((result) => !result.allowed)).toHaveLength(1);
    expect(new Set(results.map((result) => result.resetAt.getTime())).size).toBeLessThanOrEqual(2);
  });

  it("handles Redis outage with graceful fallback to in-memory limiting", async () => {
    const healthyClient = new Redis(redisUrl ?? "redis://integration-test-is-disabled");
    clients.push(healthyClient);
    const healthyService = new RateLimitService({
      counterStore: new RedisRateLimitCounterStore(healthyClient),
      rules: { facilitator: { limit: 2, windowMs: 60_000 } }
    });

    // First request succeeds with Redis
    const result1 = await healthyService.consume({
      key: "outage-test-client",
      route: "POST /v1/settle",
      scope: "facilitator"
    });
    expect(result1.allowed).toBe(true);
    expect(result1.remaining).toBe(1);

    // Simulate Redis becoming unavailable by disconnecting and closing the connection
    healthyClient.disconnect();

    // Requests during outage fall back to in-memory, but lose distributed state
    // Each request to an unavailable Redis will use local in-memory bucket
    const result2 = await healthyService.consume({
      key: "outage-test-client",
      route: "POST /v1/settle",
      scope: "facilitator"
    });
    expect(result2.allowed).toBe(true); // Allowed because in-memory counter is reset

    // Additional requests continue working with in-memory fallback
    const result3 = await healthyService.consume({
      key: "outage-test-client",
      route: "POST /v1/settle",
      scope: "facilitator"
    });
    expect(result3.allowed).toBe(true);
  });

  it("maintains separate rate limits for different scopes across replicas", async () => {
    const services = [createService(), createService()];
    const facilitatorRequest = {
      key: "multi-scope-client",
      route: "POST /v1/settle",
      scope: "facilitator" as const
    };
    const sellerRequest = {
      key: "multi-scope-client",
      route: "POST /v1/sellers",
      scope: "seller" as const
    };

    // Facilitator limit: 2 per 60 seconds
    // Seller limit: 1 per 60 seconds (configured in createService)
    const fac1 = await services[0].consume(facilitatorRequest);
    const fac2 = await services[1].consume(facilitatorRequest);
    const fac3 = await services[0].consume(facilitatorRequest);

    expect(fac1.allowed).toBe(true);
    expect(fac2.allowed).toBe(true);
    expect(fac3.allowed).toBe(false); // Third facilitator request blocked

    // Seller requests are independent and have their own limit
    const sel1 = await services[0].consume(sellerRequest);
    const sel2 = await services[1].consume(sellerRequest);

    expect(sel1.allowed).toBe(true);
    expect(sel2.allowed).toBe(false); // Second seller request blocked (limit: 1)
  });

  it("correctly calculates remaining quota across multiple instances", async () => {
    const services = [createService(), createService(), createService()];
    const request = {
      key: "quota-test-client",
      route: "POST /v1/settle",
      scope: "facilitator" as const
    };

    const results = await Promise.all(services.map(async (service) => service.consume(request)));

    const allowed = results.filter((r) => r.allowed);
    expect(allowed.length).toBe(2);
    expect(allowed[0].remaining).toBe(1); // 2 allowed, 1 remaining after first
    expect(allowed[1].remaining).toBe(0); // 2 allowed, 0 remaining after second

    const blocked = results.find((r) => !r.allowed);
    expect(blocked?.remaining).toBe(0); // All quota consumed
  });

  function createService() {
    const client = new Redis(redisUrl ?? "redis://integration-test-is-disabled");
    clients.push(client);
    return new RateLimitService({
      counterStore: new RedisRateLimitCounterStore(client),
      rules: {
        facilitator: { limit: 2, windowMs: 60_000 },
        seller: { limit: 1, windowMs: 60_000 },
        discovery: { limit: 4, windowMs: 60_000 }
      }
    });
  }
});
