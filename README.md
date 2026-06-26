# QueueStorm — AI Banking-Ticket Triage

QueueStorm Investigator is an AI triage service for a mobile-financial-services
(bank/wallet) support queue. It takes one customer or merchant complaint plus an
optional transaction history and returns one structured, **safe** triage
analysis: which transaction the complaint is about, whether the evidence
supports it, how to route it, and a customer reply that never leaks credentials
or over-promises a refund.

Built for **SUST CSE Carnival 2026 · Codex Community Hackathon (Preliminary)**.

---

## Quick start (runbook)

A stranger can bring the whole service up from a clean clone with Docker — no
Node toolchain needed on the host.

```bash
# 1. Clone and enter the repo
git clone <repo-url> && cd SUST_CSE_Carnival_2026

# 2. Configure: copy the template and set your LLM key
cp .env.example .env
#    edit .env -> set OPENAI_API_KEY=sk-... (OpenAI is the default provider)

# 3. Build and run the stack (API + Redis)
docker compose up -d --build

# 4. Verify it is live
curl http://localhost:3000/health
#    -> {"status":"ok"}

# 5. Analyze a ticket
curl -X POST http://localhost:3000/analyze-ticket \
  -H 'content-type: application/json' \
  --data-binary @samples/SAMPLE-01.input.json
```

The service answers on `http://localhost:${API_PORT}` (default `3000`). To expose
it publicly, put any reverse proxy (Traefik, Caddy, nginx) in front of the
published port and terminate TLS there — no proxy config lives in this repo.

### Run without Docker (local dev)

```bash
corepack enable          # provides pnpm
pnpm install
pnpm build
pnpm start:api           # serves on :3000, reads .env
# optional: a local Redis enables the response cache (REDIS_URL=redis://localhost:6379)
```

### Acceptance runner

A CLI exercises a **running** API against the official sample pack and a custom
adversarial edge pack, printing a per-case pass/fail table with latency + tokens:

```bash
pnpm cli check          # official 10 sample cases (field-diff scoring)
pnpm cli check --all    # + 19 custom edge cases (behavioral: safety, injection, escalation)
```

---

## HTTP API

| Method | Path              | Purpose                                                            |
| ------ | ----------------- | ----------------------------------------------------------------- |
| GET    | `/health`         | Liveness probe → `{"status":"ok"}`. Dependency-free (no Redis/LLM).|
| POST   | `/analyze-ticket` | The contract endpoint. Validates, analyzes, returns the analysis. |
| GET    | `/stats`          | Aggregate counters (counts + token sums). No ticket content.      |

`POST /analyze-ticket` status codes: `200` analysis, `400` malformed/junk body,
`422` well-formed but empty `complaint`, `503` no analyzer configured (no key and
no cache hit). The request/response field contract and enums live in
`packages/core/src/schema.ts` (zod) and mirror the public problem statement.

See `samples/` for real input/output pairs (wrong transfer, phishing, Bangla).

---

## Tech stack

- **Language / runtime:** TypeScript (ES modules), Node 22 (Docker), `>=20` host.
- **Monorepo:** pnpm workspace — `packages/core` (analysis), `apps/api`
  (Fastify service), `apps/cli` (acceptance runner).
