/**
 * @queuestorm/core — shared analysis logic.
 *
 * Issue #1 shipped the scaffold; issue #2 adds the analyze-ticket happy path:
 * zod schemas for the request/response contract, a pure `analyzeTicket`, and a
 * constrained Gemini Deep Agent runner. Evidence guards / safety scanner in #3.
 */

/** Package version marker, handy for health/diagnostics wiring later. */
export const CORE_VERSION = "0.1.0";

export * from "./schema.js";
export {
  analyzeTicket,
  analyzeTicketObserved,
  type AnalyzeDeps,
  type AnalysisMeta,
  type ObservedAnalysis,
  type TokenUsage,
} from "./analyze.js";
export { applyEvidenceGuards } from "./guards.js";
export { applySafetyScanner, isUnsafeField } from "./safety.js";
export { keywordFallback } from "./fallback.js";
export { HIGH_VALUE, LLM_TIMEOUT_MS, NEVER_SHARE_LINE } from "./constants.js";
export { replyLanguage, hasBangla } from "./lang.js";
export {
  createAnalysisRunner,
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDERS,
  type AnalysisRunner,
  type AnalysisRunnerOptions,
  type AnalysisRunnerResult,
  type LlmProvider,
} from "./agent.js";
export { ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";
