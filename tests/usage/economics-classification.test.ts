import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toEvidenceTier, combineForAvoidable } from "../../src/usage/economics-classification.js";
import type { ValueWithConfidence } from "../../src/usage/savings.js";

describe("toEvidenceTier", () => {
  it("maps savings.ts's 4-tier SavingsConfidence onto the report's 3-tier vocabulary", () => {
    assert.equal(toEvidenceTier("measured"), "MEASURED");
    assert.equal(toEvidenceTier("historical_estimate"), "ESTIMATED");
    assert.equal(toEvidenceTier("count_based_estimate"), "ESTIMATED");
    assert.equal(toEvidenceTier("unavailable"), "UNKNOWN");
  });
});

describe("combineForAvoidable", () => {
  const measured = (v: number): ValueWithConfidence<number> => ({ value: v, confidence: "measured" });
  const estimated = (v: number): ValueWithConfidence<number> => ({ value: v, confidence: "historical_estimate" });
  const unavailable: ValueWithConfidence<number> = { value: "unknown", confidence: "unavailable" };

  it("CRITICAL: a MEASURED full-workload figure paired with an ESTIMATED selected-workload figure yields ESTIMATED avoidable opportunity - never MEASURED", () => {
    const r = combineForAvoidable(measured(1000), estimated(300));
    assert.equal(r.tier, "ESTIMATED");
    assert.equal(r.value, 700);
  });

  it("both sides MEASURED yields MEASURED avoidable opportunity - the only path to this tier", () => {
    const r = combineForAvoidable(measured(1000), measured(300));
    assert.equal(r.tier, "MEASURED");
    assert.equal(r.value, 700);
  });

  it("either side UNKNOWN yields UNKNOWN avoidable opportunity with no fabricated value", () => {
    const r = combineForAvoidable(measured(1000), unavailable);
    assert.equal(r.tier, "UNKNOWN");
    assert.equal(r.value, undefined);
  });

  it("both sides ESTIMATED yields ESTIMATED, not upgraded by agreement between two weak sources", () => {
    const r = combineForAvoidable(estimated(1000), estimated(400));
    assert.equal(r.tier, "ESTIMATED");
    assert.equal(r.value, 600);
  });

  it("never goes negative even if selected exceeds full (clamped, not a misleading negative number)", () => {
    const r = combineForAvoidable(measured(100), measured(500));
    assert.equal(r.value, 0);
  });

  it("the pure-shadow-mode reality: full is measured, selected is ALWAYS estimated (never executed to measure it) - avoidable is therefore always ESTIMATED at best", () => {
    // This is the exact shape the correction specified: shadow mode never produces a measured selected side.
    const full = measured(94.2 * 3_600_000); // 94.2 runner-hours, measured
    const selected = estimated(14.9 * 3_600_000); // estimated via historical seconds-per-test
    const r = combineForAvoidable(full, selected);
    assert.equal(r.tier, "ESTIMATED");
    assert.notEqual(r.tier, "MEASURED");
  });
});
