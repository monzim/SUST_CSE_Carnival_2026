/**
 * Zod schemas and types for the QueueStorm `POST /analyze-ticket` contract.
 *
 * Enums mirror the `allowed_enums` block of the public sample-case pack
 * (`docs/.../SUST_Preli_Sample_Cases.json`). The model's structured output is
 * validated against these schemas, so any out-of-spec enum spelling fails fast
 * rather than reaching the caller.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Enums (exact allowed spellings — do not paraphrase)
// ---------------------------------------------------------------------------

export const Language = z.enum(["en", "bn", "mixed"]);
export const Channel = z.enum([
  "in_app_chat",
  "call_center",
  "email",
  "merchant_portal",
  "field_agent",
]);
export const UserType = z.enum(["customer", "merchant", "agent", "unknown"]);
export const TransactionType = z.enum([
  "transfer",
  "payment",
  "cash_in",
  "cash_out",
  "settlement",
  "refund",
]);
export const TransactionStatus = z.enum([
  "completed",
  "failed",
  "pending",
  "reversed",
]);
export const EvidenceVerdict = z.enum([
  "consistent",
  "inconsistent",
  "insufficient_data",
]);
export const CaseType = z.enum([
  "wrong_transfer",
  "payment_failed",
  "refund_request",
  "duplicate_payment",
  "merchant_settlement_delay",
  "agent_cash_in_issue",
  "phishing_or_social_engineering",
  "other",
]);
export const Severity = z.enum(["low", "medium", "high", "critical"]);
export const Department = z.enum([
  "customer_support",
  "dispute_resolution",
  "payments_ops",
  "merchant_operations",
  "agent_operations",
  "fraud_risk",
]);

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const TransactionSchema = z.object({
  transaction_id: z.string(),
  timestamp: z.string(),
  type: TransactionType,
  amount: z.number(),
  counterparty: z.string(),
  status: TransactionStatus,
});

export const TicketRequestSchema = z.object({
  ticket_id: z.string().min(1),
  complaint: z.string().min(1),
  language: Language.optional(),
  channel: Channel.optional(),
  user_type: UserType.optional(),
  campaign_context: z.string().optional(),
  transaction_history: z.array(TransactionSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Response
//
// `AnalysisCoreSchema` is everything the model emits via `emit_analysis`. It
// deliberately omits `ticket_id`: that field is authoritative from the request
// and is force-copied in, never taken from the model (see analyze.ts).
// ---------------------------------------------------------------------------

export const AnalysisCoreSchema = z.object({
  relevant_transaction_id: z.string().nullable(),
  evidence_verdict: EvidenceVerdict,
  case_type: CaseType,
  severity: Severity,
  department: Department,
  agent_summary: z.string().min(1),
  recommended_next_action: z.string().min(1),
  customer_reply: z.string().min(1),
  human_review_required: z.boolean(),
  confidence: z.number().min(0).max(1).optional(),
  reason_codes: z.array(z.string()).optional(),
});

export const AnalysisResponseSchema = AnalysisCoreSchema.extend({
  ticket_id: z.string().min(1),
});

export type Transaction = z.infer<typeof TransactionSchema>;
export type TicketRequest = z.infer<typeof TicketRequestSchema>;
export type AnalysisCore = z.infer<typeof AnalysisCoreSchema>;
export type AnalysisResponse = z.infer<typeof AnalysisResponseSchema>;