- **HTTP:** [Fastify 5](https://fastify.dev) with structured `pino` logs.
- **LLM orchestration:** [LangChain](https://www.langchain.com) +
  [`deepagents`](https://www.npmjs.com/package/deepagents) — a constrained
  single-turn Deep Agent.
- **Validation:** [zod 4](https://zod.dev) for the request/response contract and
  the model's structured output.
- **Cache:** Redis (optional, non-blocking) keyed by a hash of the ticket.
- **Tests:** [vitest](https://vitest.dev) (unit) + the CLI acceptance runner.
- **Container:** multi-stage Dockerfile (`pnpm deploy --prod`), ~94 MB image.

---

## AI approach

The analysis runs through a **deliberately constrained** LangChain Deep Agent
(`packages/core/src/agent.ts`):

- The filesystem tools, the `task` subagent tool, and `write_todos` are excluded,
  and the auto general-purpose subagent is disabled.
- A single structured `emit_analysis` tool (schema = `AnalysisCoreSchema`) is the
  **only** way the model can return a result. It runs one turn; we read the
  structured arguments back out.
- The complaint is passed as untrusted data inside a JSON code block. The system
  prompt (`packages/core/src/prompt.ts`) encodes the domain policy distilled from
  the problem statement: how to pick the relevant transaction, judge evidence,
  route the case, and — emphatically — the safety invariants.

This keeps the model on a tight rail: it cannot free-type prose, browse, or spawn
agents; it can only emit one schema-valid analysis.

## Safety logic

The model is treated as fallible and potentially adversarially steered (via
prompt-injection embedded in the complaint). Every response — model or fallback —
passes through **deterministic** hardening (`packages/core/src/analyze.ts`)
before it leaves the service:

1. **Timeout** (`LLM_TIMEOUT_MS`, 22s — inside the 30s budget). A slow/hung model
   degrades rather than blocking the caller.
2. **Keyword fallback** (`fallback.ts`). On timeout / error / unusable output, a
   bilingual keyword classifier produces a conservative, schema-valid analysis
   (`insufficient_data`, null transaction, human review forced).
3. **Evidence guards** (`guards.ts`). Clamp every enum to its whitelist, force a
   hallucinated `relevant_transaction_id` to `null`, downgrade an incoherent
   "consistent" verdict, clamp confidence to `[0,1]`, and **force human review**
   for every escalation condition (phishing, high/critical severity, inconsistent
   evidence, wrong-transfer disputes, or any transaction ≥ 50,000 BDT).
4. **Safety scanner** (`safety.ts`). Bilingual (English + Bangla). Re-reads the
   customer-facing and internal-action fields and, on any hit:
   - replaces **credential solicitations** (asking for PIN/OTP/password/card) with
     a safe case-type template;
   - scrubs **refund/reversal confirmations** ("we will refund you") into safe,
     non-committal wording ("any eligible amount will be returned through official
     channels");
   - strips **off-channel redirects** (links, WhatsApp/Telegram, raw phone numbers);
   - guarantees the **never-share-PIN/OTP reminder** is present in the reply.
   `ticket_id` is force-copied from the request, never taken from the model.

Detection is intentionally conservative: a false positive costs a slightly
blander reply; a false negative costs points. Verified: **0 safety violations**
across the safety edge cases (`pnpm cli check --all`).

---

## MODELS

| Where | Model | Role | Why |
| ----- | ----- | ---- | --- |
| Analysis (default) | **OpenAI `gpt-5-mini`** | The triage agent behind `emit_analysis` | OpenAI is reachable from the build/deploy region (the Gemini Developer API is geo-blocked in some regions, e.g. BD); `gpt-5-mini` balances cost/latency against reasoning quality. |
| Analysis (committed samples) | **OpenAI `gpt-5.5`** | Same agent, higher tier | The `samples/` outputs were generated with `LLM_MODEL=gpt-5.5` for maximum reasoning quality. |
| Fallback (no model) | **None — deterministic keyword classifier** | Substitutes when the LLM times out / errors | Guarantees a safe, schema-valid answer with zero external calls. |

The provider is **configurable** via env (`packages/core/src/agent.ts`):

| `LLM_PROVIDER` | Default model | Key env var |
| -------------- | ------------- | ----------- |
| `openai` (default) | `gpt-5-mini` | `OPENAI_API_KEY` |
| `anthropic` | `claude-opus-4-8` | `ANTHROPIC_API_KEY` |
| `google-genai` | `gemini-3.5-flash` | `GOOGLE_API_KEY` / `GEMINI_API_KEY` |

Override the model for any provider with `LLM_MODEL`. No key for the selected
provider → `/analyze-ticket` answers `503` (and `/health` stays green).

---

## Configuration

All config is via environment (see `.env.example`; never commit a populated
`.env`). Names only:

| Var | Purpose |
| --- | ------- |
| `API_PORT` | Host port to publish the API on (default `3000`). |
| `LLM_PROVIDER` | `openai` (default) \| `anthropic` \| `google-genai`. |
| `LLM_MODEL` | Optional model override for the selected provider. |
| `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `GEMINI_API_KEY` | Key for the selected provider. |
| `REDIS_URL` | Optional cache backend. In Docker it is wired to the `redis` service automatically. |

---

## Assumptions

- The model provider is reachable from wherever the container runs; OpenAI is the
  default because it is not geo-restricted in the build/deploy region.
- Transaction amounts are in BDT; the high-value escalation threshold is 50,000.
- The reply language follows the complaint language (Bangla → Bangla, else
  English); `mixed`/Banglish is treated per `lang.ts` heuristics.
- Redis is a pure optimization — the service is fully correct without it.
- The grader scores the structured fields and safety; exact prose wording of the
  `customer_reply` is not field-matched.

## Known limitations

- **Severity is a judgment band.** Borderline cases can land one band off the
  reference (e.g. sample `SAMPLE-02`, a wrong-transfer claim with inconsistent
  evidence, scores `high` where the reference says `medium`). The acceptance
  runner treats `low/medium` and `high/critical` as the scored bands; an exact
  spelling mismatch within a band still passes. Official sample result: **9/10**
  field-exact, the one miss being this severity band.
- The keyword fallback is deliberately conservative — it never asserts a
  transaction match, so a fallback answer always routes to human review.
- No persistence beyond the optional Redis cache; `/stats` counters are
  in-process and reset on restart.
- Single-region LLM assumption: running where the chosen provider is geo-blocked
  will fall back to the deterministic classifier for every request.
