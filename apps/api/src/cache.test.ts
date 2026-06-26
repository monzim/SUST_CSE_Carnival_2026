import { describe, it, expect } from "vitest";
import type { AnalysisResponse, TicketRequest } from "@queuestorm/core";
import { hashTicket, createRedisCache, type RedisLike } from "./cache.js";

const REQUEST: TicketRequest = {
  ticket_id: "TKT-001",
  complaint: "I sent 5000 taka to a wrong number.",
  language: "en",
};

const RESPONSE: AnalysisResponse = {
  ticket_id: "TKT-001",
  relevant_transaction_id: null,
  evidence_verdict: "insufficient_data",
  case_type: "wrong_transfer",
  severity: "high",
  department: "dispute_resolution",
  agent_summary: "Wrong transfer reported.",
  recommended_next_action: "Follow the wrong-transfer dispute workflow.",
  customer_reply: "We have noted your concern. Please do not share your PIN or OTP.",
  human_review_required: true,
};

/** A trivial in-memory RedisLike for round-trip tests. */
function memoryClient(): RedisLike & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async get(key) {
      return store.get(key) ?? null;
    },
    async set(key, value) {
      store.set(key, value);
      return "OK";
    },
  };
}

/** A RedisLike whose every op rejects, standing in for a downed Redis. */
const downClient: RedisLike = {
  async get() {
    throw new Error("redis down");
  },
  async set() {
    throw new Error("redis down");
  },
};

describe("hashTicket", () => {
  it("is stable for the same request regardless of key order", () => {
    const a = hashTicket(REQUEST);
    const b = hashTicket({ language: "en", complaint: REQUEST.complaint, ticket_id: "TKT-001" });
    expect(a).toBe(b);
  });

  it("differs when the complaint differs", () => {
    expect(hashTicket(REQUEST)).not.toBe(
      hashTicket({ ...REQUEST, complaint: "different complaint" }),
    );
  });
});

describe("createRedisCache", () => {
  it("round-trips a response through the client", async () => {
    const cache = createRedisCache(memoryClient());
    const key = hashTicket(REQUEST);
    expect(await cache.get(key)).toBeNull();
    await cache.set(key, RESPONSE);
    expect(await cache.get(key)).toEqual(RESPONSE);
  });

  it("never throws and returns null when the client is down", async () => {
    const cache = createRedisCache(downClient);
    const key = hashTicket(REQUEST);
    await expect(cache.set(key, RESPONSE)).resolves.toBeUndefined();
    await expect(cache.get(key)).resolves.toBeNull();
  });

  it("returns null for a corrupt cached value rather than throwing", async () => {
    const client = memoryClient();
    const key = hashTicket(REQUEST);
    client.store.set(key, "not json{");
    const cache = createRedisCache(client);
    expect(await cache.get(key)).toBeNull();
  });
});
