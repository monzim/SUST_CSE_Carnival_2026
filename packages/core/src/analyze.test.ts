import { describe, it, expect } from "vitest";
import { analyzeTicket, type AnalyzeDeps } from "./analyze.js";
import type { AnalysisCore, TicketRequest } from "./schema.js";

/** SAMPLE-01 input from the public sample-case pack. */
const SAMPLE_01_REQUEST: TicketRequest = {
  ticket_id: "TKT-001",
  complaint:
    "I sent 5000 taka to a wrong number around 2pm today. The number was supposed to be 01712345678 but I think I typed it wrong. The person isn't responding to my call. Please help me get my money back.",
  language: "en",
  channel: "in_app_chat",
  user_type: "customer",
  campaign_context: "boishakh_bonanza_day_1",
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

/** A valid `emit_analysis` payload for SAMPLE-01 (no ticket_id — force-copied). */
const SAMPLE_01_CORE: AnalysisCore = {
  relevant_transaction_id: "TXN-9101",
  evidence_verdict: "consistent",
  case_type: "wrong_transfer",
  severity: "high",
  department: "dispute_resolution",
  agent_summary:
    "Customer reports sending 5000 BDT via TXN-9101 to +8801719876543, which they now believe was the wrong recipient.",
  recommended_next_action:
    "Verify TXN-9101 details with the customer and initiate the wrong-transfer dispute workflow per policy.",
  customer_reply:
    "We have noted your concern about transaction TXN-9101. Please do not share your PIN or OTP with anyone. Our dispute team will review the case and contact you through official support channels.",
  human_review_required: true,
  confidence: 0.9,
  reason_codes: ["wrong_transfer", "transaction_match", "dispute_initiated"],
};

const depsReturning = (raw: unknown): AnalyzeDeps => ({ run: async () => raw });

describe("analyzeTicket", () => {
  it("returns a schema-valid response for the happy path (SAMPLE-01)", async () => {
    const result = await analyzeTicket(SAMPLE_01_REQUEST, depsReturning(SAMPLE_01_CORE));

    expect(result).toEqual({ ...SAMPLE_01_CORE, ticket_id: "TKT-001" });
    // Every required output field is present and correctly spelled.
    expect(result.evidence_verdict).toBe("consistent");
    expect(result.case_type).toBe("wrong_transfer");
    expect(result.department).toBe("dispute_resolution");
    expect(result.relevant_transaction_id).toBe("TXN-9101");
  });

  it("force-copies ticket_id from the request, ignoring the model's", async () => {
    const result = await analyzeTicket(
      SAMPLE_01_REQUEST,
      // Model tries to emit a different ticket_id; it must be overridden.
      depsReturning({ ...SAMPLE_01_CORE, ticket_id: "WRONG-999" }),
    );
    expect(result.ticket_id).toBe("TKT-001");
  });

  it("supports a null relevant_transaction_id (insufficient evidence)", async () => {
    const result = await analyzeTicket(
      { ticket_id: "TKT-006", complaint: "Something is wrong with my money. Please check." },
      depsReturning({
        relevant_transaction_id: null,
        evidence_verdict: "insufficient_data",
        case_type: "other",
        severity: "low",
        department: "customer_support",
        agent_summary: "Vague complaint with no identifiable transaction.",
        recommended_next_action: "Ask the customer for transaction id, amount, and time.",
        customer_reply:
          "Thank you for reaching out. Please share the transaction ID and amount. Do not share your PIN or OTP with anyone.",
        human_review_required: false,
      }),
    );
    expect(result.relevant_transaction_id).toBeNull();
    expect(result.ticket_id).toBe("TKT-006");
  });

  it("rejects an off-spec enum from the model", async () => {
    await expect(
      analyzeTicket(
        SAMPLE_01_REQUEST,
        depsReturning({ ...SAMPLE_01_CORE, case_type: "WrongTransfer" }),
      ),
    ).rejects.toThrow();
  });

  it("rejects a request missing the complaint", async () => {
    await expect(
      // @ts-expect-error — exercising the runtime guard with an invalid request
      analyzeTicket({ ticket_id: "TKT-001" }, depsReturning(SAMPLE_01_CORE)),
    ).rejects.toThrow();
  });
});
