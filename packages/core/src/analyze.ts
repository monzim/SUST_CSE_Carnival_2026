/**
 * Pure analysis entrypoint.
 *
 * `analyzeTicket` is intentionally free of any HTTP or LLM-provider concerns:
 * the model call is injected as `deps.run`. That keeps the function unit-testable
 * with a deterministic fake (no network, no Gemini) and lets the API layer be a
 * thin adapter. The real runner lives in agent.ts.
 */
import {
  TicketRequestSchema,
  AnalysisCoreSchema,
  AnalysisResponseSchema,
  type TicketRequest,
  type AnalysisResponse,
} from "./schema.js";

export interface AnalyzeDeps {
  /**
   * Produce the model's analysis for a (validated) request. The return value is
   * validated against `AnalysisCoreSchema`, so it may be unknown-shaped here.
   */
  run: (request: TicketRequest) => Promise<unknown>;
}

/**
 * Validate the request, run the injected analyzer, validate the model output,
 * and return a schema-valid response.
 *
 * `ticket_id` is force-copied from the request — the model never controls it,
 * which guarantees the echo requirement holds even if the model emits its own.
 *
 * @throws ZodError if the request is malformed or the model output is off-spec.
 */
export async function analyzeTicket(
  request: TicketRequest,
  deps: AnalyzeDeps,
): Promise<AnalysisResponse> {
  const parsedRequest = TicketRequestSchema.parse(request);
  const rawAnalysis = await deps.run(parsedRequest);
  const core = AnalysisCoreSchema.parse(rawAnalysis);
  return AnalysisResponseSchema.parse({
    ...core,
    ticket_id: parsedRequest.ticket_id,
  });
}
