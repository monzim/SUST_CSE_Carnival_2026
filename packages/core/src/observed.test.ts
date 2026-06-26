import { describe, it, expect } from "vitest";
import { analyzeTicketObserved } from "./analyze.js";
import type { AnalysisCore, TicketRequest } from "./schema.js";

const REQUEST: TicketRequest = {
  ticket_id: "TKT-001",
  complaint: "I sent 5000 taka to a wrong number around 2pm today. Please help.",
  language: "en",
};

const CLEAN_CORE: AnalysisCore = {
  relevant_transaction_id: null,
  evidence_verdict: "insufficient_data",
  case_type: "wrong_transfer",
  severity: "high",
  department: "dispute_resolution",
  agent_summary: "Customer reports a wrong transfer; no transaction asserted.",
  recommended_next_action:
    "Verify the transaction with the customer and follow the wrong-transfer dispute workflow.",
  // Already carries the never-share reminder so the scanner leaves it untouched.
  customer_reply:
    "We have noted your concern. Please do not share your PIN or OTP with anyone, even if they claim to be from us.",
  human_review_required: true,
};

const depsReturning = (raw: unknown) => ({ run: async () => raw });

describe("analyzeTicketObserved", () => {
  it("returns the response plus clean meta on the happy path", async () => {
    const { response, meta } = await analyzeTicketObserved(
      REQUEST,
      depsReturning(CLEAN_CORE),
    );

    expect(response.ticket_id).toBe("TKT-001");
    expect(response.case_type).toBe("wrong_transfer");
    expect(meta.fallback).toBe(false);
    expect(meta.safety_flag).toBe(false);
    expect(meta.tokens_in).toBe(0);
    expect(meta.tokens_out).toBe(0);
  });

  it("flags fallback when the runner throws", async () => {
    const { response, meta } = await analyzeTicketObserved(REQUEST, {
      run: async () => {
        throw new Error("provider down");
      },
    });

    expect(meta.fallback).toBe(true);
    // Fallback output is still schema-valid and escalated for review.
    expect(response.human_review_required).toBe(true);
  });

  it("flags safety when the scanner sanitises an unsafe field", async () => {
    // Model is coaxed into soliciting a credential — the scanner must rewrite it.
    const { meta } = await analyzeTicketObserved(
      REQUEST,
      depsReturning({
        ...CLEAN_CORE,
        customer_reply: "Please share your PIN and OTP so we can verify you.",
      }),
    );

    expect(meta.safety_flag).toBe(true);
  });

  it("surfaces token usage from a usage-bearing runner result", async () => {
    const { meta } = await analyzeTicketObserved(
      REQUEST,
      depsReturning({
        analysis: CLEAN_CORE,
        usage: { input_tokens: 1200, output_tokens: 340 },
      }),
    );

    expect(meta.tokens_in).toBe(1200);
    expect(meta.tokens_out).toBe(340);
  });
});
