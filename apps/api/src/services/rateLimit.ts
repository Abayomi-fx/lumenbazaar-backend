import { createHash, randomUUID } from "node:crypto";

import { Redis } from "ioredis";

import { type AppConfig } from "@lumenbazaar/shared";

export type RateLimitScope = "discovery" | "facilitator" | "seller";

export type RateLimitRule = {
  limit: number;
  windowMs: number;
};

export type RateLimitRequest = {
  key: string;
  route: string;
  scope: RateLimitScope;
};

export type RateLimitResult = {
  allowed: boolean;
  key: string;
  limit: number;
  remaining: number;
  resetAt: Date;
  scope: RateLimitScope;
  error?: string;
};

export type RateLimitEvent = {
  createdAt: string;
  id: string;
  key: string;
  limit: number;
  remaining: number;
  resetAt: string;
  route: string;
  scope: RateLimitScope;
};

export type RateLimitEventStore = {
  create: (input: Omit<RateLimitEvent, "id" | "createdAt">) => Promise<RateLimitEvent>;
  list: () => Promise<RateLimitEvent[]>;
};

type RateLimitBucket = {
  count: number;
  resetAt: number;
};

export type RateLimitCounterStore = {
  consume: (key: string, windowMs: number) => Promise<RateLimitBucket>;
};

export class InMemoryRateLimitCounterStore implements RateLimitCounterStore {
  private readonly buckets = new Map<string, RateLimitBucket>();

  async consume(key: string, windowMs: number) {
    const now = Date.now();
    const existing = this.buckets.get(key);
    const bucket =
      existing === undefined || existing.resetAt <= now
        ? { count: 1, resetAt: now + windowMs }
        : { count: existing.count + 1, resetAt: existing.resetAt };
    this.buckets.set(key, bucket);
    return bucket;
  }
}

const consumeRateLimitScript = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
end
local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  redis.call("PEXPIRE", KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { count, ttl }
`;

export class RedisRateLimitCounterStore implements RateLimitCounterStore {
  private readonly fallback = new InMemoryRateLimitCounterStore();
  
  constructor(private readonly client: Redis) {}

  async consume(key: string, windowMs: number) {
    try {
      const result = await this.client.eval(
        consumeRateLimitScript,
        1,
        `lumenbazaar:rate-limit:${key}`,
        windowMs
      );
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error("Redis returned an invalid rate-limit result.");
      }
      const count = Number(result[0]);
      const ttl = Number(result[1]);
      if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttl) || ttl < 0) {
        throw new Error("Redis returned an invalid rate-limit counter.");
      }
      return { count, resetAt: Date.now() + ttl };
    } catch (error) {
      // On Redis error, degrade gracefully to in-memory rate limiting
      // This ensures availability during Redis outages, but note that distributed
      // rate limiting is lost for this request and subsequent requests to other replicas
      // will not see this request's count.
      console.warn(
        "Redis rate limit error, falling back to in-memory",
        error instanceof Error ? error.message : String(error)
      );
      return this.fallback.consume(key, windowMs);
    }
  }
}

export class InMemoryRateLimitEventStore implements RateLimitEventStore {
  private readonly events: RateLimitEvent[] = [];

  async create(input: Omit<RateLimitEvent, "id" | "createdAt">) {
    const event: RateLimitEvent = {
      id: `rate_limit_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ...input,
      createdAt: new Date().toISOString()
    };

    this.events.push(event);
    return event;
  }

  async list() {
    return [...this.events];
  }
}

export class RateLimitService {
  private readonly counterStore: RateLimitCounterStore;
  private readonly eventStore: RateLimitEventStore;
  private readonly rules: Record<RateLimitScope, RateLimitRule>;

  constructor(
    options: {
      eventStore?: RateLimitEventStore;
      counterStore?: RateLimitCounterStore;
      rules?: Partial<Record<RateLimitScope, RateLimitRule>>;
    } = {}
  ) {
    this.eventStore = options.eventStore ?? new InMemoryRateLimitEventStore();
    this.counterStore = options.counterStore ?? new InMemoryRateLimitCounterStore();
    this.rules = {
      discovery: {
        limit: 120,
        windowMs: 60_000
      },
      facilitator: {
        limit: 60,
        windowMs: 60_000
      },
      seller: {
        limit: 30,
        windowMs: 60_000
      },
      ...options.rules
    };
  }

  async consume(request: RateLimitRequest): Promise<RateLimitResult> {
    const rule = this.rules[request.scope];
    const key = hashRateLimitKey(`${request.scope}:${request.key}`);
    const bucketKey = `${request.scope}:${key}`;
    const bucket = await this.counterStore.consume(bucketKey, rule.windowMs);

    const remaining = Math.max(0, rule.limit - bucket.count);
    const result: RateLimitResult = {
      allowed: bucket.count <= rule.limit,
      key,
      limit: rule.limit,
      remaining,
      resetAt: new Date(bucket.resetAt),
      scope: request.scope
    };

    if (!result.allowed) {
      await this.eventStore.create({
        key,
        limit: rule.limit,
        remaining,
        resetAt: result.resetAt.toISOString(),
        route: request.route,
        scope: request.scope
      });
    }

    return result;
  }

  async listEvents() {
    return this.eventStore.list();
  }
}

export function createRateLimitService(
  rules?: Partial<Record<RateLimitScope, RateLimitRule>>
): RateLimitService {
  return rules === undefined ? new RateLimitService() : new RateLimitService({ rules });
}

export function createRuntimeRateLimitService(config: AppConfig) {
  if (
    process.env.VITEST !== undefined ||
    process.env.NODE_ENV === "test" ||
    config.nodeEnv !== "production" ||
    config.lumenEnv === "local"
  ) {
    return {
      service: new RateLimitService(),
      close: async () => undefined
    };
  }

  const client = new Redis(config.redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 1
  });
  return {
    service: new RateLimitService({ counterStore: new RedisRateLimitCounterStore(client) }),
    close: async () => {
      if (client.status === "wait" || client.status === "end") {
        client.disconnect();
        return;
      }
      await client.quit();
    }
  };
}

function hashRateLimitKey(key: string) {
  return createHash("sha256").update(key).digest("hex");
}
