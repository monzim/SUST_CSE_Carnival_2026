/**
 * Safety scanner — the last deterministic gate before output leaves the service.
 *
 * Even with a strict system prompt, a model can be coaxed (including via
 * prompt-injection embedded in the complaint) into asking for credentials,
 * confirming a refund it has no authority to confirm, or redirecting the
 * customer off official channels. This scanner re-reads the customer-facing and
 * internal-action fields, and on any hit replaces the offending field with a
 * safe case-type template. It also guarantees the never-share-PIN/OTP reminder
 * is present and scrubs refund-confirmation phrasing from the next action.
 *
 * Detection is bilingual (English + Bangla) and intentionally conservative: a
 * false positive costs a slightly blander reply; a false negative costs points.
 */
import type { AnalysisCore, TicketRequest } from "./schema.js";
import { NEVER_SHARE_LINE } from "./constants.js";
import { replyLanguage } from "./lang.js";

type Lang = "en" | "bn";
type Case = AnalysisCore["case_type"];

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

const CREDENTIAL_NOUN =
  /(\bpin\b|\botp\b|\bpassword\b|\bpasscode\b|\bcvv\b|card\s*(?:number|no)|পিন|ওটিপি|পাসওয়ার্ড)/i;
const SOLICIT_VERB =
  /(share|send|provide|give|enter|tell|confirm|verify|reply with|type|what\s+is\s+your|দিন|পাঠান|শেয়ার\s*কর|বলুন|জানান|লিখুন)/i;
const NEGATION =
  /(not|n't|never|do\s*not|don't|avoid|কখনো|করবেন\s*না|দেবেন\s*না|শেয়ার\s*করবেন\s*না)/i;

/** Refund/reversal *confirmation* — not the safe "returned through official channels". */
const REFUND_CONFIRM =
  /(we('| wi)ll\s+refund|we\s+have\s+refunded|has\s+been\s+refunded|have\s+refunded|refund(ed)?\s+(has\s+been|to\s+your|will\s+be)|money\s+will\s+be\s+refunded|we('| wi)ll\s+reverse|will\s+be\s+reversed|reversal\s+has\s+been|ফেরত\s*দে(ব|বো|ওয়া\s*হবে|ওয়া\s*হয়েছে))/i;

/** Off-channel redirects: links, messaging apps, raw phone numbers, "click". */
const THIRD_PARTY =
  /(https?:\/\/|www\.|whatsapp|telegram|\bimo\b|this\s+link|click\s+(here|the\s+link)|\+?\d[\d\s-]{8,}\d)/i;

const splitSentences = (text: string): string[] =>
  text.split(/(?<=[.!?。।\n])\s+/).filter((s) => s.trim().length > 0);

/** A credential ask = noun + solicit verb in one sentence, without negation. */
function hasCredentialAsk(text: string): boolean {
  return splitSentences(text).some(
    (s) => CREDENTIAL_NOUN.test(s) && SOLICIT_VERB.test(s) && !NEGATION.test(s),
  );
}

function hasRefundConfirm(text: string): boolean {
  return REFUND_CONFIRM.test(text);
}

function hasThirdPartyRedirect(text: string): boolean {
  return THIRD_PARTY.test(text);
}

/** True if any unsafe pattern is present in the field. */
export function isUnsafeField(text: string): boolean {
  return (
    hasCredentialAsk(text) ||
    hasRefundConfirm(text) ||
    hasThirdPartyRedirect(text)
  );
}

// ---------------------------------------------------------------------------
// Safe templates
// ---------------------------------------------------------------------------

const REASSURANCE: Record<Lang, Partial<Record<Case, string>>> = {
  en: {
    wrong_transfer:
      "We have noted your concern and our dispute team will review the transaction through official channels.",
    payment_failed:
      "We have logged your failed-payment report and our payments team is investigating it.",
    refund_request:
      "We have received your request. Any eligible amount will be returned through official channels after review.",
    duplicate_payment:
      "We have noted the possible duplicate charge and our payments team will review it.",
    merchant_settlement_delay:
      "We have noted the settlement concern and our merchant operations team will review it.",
    agent_cash_in_issue:
      "We have noted your cash-in concern and our agent operations team will review it.",
    phishing_or_social_engineering:
      "Thank you for reaching out before sharing any information. We never ask for your PIN, OTP, or password under any circumstances. Our fraud team has been notified.",
    other:
      "Thank you for reaching out. Our support team will review your request through official channels.",
  },
  bn: {
    wrong_transfer:
      "আপনার অভিযোগ আমরা নথিভুক্ত করেছি; আমাদের বিরোধ নিষ্পত্তি দল অফিসিয়াল চ্যানেলে লেনদেনটি যাচাই করবে।",
    payment_failed:
      "আপনার ব্যর্থ পেমেন্টের রিপোর্ট আমরা নথিভুক্ত করেছি; আমাদের পেমেন্ট দল বিষয়টি যাচাই করছে।",
    refund_request:
      "আপনার অনুরোধ আমরা পেয়েছি। যাচাইয়ের পর যেকোনো প্রযোজ্য পরিমাণ অফিসিয়াল চ্যানেলে ফেরত দেওয়া হবে।",
    duplicate_payment:
      "সম্ভাব্য ডুপ্লিকেট চার্জটি আমরা নথিভুক্ত করেছি; আমাদের পেমেন্ট দল এটি যাচাই করবে।",
    merchant_settlement_delay:
      "সেটলমেন্ট সংক্রান্ত বিষয়টি আমরা নথিভুক্ত করেছি; আমাদের মার্চেন্ট অপারেশন্স দল এটি যাচাই করবে।",
    agent_cash_in_issue:
      "আপনার ক্যাশ-ইন সংক্রান্ত বিষয়টি আমরা নথিভুক্ত করেছি; আমাদের এজেন্ট অপারেশন্স দল এটি যাচাই করবে।",
    phishing_or_social_engineering:
      "কোনো তথ্য শেয়ার করার আগে যোগাযোগ করার জন্য ধন্যবাদ। আমরা কখনোই আপনার পিন, ওটিপি বা পাসওয়ার্ড চাই না। আমাদের ফ্রড দলকে অবহিত করা হয়েছে।",
    other:
      "যোগাযোগ করার জন্য ধন্যবাদ। আমাদের সহায়তা দল অফিসিয়াল চ্যানেলে আপনার অনুরোধ যাচাই করবে।",
  },
};

