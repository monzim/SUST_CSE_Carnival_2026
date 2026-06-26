#!/usr/bin/env node
/**
 * @queuestorm/cli — acceptance test runner.
 *
 * The pre-submission readiness gauge. It exercises a *running* QueueStorm API
 * against two packs and prints a per-case pass/fail table with latency and token
 * usage, plus a summary.
 *
 *   pnpm cli check         # official 10 sample cases (field-diff)
 *   pnpm cli check --all   # + the custom edge pack (behavioral)
 *
 * Two assertion kinds:
 *   - field-diff  — the 10 official cases ship an `expected_output`; we compare
 *                   the scored fields (relevant_transaction_id, evidence_verdict,
 *                   case_type, department, and a severity *band*).
 *   - behavioral  — the edge cases have an *expected behavior*, not an expected
 *                   row: HTTP status, enum-legality, the safety scanner leaving
 *                   no unsafe content, ticket_id echo, high-value escalation.
 *
 * Token usage is not in the response body, so we read it from `GET /stats`: the
 * runner is sequential, so the token delta around a single POST is that case's
 * usage. A cached or fallback response legitimately reports 0 model tokens.
 */
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  AnalysisResponseSchema,
  isUnsafeField,
  type AnalysisResponse,
} from "@queuestorm/core";
import {
  edgeCases,
  type BehavioralChecks,
  type EdgeCase,
} from "@queuestorm/core/edge-cases";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const API_URL = (process.env.API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const DEFAULT_CASES_FILE = fileURLToPath(
  new URL(
    "../../../docs/Preliminary Questions and Resources/SUST_Preli_Sample_Cases.json",
    import.meta.url,
  ),
);
const CASES_FILE = process.env.CASES_FILE ?? DEFAULT_CASES_FILE;

// Severity is scored on comparable band, not exact spelling: a "high" where the
// reference says "critical" is acceptable; "low" where it says "high" is not.
const SEVERITY_BAND: Record<string, "soft" | "hard"> = {
  low: "soft",
  medium: "soft",
  high: "hard",
  critical: "hard",
};

// ---------------------------------------------------------------------------
// Official sample pack (field-diff)
// ---------------------------------------------------------------------------

interface OfficialCase {
  id: string;
  label: string;
  input: { ticket_id: string; complaint: string; [k: string]: unknown };
  expected_output: {
    relevant_transaction_id: string | null;
    evidence_verdict: string;
    case_type: string;
    department: string;
    severity: string;
    [k: string]: unknown;
  };
}

async function loadOfficialCases(): Promise<OfficialCase[]> {
  const raw = await readFile(CASES_FILE, "utf8");
  const parsed = JSON.parse(raw) as { cases?: OfficialCase[] };
  if (!Array.isArray(parsed.cases) || parsed.cases.length === 0) {
    throw new Error(`No 'cases' array found in ${CASES_FILE}`);
  }
  return parsed.cases;
}

const SCORED_FIELDS = [
  "relevant_transaction_id",
  "evidence_verdict",
  "case_type",
  "department",
] as const;

/** Compare scored fields; return the list of mismatching field notes. */
function fieldDiff(expected: OfficialCase["expected_output"], actual: AnalysisResponse): string[] {
  const diffs: string[] = [];
  for (const field of SCORED_FIELDS) {
    const exp = expected[field];
    const act = (actual as Record<string, unknown>)[field];
    if (exp !== act) diffs.push(`${field}: ${String(act)}≠${String(exp)}`);
  }
  const expBand = SEVERITY_BAND[expected.severity] ?? expected.severity;
  const actBand = SEVERITY_BAND[actual.severity] ?? actual.severity;
  if (expBand !== actBand) {
    diffs.push(`severity: ${actual.severity}≁${expected.severity}`);
  }
  return diffs;
}

// ---------------------------------------------------------------------------
// Edge pack (behavioral)
// ---------------------------------------------------------------------------

/** Evaluate behavioral checks against a 2xx body; return failure notes. */
function behavioralDiff(checks: BehavioralChecks, body: unknown, ticketId: string): string[] {
  const fails: string[] = [];
  const parsed = AnalysisResponseSchema.safeParse(body);

  if (checks.enumLegal && !parsed.success) {
    fails.push("enum-illegal/off-contract body");
  }
  // The remaining checks need a well-shaped body; if it failed the schema we've
  // already recorded that and skip the field-level assertions.
  if (!parsed.success) return fails;
  const res = parsed.data;

  if (checks.safetyClean) {
    if (isUnsafeField(res.customer_reply)) fails.push("unsafe customer_reply");
    if (isUnsafeField(res.recommended_next_action)) fails.push("unsafe next_action");
  }
  if (checks.ticketEcho && res.ticket_id !== ticketId) {
    fails.push(`ticket_id ${res.ticket_id}≠${ticketId}`);
  }
  if (checks.humanReview && res.human_review_required !== true) {
    fails.push("human_review_required=false");
  }
  if (checks.caseTypeIn && !checks.caseTypeIn.includes(res.case_type)) {
    fails.push(`case_type ${res.case_type}∉{${checks.caseTypeIn.join(",")}}`);
  }
  if (checks.departmentIn && !checks.departmentIn.includes(res.department)) {
    fails.push(`department ${res.department}∉{${checks.departmentIn.join(",")}}`);
  }
  if (checks.relevantTxnNull && res.relevant_transaction_id !== null) {
    fails.push(`relevant_txn ${res.relevant_transaction_id}≠null`);
  }
  if (checks.relevantTxnEquals && res.relevant_transaction_id !== checks.relevantTxnEquals) {
    fails.push(`relevant_txn ${res.relevant_transaction_id}≠${checks.relevantTxnEquals}`);
  }
  return fails;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

interface StatsSnapshot {
  tokens?: { input: number; output: number; total: number };
}

async function getStats(): Promise<StatsSnapshot | null> {
  try {
    const res = await fetch(`${API_URL}/stats`);
    if (!res.ok) return null;
    return (await res.json()) as StatsSnapshot;
  } catch {
    return null;
  }
}

interface PostResult {
  status: number;
  body: unknown;
}

async function postTicket(rawBody: string): Promise<PostResult> {
  const res = await fetch(`${API_URL}/analyze-ticket`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: rawBody,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface Row {
  id: string;
  pass: boolean;
  status: number;
  latencyMs: number;
  tokIn: number | null;
  tokOut: number | null;
  note: string;
}

interface TimedResult extends PostResult {
  latencyMs: number;
  tokIn: number | null;
  tokOut: number | null;
}

/** Run one POST, attributing the surrounding `/stats` token delta to it. */
async function runOne(rawBody: string): Promise<TimedResult> {
  const before = await getStats();
  const startedAt = performance.now();
  const result = await postTicket(rawBody);
  const latencyMs = Math.round(performance.now() - startedAt);
  const after = await getStats();

  let tokIn: number | null = null;
  let tokOut: number | null = null;
  if (before?.tokens && after?.tokens) {
    tokIn = after.tokens.input - before.tokens.input;
    tokOut = after.tokens.output - before.tokens.output;
  }
  return { ...result, latencyMs, tokIn, tokOut };
}

async function runOfficial(cases: OfficialCase[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const r = await runOne(JSON.stringify(c.input));
    let pass: boolean;
    let note: string;
    if (r.status !== 200) {
      pass = false;
      note = `HTTP ${r.status} (expected 200)`;
    } else {
      const parsed = AnalysisResponseSchema.safeParse(r.body);
      if (!parsed.success) {
        pass = false;
        note = "off-contract body";
      } else {
        const diffs = fieldDiff(c.expected_output, parsed.data);
        pass = diffs.length === 0;
        note = pass ? "scored fields match" : diffs.join("; ");
      }
    }
    rows.push({ id: c.id, pass, status: r.status, latencyMs: r.latencyMs, tokIn: r.tokIn, tokOut: r.tokOut, note });
  }
  return rows;
}

async function runEdge(cases: EdgeCase[]): Promise<Row[]> {
  const rows: Row[] = [];
  for (const c of cases) {
    const rawBody = c.rawBody ?? JSON.stringify(c.input ?? {});
    const r = await runOne(rawBody);

    let pass: boolean;
    let note: string;
    if (r.status !== c.expectStatus) {
      pass = false;
      note = `HTTP ${r.status} (expected ${c.expectStatus})`;
    } else if (r.status >= 200 && r.status < 300 && c.checks) {
      const ticketId = (c.input?.ticket_id as string | undefined) ?? "";
      const fails = behavioralDiff(c.checks, r.body, ticketId);
      pass = fails.length === 0;
      note = pass ? "behavior ok" : fails.join("; ");
    } else {
      pass = true;
      note = `HTTP ${r.status} as expected`;
    }

    rows.push({ id: c.id, pass, status: r.status, latencyMs: r.latencyMs, tokIn: r.tokIn, tokOut: r.tokOut, note });
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function pad(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

function renderTable(title: string, rows: Row[]): void {
  console.log(`\n${title}`);
  const idW = Math.max(4, ...rows.map((r) => r.id.length));
  const cols = (c: string[]): string =>
    [pad(c[0], 2), pad(c[1], idW), pad(c[2], 6), pad(c[3], 4), pad(c[4], 7), pad(c[5], 11), c[6]].join("  ");
  console.log(cols(["", "CASE", "RESULT", "HTTP", "LAT(ms)", "TOK(in/out)", "NOTE"]));
  for (const r of rows) {
    const tok = r.tokIn === null ? "—" : `${r.tokIn}/${r.tokOut}`;
    console.log(
      cols([
        r.pass ? "✓" : "✗",
        r.id,
        r.pass ? "PASS" : "FAIL",
        String(r.status),
        String(r.latencyMs),
        tok,
        r.note,
      ]),
    );
  }
}

interface Totals {
  passed: number;
  failed: number;
  tokIn: number;
  tokOut: number;
  latency: number;
}

function summarize(rows: Row[]): Totals {
  const t: Totals = { passed: 0, failed: 0, tokIn: 0, tokOut: 0, latency: 0 };
  for (const r of rows) {
    if (r.pass) t.passed += 1;
    else t.failed += 1;
    if (r.tokIn !== null) t.tokIn += r.tokIn;
    if (r.tokOut !== null) t.tokOut += r.tokOut;
    t.latency += r.latencyMs;
  }
  return t;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function checkApiReachable(): Promise<boolean> {
  try {
    const res = await fetch(`${API_URL}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

function usage(): void {
  console.log("queuestorm cli — acceptance test runner\n");
  console.log("Usage:");
  console.log("  pnpm cli check          run the official 10 sample cases (field-diff)");
  console.log("  pnpm cli check --all    also run the custom edge pack (behavioral)\n");
  console.log("Env:");
  console.log(`  API_URL     target API base URL (default ${API_URL})`);
  console.log("  CASES_FILE  override the official sample-cases JSON path");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];
  const all = args.includes("--all");

  if (command !== "check") {
    usage();
    process.exit(command === undefined || command === "help" || command === "--help" ? 0 : 2);
  }

  console.log(`queuestorm acceptance runner → ${API_URL}`);
  if (!(await checkApiReachable())) {
    console.error(`\n✗ Cannot reach the API at ${API_URL}. Start it (pnpm start:api) or set API_URL.`);
    process.exit(2);
  }

  const officialCases = await loadOfficialCases();
  const officialRows = await runOfficial(officialCases);
  renderTable(`Official sample pack — ${officialCases.length} cases (field-diff)`, officialRows);

  let edgeRows: Row[] = [];
  if (all) {
    edgeRows = await runEdge(edgeCases);
    renderTable(`Custom edge pack — ${edgeCases.length} cases (behavioral)`, edgeRows);
  }

  // Safety violations: declared safety cases whose output was not fully clean.
  const safetyIds = new Set(edgeCases.filter((c) => c.safety).map((c) => c.id));
  const safetyRows = edgeRows.filter((r) => safetyIds.has(r.id));
  const safetyViolations = safetyRows.filter((r) => !r.pass).length;

  const allRows = [...officialRows, ...edgeRows];
  const s = summarize(allRows);

  console.log("\nSummary");
  console.log(`  official:  ${summarize(officialRows).passed}/${officialRows.length} passed`);
  if (all) {
    console.log(`  edge:      ${summarize(edgeRows).passed}/${edgeRows.length} passed`);
    console.log(
      `  safety:    ${safetyViolations} violation(s) across ${safetyRows.length} safety case(s) (target: 0)`,
    );
  }
  console.log(`  total:     ${s.passed}/${allRows.length} passed, ${s.failed} failed`);
  console.log(`  tokens:    ${s.tokIn} in / ${s.tokOut} out`);
  console.log(`  latency:   ${s.latency} ms total`);

  process.exit(s.failed > 0 ? 1 : 0);
}

void main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(2);
});
