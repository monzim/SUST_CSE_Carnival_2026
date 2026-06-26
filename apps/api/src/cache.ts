/**
 * Non-blocking response cache, keyed by a hash of the ticket request.
 *
 * Repeat analyses of an identical ticket (judge re-runs, client retries) return
 * the prior `AnalysisResponse` straight from Redis, saving tokens and latency.
 * Every cache operation is guarded: a downed or misbehaving Redis degrades to a
 * cache miss (`get` → null) or a no-op (`set`), never an error that could fail
 * the request. The cache is strictly an optimisation — `analyze-ticket` and
 * `/health` work fully without it.
 */
import { createHash } from "node:crypto";
import { AnalysisResponseSchema, type AnalysisResponse, type TicketRequest } from "@queuestorm/core";

/** The minimal slice of a Redis client this cache depends on (node-redis v4+). */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { EX?: number },
  ): Promise<unknown>;
}

/** A response cache. All methods are non-throwing by contract. */
export interface CacheStore {
  /** Return the cached response for `key`, or null on miss / any failure. */
  get(key: string): Promise<AnalysisResponse | null>;
  /** Store `value` under `key`, fire-and-forget; failures are swallowed. */
  set(key: string, value: AnalysisResponse): Promise<void>;
}

/** Optional structured logger sink for cache-layer diagnostics. */
export interface CacheLogger {
  warn(obj: unknown, msg: string): void;
}

/** Default cache TTL: long enough to absorb judge re-runs, short enough to bound staleness. */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * Stable cache key for a ticket: a SHA-256 over the request with object keys
 * sorted, so logically-identical requests (any field order) collide on purpose.
 */
export function hashTicket(request: TicketRequest): string {
  return createHash("sha256").update(canonicalJson(request)).digest("hex");
}

/** Deterministic JSON with recursively sorted object keys. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export interface RedisCacheOptions {
  ttlSeconds?: number;
  log?: CacheLogger;
}

/**
 * Build a guarded {@link CacheStore} over a Redis-like client. The client is
 * injected so the guard behaviour is testable without a live Redis and so the
 * entrypoint can own connection lifecycle.
 */
export function createRedisCache(
  client: RedisLike,
  options: RedisCacheOptions = {},
): CacheStore {
  const ttl = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const log = options.log;

  return {
    async get(key) {
      try {
        const raw = await client.get(key);
        if (raw === null) return null;
        // Re-validate: a cached value must still satisfy the response contract.
        return AnalysisResponseSchema.parse(JSON.parse(raw));
      } catch (err) {
        log?.warn({ err: errMessage(err) }, "cache get failed; treating as miss");
        return null;
      }
    },
    async set(key, value) {
      try {
        await client.set(key, JSON.stringify(value), { EX: ttl });
      } catch (err) {
        log?.warn({ err: errMessage(err) }, "cache set failed; skipping");
      }
    },
  };
}

/** A cache that does nothing — used when no Redis URL is configured. */
export function noopCache(): CacheStore {
  return {
    async get() {
      return null;
    },
    async set() {
      // intentionally empty
    },
  };
}

/** Extract a non-sensitive message from an unknown error (never a stack trace). */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
