import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeTimeToSignal, estimateAvoidedDownstreamWork, computePreflightOverhead } from "../../src/preflight/metrics.js";

describe("computeTimeToSignal - Part F", () => {
  it("sums preflight check durations and marks 'estimated' when durations came from the registry, not real execution", () => {
    const result = computeTimeToSignal({ preflightCheckDurationsMs: [200, 8000], wereDurationsMeasured: false, actualTimeToFailureMs: 45_000 });
    assert.equal(result.preflightSignalTimeMs.value, 8200);
    assert.equal(result.preflightSignalTimeMs.confidence, "estimated");
  });

  it("marks 'measured' when durations came from real execution", () => {
    const result = computeTimeToSignal({ preflightCheckDurationsMs: [180, 7600], wereDurationsMeasured: true, actualTimeToFailureMs: 45_000 });
    assert.equal(result.preflightSignalTimeMs.confidence, "measured");
  });

  it("improvementMs is unknown, never fabricated, when actualTimeToFailureMs is not captured", () => {
    const result = computeTimeToSignal({ preflightCheckDurationsMs: [200], wereDurationsMeasured: false });
    assert.equal(result.improvementMs.value, "unknown");
    assert.equal(result.improvementMs.confidence, "unknown");
  });

  it("real regression scenario: Preflight's runtime_parity check (fast) vs. the real ~71s CI failure time is a large positive improvement", () => {
    const result = computeTimeToSignal({ preflightCheckDurationsMs: [200], wereDurationsMeasured: false, actualTimeToFailureMs: 71_000 });
    assert.equal(result.improvementMs.value, 70_800);
  });

  it("improvement can be negative (a slow preflight check outpaced by a fast real failure) - reported honestly, not clamped", () => {
    const result = computeTimeToSignal({ preflightCheckDurationsMs: [50_000], wereDurationsMeasured: false, actualTimeToFailureMs: 5_000 });
    assert.equal(result.improvementMs.value, -45_000);
  });

  it("improvement confidence never exceeds the signal time's own confidence", () => {
    const result = computeTimeToSignal({ preflightCheckDurationsMs: [200], wereDurationsMeasured: false, actualTimeToFailureMs: 1000 });
    assert.equal(result.improvementMs.confidence, result.preflightSignalTimeMs.confidence);
  });
});

describe("estimateAvoidedDownstreamWork - Part F, only TP ever claims avoided work", () => {
  it("TP: returns the full workflow duration as an 'estimated' (never 'measured') counterfactual", () => {
    const result = estimateAvoidedDownstreamWork({ outcome: "TP", totalWorkflowDurationMs: 86_000 });
    assert.equal(result.value, 86_000);
    assert.equal(result.confidence, "estimated");
  });

  it("TN/FP/FN/NOT_EVALUABLE all return unknown - no avoided-work claim to make", () => {
    for (const outcome of ["TN", "FP", "FN", "NOT_EVALUABLE"] as const) {
      const result = estimateAvoidedDownstreamWork({ outcome, totalWorkflowDurationMs: 86_000 });
      assert.equal(result.value, "unknown", `outcome=${outcome}`);
      assert.equal(result.confidence, "unknown", `outcome=${outcome}`);
    }
  });
});

describe("computePreflightOverhead - Part F successful-commit overhead tracking", () => {
  it("uses real measured durations when available, marked 'measured'", () => {
    const result = computePreflightOverhead({ measuredCheckDurationsMs: [190, 7800], estimatedCheckDurationsMs: [200, 8000] });
    assert.equal(result.value, 7990);
    assert.equal(result.confidence, "measured");
  });

  it("falls back to registry estimates, marked 'estimated', when no real measurement exists", () => {
    const result = computePreflightOverhead({ estimatedCheckDurationsMs: [200, 8000] });
    assert.equal(result.value, 8200);
    assert.equal(result.confidence, "estimated");
  });

  it("zero planned checks is genuinely zero overhead, marked 'measured' (nothing to estimate)", () => {
    const result = computePreflightOverhead({ estimatedCheckDurationsMs: [] });
    assert.equal(result.value, 0);
    assert.equal(result.confidence, "measured");
  });
});
