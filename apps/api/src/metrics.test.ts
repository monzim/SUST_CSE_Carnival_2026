import { describe, it, expect } from "vitest";
import { createMetrics } from "./metrics.js";

describe("metrics", () => {
  it("aggregates totals, case types, flags, and token sums", () => {
    const metrics = createMetrics();

    metrics.record({
      case_type: "wrong_transfer",
      safety_flag: true,
      fallback: false,
      cache_hit: false,
      tokens_in: 100,
      tokens_out: 40,
    });
    metrics.record({
      case_type: "wrong_transfer",
      safety_flag: false,
      fallback: true,
      cache_hit: false,
      tokens_in: 50,
      tokens_out: 10,
    });
    metrics.record({
      case_type: "refund_request",
      safety_flag: false,
      fallback: false,
      cache_hit: true,
      tokens_in: 0,
      tokens_out: 0,
    });

    const snap = metrics.snapshot();
    expect(snap.total).toBe(3);
    expect(snap.by_case_type.wrong_transfer).toBe(2);
    expect(snap.by_case_type.refund_request).toBe(1);
    // Every case type is present in the shape, even unseen ones.
    expect(snap.by_case_type.phishing_or_social_engineering).toBe(0);
    expect(snap.safety_flags).toBe(1);
    expect(snap.fallbacks).toBe(1);
    expect(snap.cache_hits).toBe(1);
    expect(snap.tokens).toEqual({ input: 150, output: 50, total: 200 });
  });

  it("starts at zero", () => {
    const snap = createMetrics().snapshot();
    expect(snap.total).toBe(0);
    expect(snap.tokens.total).toBe(0);
  });
});
