import { describe, it, expect } from "vitest";
import { Writable } from "node:stream";
import type { AnalysisCore, TicketRequest } from "@queuestorm/core";
import { buildServer } from "./index.js";
import { createMetrics } from "./metrics.js";
import { createRedisCache, hashTicket, type RedisLike, type CacheStore } from "./cache.js";

const SAMPLE: TicketRequest = {
  ticket_id: "TKT-001",
  complaint: "I sent 5000 taka to a wrong number around 2pm today. Please help.",
  language: "en",
  transaction_history: [
    {
      transaction_id: "TXN-9101",
      timestamp: "2026-04-14T14:08:22Z",
      type: "transfer",
      amount: 5000,
      counterparty: "+8801719876543",
      status: "completed",
    },
  ],
};

const CORE: AnalysisCore = {
  relevant_transaction_id: "TXN-9101",
  evidence_verdict: "consistent",
  case_type: "wrong_transfer",
  severity: "high",
  department: "dispute_resolution",
  agent_summary: "Customer reports a wrong transfer via TXN-9101.",
  recommended_next_action: "Initiate the wrong-transfer dispute workflow.",
  customer_reply:
    "We have noted your concern about TXN-9101. Please do not share your PIN or OTP with anyone.",
  human_review_required: true,
};

/** In-memory RedisLike for integration tests. */
function memoryClient(): RedisLike {
  const store = new Map<string, string>();
  return {
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
  };
}

/** A cache whose every operation throws, standing in for a downed Redis. */
const downCache: CacheStore = {
  async get() {
    throw new Error("redis down");
  },
  async set() {
    throw new Error("redis down");
  },
};

/** Collect newline-delimited JSON log lines emitted by the server. */
function logCollector(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

async function post(app: ReturnType<typeof buildServer>, payload: unknown) {
  return app.inject({ method: "POST", url: "/analyze-ticket", payload });
}

describe("observability + caching", () => {
  it("serves an identical ticket from cache and increments cache_hits", async () => {
    let calls = 0;
    const metrics = createMetrics();
    const cache = createRedisCache(memoryClient());
    const app = buildServer({
      runner: async () => {
        calls += 1;
        return CORE;
      },
      cache,
      metrics,
    });

    const first = await post(app, SAMPLE);
    const second = await post(app, SAMPLE);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    // The model ran only once — the second request was served from cache.
    expect(calls).toBe(1);
    expect(metrics.snapshot().cache_hits).toBe(1);
    await app.close();
  });

  it("tracks counters: totals, case type, fallbacks, and token sum", async () => {
    const metrics = createMetrics();
    const app = buildServer({
      // Usage-bearing result so the token sum is exercised.
      runner: async () => ({ analysis: CORE, usage: { input_tokens: 100, output_tokens: 40 } }),
      metrics,
      cache: createRedisCache(memoryClient()),
    });

    await post(app, SAMPLE);
    // A second, distinct ticket whose model call fails → fallback path.
    await post(app, {
      ticket_id: "TKT-002",
      complaint: "Random unrelated issue with my account, please check.",
    });

    const fallbackApp = buildServer({
      runner: async () => {
        throw new Error("provider down");
      },
      metrics,
      cache: createRedisCache(memoryClient()),
    });
    await post(fallbackApp, {
      ticket_id: "TKT-003",
      complaint: "This is a phishing scam asking for my OTP.",
    });

    const snap = metrics.snapshot();
    expect(snap.total).toBe(3);
    // TKT-001 and TKT-002 both run the (usage-bearing) model → wrong_transfer x2.
    expect(snap.by_case_type.wrong_transfer).toBe(2);
    // Only TKT-003's model call threw → exactly one fallback.
    expect(snap.fallbacks).toBe(1);
    // Two successful model calls at 100/40 each; the fallback reports no tokens.
    expect(snap.tokens.input).toBe(200);
    expect(snap.tokens.output).toBe(80);
    expect(snap.tokens.total).toBe(280);
    await app.close();
    await fallbackApp.close();
  });

  it("exposes aggregates via GET /stats without leaking ticket content", async () => {
    const app = buildServer({
      runner: async () => CORE,
      metrics: createMetrics(),
      cache: createRedisCache(memoryClient()),
    });
    await post(app, SAMPLE);

    const res = await app.inject({ method: "GET", url: "/stats" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(1);
    expect(body.tokens).toBeDefined();
    // The complaint text must never appear in the aggregates.
    expect(JSON.stringify(body)).not.toContain("5000 taka");
    await app.close();
  });

  it("emits one structured JSON log line per request with the required fields", async () => {
    const log = logCollector();
    const app = buildServer({
      runner: async () => CORE,
      metrics: createMetrics(),
      cache: createRedisCache(memoryClient()),
      logStream: log.stream,
    });
    await post(app, SAMPLE);
    await app.close();

    const analytics = log.lines().filter((l) => l.event === "analyze_ticket");
    expect(analytics).toHaveLength(1);
    const line = analytics[0];
    for (const field of [
      "ticket_id",
      "case_type",
      "evidence_verdict",
      "severity",
      "department",
      "human_review_required",
      "tokens_in",
      "tokens_out",
      "latency_ms",
      "safety_flag",
      "fallback",
      "cache_hit",
    ]) {
      expect(line, `missing field ${field}`).toHaveProperty(field);
    }
    expect(line.ticket_id).toBe("TKT-001");
    expect(typeof line.latency_ms).toBe("number");
  });

  it("stays fully available when Redis is down", async () => {
    const app = buildServer({
      runner: async () => CORE,
      metrics: createMetrics(),
      cache: downCache,
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);

    const res = await post(app, SAMPLE);
    expect(res.statusCode).toBe(200);
    expect(res.json().ticket_id).toBe("TKT-001");
    await app.close();
  });
});
