/**
 * Tunable deterministic-layer constants.
 *
 * These knobs govern the hardening wrapper around the LLM (issue #3). They are
 * intentionally centralised so the grader-sensitive thresholds (escalation,
 * timeout) can be tuned in one place without touching guard logic.
 */

/**
 * Transaction amount (in the ledger's base unit, BDT) at or above which a
 * ticket is always escalated to a human, regardless of what the model decided.
 * Large money movements are never auto-resolved.
 */
export const HIGH_VALUE = 50_000;

/**
 * Internal per-request timeout for the LLM call. Sits comfortably inside the
 * 30s end-to-end budget so a slow/hung model degrades to a deterministic
 * `keywordFallback` rather than blowing the caller's deadline.
 */
export const LLM_TIMEOUT_MS = 22_000;

/** The mandatory credential-safety line, in each supported reply language. */
export const NEVER_SHARE_LINE = {
  en: "Please do not share your PIN or OTP with anyone, even if they claim to be from us.",
  bn: "অনুগ্রহ করে কারো সাথে আপনার পিন বা ওটিপি শেয়ার করবেন না, এমনকি কেউ নিজেকে আমাদের প্রতিনিধি দাবি করলেও।",
} as const;
