import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import {
  CORE_VERSION,
  TicketRequestSchema,
  analyzeTicket,
  createAnalysisRunner,
  DEFAULT_LLM_PROVIDER,
  LLM_PROVIDERS,
  type AnalysisRunner,
  type LlmProvider,
} from "@queuestorm/core";

const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

export interface BuildServerOptions {
  /**
   * Analyzer the `/analyze-ticket` route delegates to. Injectable so tests can
   * supply a deterministic fake. When omitted, the route validates input but
   * responds 503 — handy for running locally without a reachable Gemini API.
   */
  runner?: AnalysisRunner;
}

export function buildServer(opts: BuildServerOptions = {}) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
    },
  });

  // Tracer-bullet liveness probe. Kept dependency-free so it stays green
  // even before any analysis logic (or Redis) exists.
  app.get("/health", async () => ({ status: "ok" }));

  // Thin adapter over the pure `analyzeTicket`: validate, delegate, map errors.
  app.post("/analyze-ticket", async (request, reply) => {
    const parsed = TicketRequestSchema.safeParse(request.body);
    if (!parsed.success) {
      // Non-sensitive message; never echo internal validation detail verbatim.
      reply.code(400);
      return {
        error: "Invalid ticket request: 'ticket_id' and 'complaint' are required.",
      };
    }

    if (!opts.runner) {
      reply.code(503);
      return { error: "Analyzer not configured." };
    }

    try {
      return await analyzeTicket(parsed.data, { run: opts.runner });
    } catch (err) {
      request.log.error({ err }, "analyze-ticket failed");
      reply.code(502);
      return { error: "Analysis failed." };
    }
  });

  return app;
}

/**
 * Build the analyzer from the environment, if the chosen provider's key is set.
 *
 * `LLM_PROVIDER` selects the provider (default: OpenAI), `LLM_MODEL` overrides
 * the model, and the key is read from that provider's conventional env var
 * (e.g. OPENAI_API_KEY). `GEMINI_API_KEY` is accepted as an alias for the
 * google-genai key.
 */
export function runnerFromEnv(): AnalysisRunner | undefined {
  const provider = (process.env.LLM_PROVIDER ?? DEFAULT_LLM_PROVIDER) as LlmProvider;
  const providerConfig = LLM_PROVIDERS[provider];
  if (!providerConfig) return undefined;

  const apiKey =
    process.env[providerConfig.apiKeyEnv] ??
    (provider === "google-genai" ? process.env.GEMINI_API_KEY : undefined);
  if (!apiKey) return undefined;

  return createAnalysisRunner({
    apiKey,
    provider,
    model: process.env.LLM_MODEL,
  });
}

async function main() {
  const { config } = await import("dotenv");
  config();

  const runner = runnerFromEnv();
  const app = buildServer({ runner });
  if (!runner) {
    app.log.warn(
      "No LLM API key set for the selected provider — /analyze-ticket will respond 503",
    );
  }

  try {
    await app.listen({ host: HOST, port: PORT });
    app.log.info({ coreVersion: CORE_VERSION }, "queuestorm api listening");
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

// Only start the server when run directly (not when imported by tests).
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  void main();
}