const SAFE_ACTION: Partial<Record<Case, string>> = {
  wrong_transfer:
    "Verify the transaction with the customer and initiate the wrong-transfer dispute workflow per policy. Do not promise any reversal.",
  payment_failed:
    "Check the payment gateway and ledger status for the transaction and follow the failed-payment workflow.",
  refund_request:
    "Assess eligibility under the refund policy. Do not confirm any refund; only eligible amounts are returned through official channels.",
  duplicate_payment:
    "Compare the suspected duplicate against the ledger and follow the duplicate-payment workflow.",
  merchant_settlement_delay:
    "Check the settlement batch status and follow the merchant settlement workflow.",
  agent_cash_in_issue:
    "Verify the agent cash-in record against the ledger and follow the agent-operations workflow.",
  phishing_or_social_engineering:
    "Escalate to the fraud team. Do not verify the caller's identity or request any credentials.",
  other: "Review the ticket and follow the standard workflow for this case type.",
};

/** Build a safe customer reply for a case type + language (incl. safety line). */
function safeReply(caseType: Case, lang: Lang): string {
  const body = REASSURANCE[lang][caseType] ?? REASSURANCE[lang].other!;
  return `${body} ${NEVER_SHARE_LINE[lang]}`;
}

/** Replace any refund-confirmation sentences with safe, non-committal wording. */
function scrubRefundConfirmation(text: string, lang: Lang): string {
  const safe =
    lang === "bn"
      ? "যেকোনো প্রযোজ্য পরিমাণ অফিসিয়াল চ্যানেলে ফেরত দেওয়া হবে"
      : "any eligible amount will be returned through official channels";
  const cleaned = splitSentences(text)
    .map((s) => (REFUND_CONFIRM.test(s) ? `${safe}.` : s))
    .join(" ")
    .trim();
  return cleaned.length > 0 ? cleaned : SAFE_ACTION.other!;
}

/** True if the reply already carries an explicit never-share reminder. */
function hasNeverShareReminder(text: string): boolean {
  return splitSentences(text).some(
    (s) => CREDENTIAL_NOUN.test(s) && NEGATION.test(s),
  );
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

/**
 * Scan and sanitise the customer-facing and internal-action fields of an
 * analysis. Replaces unsafe fields with safe templates, scrubs refund
 * confirmations from the next action, and guarantees the never-share reminder.
 */
export function applySafetyScanner(
  core: AnalysisCore,
  request: TicketRequest,
): AnalysisCore {
  const lang = replyLanguage(request);
  let { customer_reply, recommended_next_action } = core;

  // --- customer_reply: replace wholesale on any unsafe hit or if empty ---
  const replyIsPlaceholder =
    customer_reply.trim() === "" || customer_reply.trim() === "(pending safe reply)";
  if (replyIsPlaceholder || isUnsafeField(customer_reply)) {
    customer_reply = safeReply(core.case_type, lang);
  }
  // --- always ensure the never-share reminder is present ---
  if (!hasNeverShareReminder(customer_reply)) {
    customer_reply = `${customer_reply.trim()} ${NEVER_SHARE_LINE[lang]}`.trim();
  }

  // --- recommended_next_action: replace on credential/redirect, always scrub refund ---
  if (
    hasCredentialAsk(recommended_next_action) ||
    hasThirdPartyRedirect(recommended_next_action)
  ) {
    recommended_next_action = SAFE_ACTION[core.case_type] ?? SAFE_ACTION.other!;
  } else if (hasRefundConfirm(recommended_next_action)) {
    recommended_next_action = scrubRefundConfirmation(recommended_next_action, lang);
  }

  return { ...core, customer_reply, recommended_next_action };
}
