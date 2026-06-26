/**
 * In-process aggregate counters for the QueueStorm API.
 *
 * These power the `GET /stats` endpoint and are pure, dependency-free, and
 * non-blocking: recording a request is a synchronous counter bump that can never
 * fail or slow down the request path. The snapshot exposes only aggregate counts
 * and token sums — never any ticket content, secrets, or credentials.
 */
import { CaseType, type AnalysisResponse } from "@queuestorm/core";

type CaseTypeValue = AnalysisResponse["case_type"];

/** One request's observability signals, fed to {@link Metrics.record}. */
export interface RequestRecord {
  case_type: CaseTypeValue;
  safety_flag: boolean;
  fallback: boolean;
  cache_hit: boolean;
  tokens_in: number;
  tokens_out: number;
}

/** Aggregate snapshot returned by `GET /stats`. Secret-safe by construction. */
export interface MetricsSnapshot {
  total: number;
  by_case_type: Record<CaseTypeValue, number>;
  safety_flags: number;
  fallbacks: number;
  cache_hits: number;
  tokens: { input: number; output: number; total: number };
}

export interface Metrics {
  record(record: RequestRecord): void;
  snapshot(): MetricsSnapshot;
}

/** Build a fresh per-case-type counter map with every case type at zero. */
function emptyByCaseType(): Record<CaseTypeValue, number> {
  return Object.fromEntries(
    CaseType.options.map((c) => [c, 0]),
  ) as Record<CaseTypeValue, number>;
}

/** Create an in-memory metrics aggregator. */
export function createMetrics(): Metrics {
  let total = 0;
  let safetyFlags = 0;
  let fallbacks = 0;
  let cacheHits = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  const byCaseType = emptyByCaseType();

  return {
    record(r) {
      total += 1;
      byCaseType[r.case_type] = (byCaseType[r.case_type] ?? 0) + 1;
      if (r.safety_flag) safetyFlags += 1;
      if (r.fallback) fallbacks += 1;
      if (r.cache_hit) cacheHits += 1;
      tokensIn += r.tokens_in;
      tokensOut += r.tokens_out;
    },
    snapshot() {
      return {
        total,
        by_case_type: { ...byCaseType },
        safety_flags: safetyFlags,
        fallbacks,
        cache_hits: cacheHits,
        tokens: {
          input: tokensIn,
          output: tokensOut,
          total: tokensIn + tokensOut,
        },
      };
    },
  };
}
