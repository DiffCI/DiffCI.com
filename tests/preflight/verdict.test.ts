import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computePreflightVerdict, buildPreflightSummary, DEFAULT_VERDICT_THRESHOLDS } from "../../src/preflight/verdict.js";

describe("computePreflightVerdict - Part J, exactly three advisory verdicts", () => {
  it("below warnAtOrAbove is PASS", () => {
    assert.equal(computePreflightVerdict(0), "PASS");
    assert.equal(computePreflightVerdict(2), "PASS");
  });
  it("at or above warnAtOrAbove but below highRiskAtOrAbove is WARN", () => {
    assert.equal(computePreflightVerdict(3), "WARN");
    assert.equal(computePreflightVerdict(5), "WARN");
  });
  it("at or above highRiskAtOrAbove is HIGH_RISK", () => {
    assert.equal(computePreflightVerdict(6), "HIGH_RISK");
    assert.equal(computePreflightVerdict(100), "HIGH_RISK");
  });
  it("a confirmed runtime-parity mismatch's real weight (7) alone reaches HIGH_RISK", () => {
    assert.equal(computePreflightVerdict(7), "HIGH_RISK");
  });
  it("custom thresholds are respected", () => {
    assert.equal(computePreflightVerdict(10, { warnAtOrAbove: 20, highRiskAtOrAbove: 30 }), "PASS");
  });
  it("throws on an internally inconsistent threshold config rather than silently misbehaving", () => {
    assert.throws(() => computePreflightVerdict(5, { warnAtOrAbove: 10, highRiskAtOrAbove: 5 }));
  });
  it("the verdict type surface only ever admits PASS/WARN/HIGH_RISK - no fourth value is reachable", () => {
    const seen = new Set<string>();
    for (let score = -5; score <= 20; score++) seen.add(computePreflightVerdict(score));
    assert.deepEqual([...seen].sort(), ["HIGH_RISK", "PASS", "WARN"]);
  });
});

describe("buildPreflightSummary - always carries the advisory notice", () => {
  it("every summary, regardless of verdict, includes the non-enforcement advisory notice", () => {
    for (const score of [0, 4, 10]) {
      const summary = buildPreflightSummary({ failureRiskScore: score, riskReasons: [], recommendedCheckIds: [] });
      assert.match(summary.advisoryNotice, /does not block, cancel, or skip CI/);
    }
  });

  it("reflects the real inputs verbatim, never altering risk reasons or recommended checks", () => {
    const summary = buildPreflightSummary({ failureRiskScore: 7, riskReasons: [{ signal: "runtime_parity_confirmed_mismatch", weight: 7, detail: "d" }], recommendedCheckIds: ["runtime_parity"] });
    assert.equal(summary.verdict, "HIGH_RISK");
    assert.deepEqual(summary.recommendedCheckIds, ["runtime_parity"]);
  });
});

describe("DEFAULT_VERDICT_THRESHOLDS sanity", () => {
  it("highRiskAtOrAbove is never less than warnAtOrAbove", () => {
    assert.ok(DEFAULT_VERDICT_THRESHOLDS.highRiskAtOrAbove >= DEFAULT_VERDICT_THRESHOLDS.warnAtOrAbove);
  });
});
