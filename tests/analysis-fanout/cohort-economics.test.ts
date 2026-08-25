import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEffectiveExecutionPlan } from "../../src/analysis-fanout/execution-plan.js";
import { computeCohortWorkload } from "../../src/analysis-fanout/cohort-economics.js";

describe("computeCohortWorkload", () => {
  it("empty cohort - cohortAddedWallMsApprox is 0 (known, not undefined), affectedOnlyWallMsApprox equals effectiveWallMs", () => {
    const plan = buildEffectiveExecutionPlan(["a.spec.ts"], []);
    const w = computeCohortWorkload(plan, {}, 5000);
    assert.equal(w.cohortAddedFileCount, 0);
    assert.equal(w.cohortAddedWallMsApprox, 0);
    assert.equal(w.affectedOnlyWallMsApprox, 5000);
  });

  it("real per-file durations known for every cohort-only file - a genuine approximate split", () => {
    const plan = buildEffectiveExecutionPlan(["affected.spec.ts"], ["cohort1.spec.ts", "cohort2.spec.ts"]);
    const w = computeCohortWorkload(plan, { "cohort1.spec.ts": 1000, "cohort2.spec.ts": 1500, "affected.spec.ts": 2000 }, 5000);
    assert.equal(w.cohortAddedFileCount, 2);
    assert.equal(w.cohortAddedWallMsApprox, 2500); // 1000 + 1500
    assert.equal(w.affectedOnlyWallMsApprox, 2500); // 5000 - 2500
  });

  it("a cohort-only file with an UNKNOWN duration makes the whole approximation undefined - never a silently-understated partial sum", () => {
    const plan = buildEffectiveExecutionPlan(["affected.spec.ts"], ["cohort1.spec.ts", "cohort2.spec.ts"]);
    const w = computeCohortWorkload(plan, { "cohort1.spec.ts": 1000 /* cohort2.spec.ts missing */ }, 5000);
    assert.equal(w.cohortAddedWallMsApprox, undefined);
    assert.equal(w.affectedOnlyWallMsApprox, undefined);
  });

  it("a file that is BOTH affected and cohort is never counted as cohort-added cost - it was going to run anyway", () => {
    const plan = buildEffectiveExecutionPlan(["shared.spec.ts"], ["shared.spec.ts"]);
    const w = computeCohortWorkload(plan, { "shared.spec.ts": 3000 }, 3000);
    assert.equal(w.cohortAddedFileCount, 0);
    assert.equal(w.cohortAddedWallMsApprox, 0);
  });

  it("affectedOnlyWallMsApprox never goes negative even if the (approximate) cohort cost exceeds the total - clamped, not a misleading negative number", () => {
    const plan = buildEffectiveExecutionPlan(["a.spec.ts"], ["b.spec.ts"]);
    // Deliberately inconsistent inputs (cohort file duration bigger than the whole run's wallMs) to prove the clamp.
    const w = computeCohortWorkload(plan, { "b.spec.ts": 9999 }, 100);
    assert.equal(w.affectedOnlyWallMsApprox, 0);
  });

  it("effectiveWallMs is always the real passed-in wall time, unconditionally - the actual execution plan's real cost", () => {
    const plan = buildEffectiveExecutionPlan(["a.spec.ts"], ["b.spec.ts", "c.spec.ts"]);
    const w = computeCohortWorkload(plan, {}, 42_000);
    assert.equal(w.effectiveWallMs, 42_000);
    assert.equal(w.effectiveFileCount, 3);
  });
});
