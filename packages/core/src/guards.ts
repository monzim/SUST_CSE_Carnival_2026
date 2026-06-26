/**
 * Evidence guards — the deterministic clamp that wraps the model's analysis so
 * the structured fields are always coherent with the request, regardless of
 * what the model emitted (or hallucinated).
 *
 * The model output reaches here as `unknown` (it may be off-spec or, on the
 * fallback path, hand-built). Guards read it defensively, clamp every enum to
 * the whitelist, force a hallucinated transaction id to null, downgrade an
 * incoherent verdict, clamp confidence, and force human review for every
 * escalation condition. The result always satisfies `AnalysisCoreSchema`.
 */
import {
  CaseType,
  Severity,
  Department,
  EvidenceVerdict,
  AnalysisCoreSchema,
  type AnalysisCore,
  type TicketRequest,
} from "./schema.js";
import { HIGH_VALUE } from "./constants.js";

type Unknown = Record<string, unknown>;

const asString = (v: unknown, fallback = ""): string =>
  typeof v === "string" ? v : fallback;

/** Clamp a value to an enum's whitelist, falling back when off-spec. */
function clampEnum<T extends string>(
  v: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof v === "string" && (allowed as readonly string[]).includes(v)
    ? (v as T)
    : fallback;
}

/** A wrong_transfer is only a *dispute* when a verdict has actually been formed. */
function isWrongTransferDispute(
  caseType: string,
  verdict: string,
): boolean {
  return (
    caseType === "wrong_transfer" &&
    (verdict === "consistent" || verdict === "inconsistent")
  );
}

/** The amount used for high-value escalation: the relevant txn, else the max. */
function escalationAmount(
  request: TicketRequest,
  relevantId: string | null,
): number {
  const history = request.transaction_history ?? [];
  if (relevantId) {
    const match = history.find((t) => t.transaction_id === relevantId);
    if (match) return match.amount;
  }
  return history.reduce((max, t) => Math.max(max, t.amount), 0);
}

/**
 * Apply the evidence guards to a raw (possibly off-spec) analysis object,
 * producing a schema-valid {@link AnalysisCore}. Never throws.
 */
export function applyEvidenceGuards(
  raw: unknown,
  request: TicketRequest,
): AnalysisCore {
  const o: Unknown = raw && typeof raw === "object" ? (raw as Unknown) : {};

  // --- enums: clamp every one to its whitelist (invalid -> safe default) ---
  const caseType = clampEnum(o.case_type, CaseType.options, "other");
  const severity = clampEnum(o.severity, Severity.options, "medium");
  const department = clampEnum(
    o.department,
    Department.options,
    "customer_support",
  );
  let verdict = clampEnum(
    o.evidence_verdict,
    EvidenceVerdict.options,
    "insufficient_data",
  );

  // --- relevant_transaction_id must exist in the request's history ---
  const knownIds = new Set(
    (request.transaction_history ?? []).map((t) => t.transaction_id),
  );
  const claimedId =
    typeof o.relevant_transaction_id === "string"
      ? o.relevant_transaction_id
      : null;
  let relevantId = claimedId && knownIds.has(claimedId) ? claimedId : null;

  // If we had to drop a hallucinated id and the model called it "consistent",
  // the verdict can no longer stand — downgrade to insufficient_data.
  if (relevantId === null && claimedId !== null && verdict === "consistent") {
    verdict = "insufficient_data";
  }
  // A "consistent" verdict with no supporting transaction at all is incoherent.
  if (relevantId === null && verdict === "consistent") {
    verdict = "insufficient_data";
  }

  // --- confidence: clamp to [0, 1], drop if not a finite number ---
  let confidence: number | undefined;
  if (typeof o.confidence === "number" && Number.isFinite(o.confidence)) {
    confidence = Math.min(1, Math.max(0, o.confidence));
  }

  // --- human review: force true for every escalation condition ---
  const modelReview = o.human_review_required === true;
  const humanReviewRequired =
    modelReview ||
    caseType === "phishing_or_social_engineering" ||
    severity === "high" ||
    severity === "critical" ||
    verdict === "inconsistent" ||
    isWrongTransferDispute(caseType, verdict) ||
    escalationAmount(request, relevantId) >= HIGH_VALUE;

  const reasonCodes = Array.isArray(o.reason_codes)
    ? o.reason_codes.filter((c): c is string => typeof c === "string")
    : undefined;

  const core: AnalysisCore = {
    relevant_transaction_id: relevantId,
    evidence_verdict: verdict,
    case_type: caseType,
    severity,
    department,
    agent_summary:
      asString(o.agent_summary).trim() ||
      "Automated triage: see customer complaint for details.",
    recommended_next_action:
      asString(o.recommended_next_action).trim() ||
      "Review the ticket and follow the standard workflow for this case type.",
    customer_reply: asString(o.customer_reply),
    human_review_required: humanReviewRequired,
    ...(confidence !== undefined ? { confidence } : {}),
    ...(reasonCodes !== undefined ? { reason_codes: reasonCodes } : {}),
  };

  // customer_reply may still be empty here; the safety scanner owns building a
  // safe reply. Validate everything else is coherent.
  return AnalysisCoreSchema.parse({
    ...core,
    customer_reply: core.customer_reply.trim() || "(pending safe reply)",
  });
}
