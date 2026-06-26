import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import {
  CORE_VERSION,
  TicketRequestSchema,
  analyzeTicketObserved,
  createAnalysisRunner,
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDERS,
  type AnalysisResponse,
  type AnalysisRunner,
  type LlmProvider,
} from "@queuestorm/core";
import { createMetrics, type Metrics } from "./metrics.js";
import {
  createRedisCache,
  hashTicket,
  noopCache,
  type CacheStore,
} from "./cache.js";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

/** Did a (possibly cached) response come from the deterministic fallback? */
function isFallbackResponse(response: AnalysisResponse): boolean {
  return (response.reason_codes ?? []).includes("automated_fallback");
}

/** A non-sensitive error message (never a stack trace) for logs. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow an unknown request body to an indexable object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

export interface BuildServerOptions {
  /**
   * Analyzer the `/analyze-ticket` route delegates to. Injectable so tests can
   * supply a deterministic fake. When omitted, the route validates input but
   * responds 503 — handy for running locally without a reachable Gemini API.
   */
  runner?: AnalysisRunner;
  /**
   * Response cache. Defaults to a no-op. Injected so tests (and the entrypoint)
   * control the backing store; all cache calls are non-blocking by contract.
   */
  cache?: CacheStore;
  /** Aggregate counters powering `GET /stats`. Defaults to a fresh instance. */
  metrics?: Metrics;
  /** Destination stream for structured logs. Defaults to pino's default (stdout). */
  logStream?: NodeJS.WritableStream;
}

export function buildServer(opts: BuildServerOptions = {}) {
  const cache = opts.cache ?? noopCache();
  const metrics = opts.metrics ?? createMetrics();

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      ...(opts.logStream ? { stream: opts.logStream } : {}),
    },
  });

  // Tracer-bullet liveness probe. Kept dependency-free — and independent of
  // Redis — so it stays green even when the cache backend is unreachable.
  app.get("/health", async () => ({ status: "ok" }));

  // Aggregate observability counters. Extra, non-contract endpoint; exposes only
  // counts and token sums, never ticket content, secrets, or credentials.
  app.get("/stats", async () => metrics.snapshot());

  // Thin adapter over the pure `analyzeTicket`: validate, delegate, map errors.
  app.post("/analyze-ticket", async (request, reply) => {
    const body = request.body;

    // Distinguish "present but empty complaint" (422 — semantically invalid)
    // from "malformed/junk payload" (400). An empty/whitespace complaint is a
    // well-formed request the service cannot act on.
    const complaint = isObject(body) ? body.complaint : undefined;
    if (typeof complaint === "string" && complaint.trim() === "") {
      reply.code(422);
      return { error: "Unprocessable: 'complaint' must not be empty." };
    }

    const parsed = TicketRequestSchema.safeParse(body);
    if (!parsed.success) {
      // Non-sensitive message; never echo internal validation detail verbatim.
      reply.code(400);
      return {
        error: "Invalid ticket request: 'ticket_id' and 'complaint' are required.",
      };
    }

    const startedAt = performance.now();
    const key = hashTicket(parsed.data);

    // Cache lookup first: a repeat ticket can be served even with no runner, and
    // the lookup is non-blocking. The store is non-throwing by contract, but we
    // guard here too so even a misbehaving cache can only ever cause a miss.
    let cached: AnalysisResponse | null = null;
    try {
      cached = await cache.get(key);
    } catch (err) {
      request.log.warn({ err: errMessage(err) }, "cache get failed; treating as miss");
    }

    if (!cached && !opts.runner) {
      reply.code(503);
      return { error: "Analyzer not configured." };
    }

    let response: AnalysisResponse;
    let safetyFlag: boolean;
    let fallback: boolean;
    let tokensIn: number;
    let tokensOut: number;
    let cacheHit: boolean;

    if (cached) {
      response = cached;
      cacheHit = true;
      // The cached body is already guarded/sanitised; we only recover whether it
      // was a fallback. Safety/tokens are attributes of the original computation.
      fallback = isFallbackResponse(cached);
      safetyFlag = false;
      tokensIn = 0;
      tokensOut = 0;
    } else {
      // analyzeTicketObserved degrades to a safe fallback on model timeout/error,
      // so a 200 with a safe body is the normal path even when the LLM is down.
      const observed = await analyzeTicketObserved(parsed.data, {
        run: opts.runner!,
      });
      response = observed.response;
      cacheHit = false;
      fallback = observed.meta.fallback;
      safetyFlag = observed.meta.safety_flag;
      tokensIn = observed.meta.tokens_in;
      tokensOut = observed.meta.tokens_out;
      // Fire-and-forget: never let a cache write block or fail the response.
      void Promise.resolve()
        .then(() => cache.set(key, response))
        .catch((err) =>
          request.log.warn({ err: errMessage(err) }, "cache set failed; skipping"),
        );
    }

    const latencyMs = Math.round(performance.now() - startedAt);

    metrics.record({
      case_type: response.case_type,
      safety_flag: safetyFlag,
      fallback,
      cache_hit: cacheHit,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
    });

    // One structured analytics line per request. Carries only safe, aggregate
    // signals — no complaint text, transaction data, secrets, or credentials.
    request.log.info(
      {
        event: "analyze_ticket",
        ticket_id: response.ticket_id,
        case_type: response.case_type,
        evidence_verdict: response.evidence_verdict,
        severity: response.severity,
        department: response.department,
        human_review_required: response.human_review_required,
        tokens_in: tokensIn,
        tokens_out: tokensOut,
        latency_ms: latencyMs,
        safety_flag: safetyFlag,
        fallback,
        cache_hit: cacheHit,
      },
      "analyze_ticket",
    );

    return response;
  });

  return app;
}

