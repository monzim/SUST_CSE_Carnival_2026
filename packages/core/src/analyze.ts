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
   */
  run: (request: TicketRequest) => Promise<unknown>;
  /** Internal LLM timeout in ms. Defaults to {@link LLM_TIMEOUT_MS}. */
  timeoutMs?: number;
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

/** Run the deterministic guards + safety scanner over a raw analysis. */
function guardAndScan(raw: unknown, request: TicketRequest): AnalysisCore {
  const guarded = applyEvidenceGuards(raw, request);
  return applySafetyScanner(guarded, request);
}

/**
 * Validate the request, run the injected analyzer under a timeout, then apply
 * the deterministic guards + safety scanner and return a schema-valid response.
 *
 * `ticket_id` is force-copied from the request — the model never controls it,
 * which guarantees the echo requirement holds even if the model emits its own.
 *
 * On a timeout, a thrown error, or unusable model output, the analysis degrades
 * to a deterministic `keywordFallback` rather than failing the request.
 *
 * @throws ZodError only if the *request* itself is malformed (the caller's
 *   contract). Model failures never throw — they fall back.
 */
export async function analyzeTicket(
  request: TicketRequest,
  deps: AnalyzeDeps,
): Promise<AnalysisResponse> {
  const parsedRequest = TicketRequestSchema.parse(request);

  let raw: unknown;
  try {
    raw = await withTimeout(
      Promise.resolve(deps.run(parsedRequest)),
      deps.timeoutMs ?? LLM_TIMEOUT_MS,
    );
  } catch {
    raw = keywordFallback(parsedRequest);
  }

  let core: AnalysisCore;
  try {
    core = guardAndScan(raw, parsedRequest);
  } catch {
    // Guards should never throw, but if the raw output is pathological enough
    // to slip through, the fallback is always clean.
    core = guardAndScan(keywordFallback(parsedRequest), parsedRequest);
  }

  return AnalysisResponseSchema.parse({
    ...core,
    ticket_id: parsedRequest.ticket_id,
  });
}
