/**
 * Constrained, provider-agnostic Deep Agent runner.
 *
 * The analysis runs through a deliberately constrained LangChain Deep Agent:
 * the filesystem tools and the subagent `task` tool are excluded, the auto
 * general-purpose subagent is disabled, and a single structured `emit_analysis`
 * tool is the only way the model can produce output. The agent runs a single
 * turn and we read the structured arguments back out of the tool.
 *
 * The model provider is swappable (the problem statement allows any major LLM
 * provider — OpenAI, Anthropic, Google AI, etc.). The model is passed as a
 * `<provider>:<model>` string so the constrained harness profile (keyed by that
 * string) applies; init_chat_model resolves the provider and reads its key from
 * the provider's conventional env var, which we set from the supplied `apiKey`.
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
 * Per-provider defaults: the deepagents/langchain provider token, a sensible
 * default model id, and the env var init_chat_model reads the key from.
 *
 * The problem statement permits any provider; OpenAI is the default because it
 * is reachable from the build region (unlike the Gemini Developer API, which is
 * geo-blocked from some regions). Override the model via the `model` option.
 */
export const LLM_PROVIDERS = {
  openai: { defaultModel: "gpt-5-mini", apiKeyEnv: "OPENAI_API_KEY" },
  anthropic: { defaultModel: "claude-opus-4-8", apiKeyEnv: "ANTHROPIC_API_KEY" },
  "google-genai": { defaultModel: "gemini-3.5-flash", apiKeyEnv: "GOOGLE_API_KEY" },
} as const satisfies Record<string, { defaultModel: string; apiKeyEnv: string }>;

export type LlmProvider = keyof typeof LLM_PROVIDERS;

export const DEFAULT_LLM_PROVIDER: LlmProvider = "openai";

export interface AnalysisRunnerOptions {
  /** API key for the chosen provider. */
  apiKey: string;
  /** Provider token. Defaults to {@link DEFAULT_LLM_PROVIDER}. */
  provider?: LlmProvider;
  /** Bare model id (e.g. "gpt-5.5"). Defaults to the provider's default. */
  model?: string;
}

/** A function that returns the model's structured analysis for a request. */
export type AnalysisRunner = (request: TicketRequest) => Promise<AnalysisCore>;

/**
 * Register (idempotently) the constrained harness profile for a model key:
 * hides the filesystem + subagent tools and disables the general-purpose
 * subagent so the agent can only run a single structured turn.
 */
function registerConstrainedProfile(modelKey: string): void {
  registerHarnessProfile(modelKey, {
    excludedTools: [...FILESYSTEM_TOOL_NAMES, "task", "write_todos"],
    generalPurposeSubagent: { enabled: false },
  });
}

/**
 * Build a runner backed by a constrained Deep Agent over the chosen provider.
 */
export function createAnalysisRunner(opts: AnalysisRunnerOptions): AnalysisRunner {
  const provider = opts.provider ?? DEFAULT_LLM_PROVIDER;
  const providerConfig = LLM_PROVIDERS[provider];
  const modelId = opts.model ?? providerConfig.defaultModel;
  const modelKey = `${provider}:${modelId}`;

  // init_chat_model reads each provider's key from its conventional env var.
  process.env[providerConfig.apiKeyEnv] = opts.apiKey;
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
