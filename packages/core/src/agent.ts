/**
 * Constrained Gemini Deep Agent runner.
 *
 * The analysis runs Google Gemini through a deliberately constrained LangChain
 * Deep Agent: the filesystem tools and the subagent `task` tool are excluded,
 * the auto general-purpose subagent is disabled, and a single structured
 * `emit_analysis` tool is the only way the model can produce output. The agent
 * runs a single turn and we read the structured arguments back out of the tool.
 */
import { createDeepAgent, registerHarnessProfile } from "deepagents";
import { tool } from "langchain";
import {
  AnalysisCoreSchema,
  type AnalysisCore,
  type TicketRequest,
} from "./schema.js";
import { ANALYSIS_SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js";

/** Filesystem tools the harness adds by default; hidden from this agent. */
const FILESYSTEM_TOOL_NAMES = [
  "ls",
  "read_file",
  "write_file",
  "edit_file",
  "glob",
  "grep",
  "execute",
] as const;

/**
 * Default Gemini model. Issue #2 calls for `gemini-3.5-flash`, with
 * `gemini-2.5-flash` as a documented fallback if the former does not resolve
 * against the live API. Override via the `model` option (or `GEMINI_MODEL`).
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";

export interface GeminiRunnerOptions {
  /** Gemini Developer API key (e.g. from `GEMINI_API_KEY`). */
  apiKey: string;
  /** Bare model id, e.g. "gemini-3.5-flash". */
  model?: string;
}

/** A function that returns the model's structured analysis for a request. */
export type AnalysisRunner = (request: TicketRequest) => Promise<AnalysisCore>;

/**
 * Register (idempotently) the constrained harness profile for a model key.
 * Hides the filesystem + subagent tools and disables the general-purpose
 * subagent so the agent can only run a single structured turn.
 */
function registerConstrainedProfile(modelKey: string): void {
  registerHarnessProfile(modelKey, {
    excludedTools: [...FILESYSTEM_TOOL_NAMES, "task", "write_todos"],
    generalPurposeSubagent: { enabled: false },
  });
}

/**
 * Build a runner backed by a constrained Gemini Deep Agent.
 *
 * The model is passed as a `google-genai:<model>` string so the harness profile
 * (keyed by that string) applies; init_chat_model reads the key from
 * `GOOGLE_API_KEY`, which we set from the provided `apiKey`.
 */
export function createGeminiAnalysisRunner(
  opts: GeminiRunnerOptions,
): AnalysisRunner {
  const modelId = opts.model ?? DEFAULT_GEMINI_MODEL;
  // langchain's init_chat_model uses the hyphenated `google-genai` provider
  // token for the Gemini Developer API (a bare `gemini-*` would mis-infer as
  // Vertex AI, which needs GCP auth instead of an API key).
  const modelKey = `google-genai:${modelId}`;

  // @langchain/google-genai resolves the key from GOOGLE_API_KEY when the model
  // is built from a provider:model string.
  process.env.GOOGLE_API_KEY = opts.apiKey;
  registerConstrainedProfile(modelKey);

  return async function run(request: TicketRequest): Promise<AnalysisCore> {
    let captured: unknown;

    const emitAnalysis = tool(
      async (args: unknown) => {
        captured = args;
        return "Analysis recorded.";
      },
      {
        name: "emit_analysis",
        description:
          "Emit the final structured triage analysis for this ticket. Call exactly once with your complete analysis. This is the only way to return a result.",
        schema: AnalysisCoreSchema,
      },
    );

    const agent = createDeepAgent({
      model: modelKey,
      tools: [emitAnalysis],
      systemPrompt: ANALYSIS_SYSTEM_PROMPT,
      subagents: [],
    });

    await agent.invoke({
      messages: [{ role: "user", content: buildUserPrompt(request) }],
    });

    if (captured === undefined) {
      throw new Error("Analysis agent did not call emit_analysis");
    }
    return AnalysisCoreSchema.parse(captured);
  };
}
