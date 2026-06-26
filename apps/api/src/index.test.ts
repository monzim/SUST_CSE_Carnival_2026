import { describe, it, expect } from "vitest";
import type { AnalysisCore, TicketRequest } from "@queuestorm/core";
import { buildServer } from "./index.js";

const SAMPLE_01_INPUT: TicketRequest = {
  ticket_id: "TKT-001",
  complaint:
    "I sent 5000 taka to a wrong number around 2pm today. Please help me get my money back.",
  language: "en",
  channel: "in_app_chat",
  user_type: "customer",
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

const FAKE_CORE: AnalysisCore = {
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

describe("POST /analyze-ticket", () => {
  it("returns 200 with a schema-valid response for the happy path", async () => {
    const app = buildServer({ runner: async () => FAKE_CORE });
    const res = await app.inject({
      method: "POST",
      url: "/analyze-ticket",
      payload: SAMPLE_01_INPUT,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ticket_id).toBe("TKT-001");
    expect(body.case_type).toBe("wrong_transfer");
    expect(body.evidence_verdict).toBe("consistent");
    expect(body.human_review_required).toBe(true);
    await app.close();
  });

  it("returns 400 when the complaint is missing", async () => {
    const app = buildServer({ runner: async () => FAKE_CORE });
    const res = await app.inject({
      method: "POST",
      url: "/analyze-ticket",
      payload: { ticket_id: "TKT-001" },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/required/i);
    await app.close();
  });

  it("returns 422 when the complaint is empty/whitespace", async () => {
    const app = buildServer({ runner: async () => FAKE_CORE });
    for (const complaint of ["", "   "]) {
      const res = await app.inject({
        method: "POST",
        url: "/analyze-ticket",
        payload: { ticket_id: "TKT-001", complaint },
      });
      expect(res.statusCode).toBe(422);
    }
    await app.close();
  });

  it("returns a safe 200 fallback when the analyzer throws", async () => {
    const app = buildServer({
      runner: async () => {
        throw new Error("provider down");
      },
    });
    const res = await app.inject({
      method: "POST",
      url: "/analyze-ticket",
      payload: SAMPLE_01_INPUT,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ticket_id).toBe("TKT-001");
    expect(body.human_review_required).toBe(true);
    expect(body.customer_reply).toMatch(/do not share your PIN or OTP/i);
    await app.close();
  });

  it("returns 503 when no analyzer is configured", async () => {
    const app = buildServer();
    const res = await app.inject({
      method: "POST",
      url: "/analyze-ticket",
      payload: SAMPLE_01_INPUT,
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it("keeps /health green", async () => {
    const app = buildServer();
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
    await app.close();
  });
});
