/**
 * Acceptance tests for the M2 estimator (src/usage/economics-estimator.ts). These pin the invariants that
 * make the number safe to show a repository maintainer - above all that a plan which executed everything
 * can never be reported as having avoided anything.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { estimateStageEconomics, ESTIMATOR_VERSION } from "../../src/usage/economics-estimator.js";

describe("estimateStageEconomics - M2 acceptance", () => {
  // (1) The exact row that exposed v1 as wrong: FULL, 70/70, 63s measured.
  it("FULL plan selecting 70/70 of a 63s suite -> selected 63s, avoidable EXACTLY 0", () => {
    const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 63_000, testsSelectedDiffci: 70, testsTotalFull: 70, planMode: "FULL" });
    assert.equal(r.selectedWorkloadMs, 63_000);
    assert.equal(r.avoidableMs, 0, "v1 reported 28s here purely from cross-commit variance - a FULL plan avoids nothing");
    assert.equal(r.avoidableTier, "ESTIMATED");
  });

  // (2) The genuinely interesting case: 1 of 70 selected against a 35s measured suite.
  it("SELECTIVE 1/70 of a 35s suite -> selected 0.5s, avoidable 34.5s (98.6% projected reduction)", () => {
    const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 35_000, testsSelectedDiffci: 1, testsTotalFull: 70, planMode: "SELECTIVE" });
    assert.equal(r.selectedWorkloadMs, 500);
    assert.equal(r.avoidableMs, 34_500);
    assert.equal(r.avoidableTier, "ESTIMATED", "still a projection - shadow mode never executed the selected subset");
  });

  // (3) Inconsistent counts must never produce negative savings.
  it("selected exceeding total is clamped to the full workload - never a negative avoidable", () => {
    const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 40_000, testsSelectedDiffci: 99, testsTotalFull: 70, planMode: "SELECTIVE" });
    assert.equal(r.selectedWorkloadMs, 40_000);
    assert.equal(r.avoidableMs, 0);
    assert.ok((r.avoidableMs ?? 0) >= 0);
  });

  // (4) Missing / zero / non-finite totals -> refuse.
  it("refuses to estimate when the total is missing, zero or non-finite", () => {
    for (const total of [undefined, 0, -5, Number.NaN]) {
      const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 40_000, testsSelectedDiffci: 3, testsTotalFull: total as number | undefined, planMode: "SELECTIVE" });
      assert.equal(r.avoidableTier, "UNKNOWN", `total=${String(total)} must refuse`);
      assert.equal(r.avoidableMs, undefined);
      assert.equal(r.selectedWorkloadMs, undefined);
    }
  });

  it("refuses when the selected count is missing or negative", () => {
    for (const selected of [undefined, -1, Number.NaN]) {
      const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 40_000, testsSelectedDiffci: selected as number | undefined, testsTotalFull: 70, planMode: "SELECTIVE" });
      assert.equal(r.avoidableTier, "UNKNOWN");
    }
  });

  // (5) The ratio model must never touch a stage DiffCI cannot reason about.
  it("never applies the test-ratio model to a non-test stage, even with perfectly valid counts", () => {
    for (const stage of ["build", "lint", "typecheck", "e2e", "other"] as const) {
      const r = estimateStageEconomics({ stage, fullWorkloadMs: 90_000, testsSelectedDiffci: 1, testsTotalFull: 70, planMode: "SELECTIVE" });
      assert.equal(r.avoidableTier, "UNKNOWN", `${stage} must stay UNKNOWN`);
      assert.equal(r.avoidableMs, undefined);
      assert.equal(r.selectedWorkloadMs, undefined);
    }
  });

  it("NEVER returns a MEASURED tier - shadow mode cannot measure a counterfactual", () => {
    const cases = [
      { selected: 1, total: 70, plan: "SELECTIVE" as const },
      { selected: 70, total: 70, plan: "FULL" as const },
      { selected: 35, total: 70, plan: "SELECTIVE" as const },
    ];
    for (const c of cases) {
      const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 50_000, testsSelectedDiffci: c.selected, testsTotalFull: c.total, planMode: c.plan });
      assert.notEqual(r.avoidableTier, "MEASURED");
      assert.equal(r.selectedWorkloadConfidence, "count_based_estimate");
    }
  });

  it("selected workload always lands inside [0, fullWorkloadMs]", () => {
    for (const selected of [0, 1, 35, 69, 70, 1000]) {
      const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 63_000, testsSelectedDiffci: selected, testsTotalFull: 70, planMode: "SELECTIVE" });
      const v = r.selectedWorkloadMs ?? 0;
      assert.ok(v >= 0 && v <= 63_000, `selected ${v} out of range for ${selected}/70`);
    }
  });

  it("stamps the estimation method with the estimator version and the real ratio, for auditability", () => {
    const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 35_000, testsSelectedDiffci: 1, testsTotalFull: 70, planMode: "SELECTIVE" });
    assert.equal(r.estimationMethod, `linear_within_commit_ratio_v${ESTIMATOR_VERSION}:1/70`);
  });

  it("a SELECTIVE plan that happens to select every test still avoids nothing", () => {
    const r = estimateStageEconomics({ stage: "test", fullWorkloadMs: 63_000, testsSelectedDiffci: 70, testsTotalFull: 70, planMode: "SELECTIVE" });
    assert.equal(r.avoidableMs, 0, "the counts decide this, not just plan_mode");
  });
});
