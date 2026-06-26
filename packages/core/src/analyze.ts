/**
 * Pure analysis entrypoint + deterministic hardening layer.
 *
 * `analyzeTicket` is intentionally free of any HTTP or LLM-provider concerns:
 * the model call is injected as `deps.run`. That keeps the function unit-testable
 * with a deterministic fake (no network, no provider) and lets the API layer be
 * a thin adapter. The real runner lives in agent.ts.
 *
 * Around the injected model call sits the reliability + safety wrapper (issue
 * #3): the call is bounded by an internal timeout; on timeout/error/unusable
 * output the result degrades to a deterministic `keywordFallback`; and every
 * result — real or fallback — passes through the evidence guards and the safety
 * scanner before it is returned. The model can be wrong, slow, or adversarially
 * steered, and the output is still coherent, safe, and schema-valid.
 */
import {
  TicketRequestSchema,
  AnalysisResponseSchema,
  type TicketRequest,
  type AnalysisResponse,
  type AnalysisCore,
} from "./schema.js";
import { applyEvidenceGuards } from "./guards.js";
import { applySafetyScanner } from "./safety.js";
import { keywordFallback } from "./fallback.js";
import { LLM_TIMEOUT_MS } from "./constants.js";

export interface AnalyzeDeps {
  /**
   * Produce the model's analysis for a (validated) request. The return value is
   * guarded + scanned before use, so it may be unknown-shaped or off-spec here.
   *
   * A runner may also return a usage-bearing envelope (`{ analysis, usage }`) so
   * the observed pipeline can report the model's token counts; a bare analysis is
   * treated as zero usage.
   */
  run: (request: TicketRequest) => Promise<unknown>;
  /** Internal LLM timeout in ms. Defaults to {@link LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
}

/** The model's reported token usage for one analysis call. */
export interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
}

/**
 * Observability metadata produced alongside an analysis. Derived deterministically
 * by the hardening pipeline, never taken from the model: `fallback` is true when
 * the deterministic keyword fallback was substituted for the model's output;
 * `safety_flag` is true when the safety scanner had to sanitise a customer-facing
 * or internal-action field; `tokens_*` are the model's reported usage (0 unknown).
 */
export interface AnalysisMeta {
  fallback: boolean;
  safety_flag: boolean;
  tokens_in: number;
  tokens_out: number;
}

/** An analysis response paired with its observability metadata. */
export interface ObservedAnalysis {
  response: AnalysisResponse;
  meta: AnalysisMeta;
}

/** Reject after `ms`, so a hung model call can degrade to the fallback. */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`analysis timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Run the deterministic guards + safety scanner over a raw analysis, reporting
 * whether the safety scanner had to change any customer-facing/internal field.
 */
function guardAndScan(
  raw: unknown,
  request: TicketRequest,
): { core: AnalysisCore; safetyFlag: boolean } {
  const guarded = applyEvidenceGuards(raw, request);
  const scanned = applySafetyScanner(guarded, request);
  const safetyFlag =
    scanned.customer_reply !== guarded.customer_reply ||
    scanned.recommended_next_action !== guarded.recommended_next_action;
  return { core: scanned, safetyFlag };
}

/** Narrow an unknown value to an indexable object. */
function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

/**
 * Unwrap a runner result that may be a usage-bearing envelope. A bare analysis
 * (the common case, and what test fakes return) reports zero usage; an
 * `{ analysis, usage }` envelope surfaces the model's token counts. `analysis`
 * is not a field of the analysis schema, so the envelope is unambiguous.
 */
function unwrapRunnerResult(raw: unknown): { core: unknown; usage: TokenUsage } {
  if (isObject(raw) && "analysis" in raw && "usage" in raw) {
    const usage = isObject(raw.usage) ? raw.usage : {};
    return {
      core: raw.analysis,
      usage: {
        input_tokens: Number(usage.input_tokens) || 0,
        output_tokens: Number(usage.output_tokens) || 0,
      },
    };
  }
  return { core: raw, usage: { input_tokens: 0, output_tokens: 0 } };
}

/**
 * Validate the request, run the injected analyzer under a timeout, apply the
 * deterministic guards + safety scanner, and return a schema-valid response
 * paired with observability metadata (fallback / safety_flag / token usage).
 *
 * `ticket_id` is force-copied from the request — the model never controls it,
 * which guarantees the echo requirement holds even if the model emits its own.
 *
 * On a timeout, a thrown error, or unusable model output, the analysis degrades
 * to a deterministic `keywordFallback` rather than failing the request, and the
 * returned `meta.fallback` records that.
 *
 * @throws ZodError only if the *request* itself is malformed (the caller's
 *   contract). Model failures never throw — they fall back.
 */
export async function analyzeTicketObserved(
  request: TicketRequest,
  deps: AnalyzeDeps,
): Promise<ObservedAnalysis> {
  const parsedRequest = TicketRequestSchema.parse(request);

  let fallback = false;
  let usage: TokenUsage = { input_tokens: 0, output_tokens: 0 };
  let raw: unknown;
  try {
    const result = await withTimeout(
      Promise.resolve(deps.run(parsedRequest)),
      deps.timeoutMs ?? LLM_TIMEOUT_MS,
    );
    const unwrapped = unwrapRunnerResult(result);
    raw = unwrapped.core;
    usage = unwrapped.usage;
  } catch {
    raw = keywordFallback(parsedRequest);
    fallback = true;
  }

  let scanned: { core: AnalysisCore; safetyFlag: boolean };
  try {
    scanned = guardAndScan(raw, parsedRequest);
  } catch {
    // Guards should never throw, but if the raw output is pathological enough
    // to slip through, the fallback is always clean.
    scanned = guardAndScan(keywordFallback(parsedRequest), parsedRequest);
    fallback = true;
    usage = { input_tokens: 0, output_tokens: 0 };
  }

  const response = AnalysisResponseSchema.parse({
    ...scanned.core,
    ticket_id: parsedRequest.ticket_id,
  });

  return {
    response,
    meta: {
      fallback,
      safety_flag: scanned.safetyFlag,
      tokens_in: usage.input_tokens,
      tokens_out: usage.output_tokens,
    },
  };
}

/**
 * Thin wrapper over {@link analyzeTicketObserved} that returns just the
 * schema-valid response — the public happy-path contract for callers that do
 * not need observability metadata.
 */
export async function analyzeTicket(
  request: TicketRequest,
  deps: AnalyzeDeps,
): Promise<AnalysisResponse> {
  const { response } = await analyzeTicketObserved(request, deps);
  return response;
}