/**
 * Build the analyzer from the environment, if the chosen provider's key is set.
 *
 * `LLM_PROVIDER` selects the provider (default: OpenAI), `LLM_MODEL` overrides
 * the model, and the key is read from that provider's conventional env var
 * (e.g. OPENAI_API_KEY). `GEMINI_API_KEY` is accepted as an alias for the
 * google-genai key.
 */
export function runnerFromEnv(): AnalysisRunner | undefined {
  const provider = (process.env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER) as LlmProvider;
  const providerConfig = LLM_PROVIDERS[provider];
  if (!providerConfig) return undefined;

  const apiKey =
    process.env[providerConfig.apiKeyEnv] ??
    (provider === "google-genai" ? process.env.GEMINI_API_KEY : undefined);
  if (!apiKey) return undefined;

  return createAnalysisRunner({
    apiKey,
    provider,
    model: process.env.LLM_MODEL,
  });
}

/** A console-backed structured logger for the cache layer (no secrets logged). */
const consoleLogger = {
  warn(obj: unknown, msg: string) {
    console.warn(JSON.stringify({ level: "warn", msg, ...(obj as object) }));
  },
};

/**
 * Build a Redis-backed cache from `REDIS_URL`, or a no-op cache if unset.
 *
 * Connection is fire-and-forget and errors are swallowed: the cache is a pure
 * optimisation, so a missing or unreachable Redis must never block startup or
 * the request path. Until the client connects, cache ops simply miss / no-op.
 */
async function cacheFromEnv(): Promise<CacheStore> {
  const url = process.env.REDIS_URL;
  if (!url) return noopCache();

  const { createClient } = await import("redis");
  const client = createClient({ url });
  // Swallow connection/runtime errors — the guarded cache degrades to misses.
  client.on("error", (err: unknown) =>
    consoleLogger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "redis client error",
    ),
  );
  void client.connect().catch(() => {
    /* non-blocking: a failed connect just means cache misses */
  });

  return createRedisCache(client, { log: consoleLogger });
}

async function main() {
  const { config } = await import("dotenv");
  config();

  const runner = runnerFromEnv();
  const cache = await cacheFromEnv();
  const app = buildServer({ runner, cache });
  if (!runner) {
    app.log.warn(
      "No LLM API key set for the selected provider — /analyze-ticket will respond 503",
    );
  }

  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info({ coreVersion: CORE_VERSION }, "queuestorm api listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start the server when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
