/**
 * Deterministic keyword fallback.
 *
 * When the LLM call times out, errors, or returns something unusable, the
 * service must still answer — schema-valid, safe, and conservative. This builds
 * an analysis from bilingual keyword heuristics: it never claims a transaction
 * match (`insufficient_data`, null id), always asks for human review, and emits
 * a best-guess case type so routing is plausible. The result is still passed
 * through the evidence guards and safety scanner by the caller, so the safe
 * customer reply and escalation are applied uniformly.
 */
import type { AnalysisCore, TicketRequest } from "./schema.js";

interface Rule {
  case_type: AnalysisCore["case_type"];
  severity: AnalysisCore["severity"];
  department: AnalysisCore["department"];
  /** EN + BN keyword fragments (lowercased match against the complaint). */
  keywords: RegExp;
}

/** Ordered most-specific first; phishing wins over everything. */
const RULES: Rule[] = [
  {
    case_type: "phishing_or_social_engineering",
    severity: "critical",
    department: "fraud_risk",
    keywords:
      /(phish|scam|fraud|suspicious|otp|verification code|click.*link|prize|lottery|প্রতারণা|ফিশিং|সন্দেহজনক|লটারি|পুরস্কার)/i,
  },
  {
    case_type: "duplicate_payment",
    severity: "high",
    department: "payments_ops",
    keywords: /(duplicate|twice|two times|double charge|দুইবার|দুবার|ডুপ্লিকেট)/i,
  },
  {
    case_type: "wrong_transfer",
    severity: "high",
    department: "dispute_resolution",
    keywords:
      /(wrong (number|recipient|transfer)|sent to.*wrong|mistaken|ভুল (নম্বর|নাম্বার|নম্বরে)|ভুল করে পাঠ)/i,
  },
  {
    case_type: "merchant_settlement_delay",
    severity: "medium",
    department: "merchant_operations",
    keywords: /(settlement|merchant payout|disbursement|সেটলমেন্ট|মার্চেন্ট)/i,
  },
  {
    case_type: "agent_cash_in_issue",
    severity: "high",
    department: "agent_operations",
    keywords: /(cash[\s-]?in|agent|এজেন্ট|ক্যাশ[\s-]?ইন)/i,
  },
  {
    case_type: "payment_failed",
    severity: "high",
    department: "payments_ops",
    keywords: /(fail|declin|not go through|unsuccessful|ব্যর্থ|হয়নি|ফেল)/i,
  },
  {
    case_type: "refund_request",
    severity: "low",
    department: "customer_support",
    keywords: /(refund|return.*money|cancel|ফেরত|রিফান্ড|বাতিল)/i,
  },
];

/** Classify a complaint into a best-guess routing using keyword heuristics. */
function classify(complaint: string): Rule {
  return (
    RULES.find((r) => r.keywords.test(complaint)) ?? {
      case_type: "other",
      severity: "low",
      department: "customer_support",
      keywords: /^/,
    }
  );
}

/**
 * Build a safe, schema-valid analysis for a request without calling the model.
 * `customer_reply` is left blank deliberately — the safety scanner builds the
 * language-correct safe reply for the chosen case type.
 */
export function keywordFallback(request: TicketRequest): AnalysisCore {
  const rule = classify(request.complaint);
  return {
    relevant_transaction_id: null,
    evidence_verdict: "insufficient_data",
    case_type: rule.case_type,
    severity: rule.severity,
    department: rule.department,
    agent_summary:
      "Automated fallback triage (model unavailable): classified by keywords; no transaction match asserted. Manual review required.",
    recommended_next_action:
      "Manually review the complaint and confirm the case type before acting; the automated classifier could not verify the transaction.",
    customer_reply: "",
    human_review_required: true,
    confidence: 0.2,
    reason_codes: ["automated_fallback", `keyword_${rule.case_type}`],
  };
}
