import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideActivation } from "../../src/analysis-fanout/activation-gate.js";

describe("decideActivation (economic activation gate)", () => {
  it("RUN_FULL_SUITE when correctness policy doesn't authorize selection, even with favorable timing math", () => {
    // economicallyBeneficial reflects the timing math alone (favorable here); `decision` is what actually
    // gates behavior, and correctness always wins regardless of how good the economics look.
    const r = decideActivation({
      correctnessSafe: false,
      samples: [{ fullMs: 100_000, selectedMs: 1_000 }],
      analysisOverheadMs: 100,
      executionPlanningOverheadMs: 0,
      uncertaintyMarginFraction: 0,
    });
    assert.equal(r.decision, "RUN_FULL_SUITE");
    assert.equal(r.economicallyBeneficial, true);
  });

  it("SAFE_TO_PROPOSE (not RUN_FULL_SUITE) with zero samples and correctness-safe input - never assumes benefit from nothing", () => {
    const r = decideActivation({
      correctnessSafe: true,
      samples: [],
      analysisOverheadMs: 8_500,
      executionPlanningOverheadMs: 0,
      uncertaintyMarginFraction: 0.05,
    });
    assert.equal(r.decision, "SAFE_TO_PROPOSE");
    assert.equal(r.lowConfidence, true);
    assert.equal(r.predictedGrossSavingsMs, 0);
  });

  it("the real cal.com PR #29940 numbers: safe but NOT economically beneficial (SAFE_TO_PROPOSE, never EXECUTE_SELECTIVELY)", () => {
    const r = decideActivation({
      correctnessSafe: true,
      samples: [{ fullMs: 260_400, selectedMs: 260_532 }],
      analysisOverheadMs: 8_512,
      executionPlanningOverheadMs: 0,
      uncertaintyMarginFraction: 0.02,
    });
    assert.equal(r.decision, "SAFE_TO_PROPOSE");
    assert.equal(r.economicallyBeneficial, false);
    assert.ok(r.predictedGrossSavingsMs < 0); // selected was actually slightly SLOWER
    assert.equal(r.lowConfidence, true);
  });

  it("EXECUTE_SELECTIVELY when gross savings clearly exceed overhead + margin, with enough samples for full confidence", () => {
    const r = decideActivation({
      correctnessSafe: true,
      samples: [
        { fullMs: 300_000, selectedMs: 20_000 },
        { fullMs: 305_000, selectedMs: 19_000 },
        { fullMs: 298_000, selectedMs: 21_000 },
      ],
      analysisOverheadMs: 8_000,
      executionPlanningOverheadMs: 2_000,
      uncertaintyMarginFraction: 0.05,
    });
    assert.equal(r.decision, "EXECUTE_SELECTIVELY");
    assert.equal(r.lowConfidence, false);
    assert.ok(r.netSavingsMs > 0);
  });

  it("uses the median across samples, not the best (or worst) individual run", () => {
    const r = decideActivation({
      correctnessSafe: true,
      samples: [
        { fullMs: 100_000, selectedMs: 90_000 }, // an outlier, barely any savings
        { fullMs: 100_000, selectedMs: 10_000 },
        { fullMs: 100_000, selectedMs: 12_000 },
      ],
      analysisOverheadMs: 1_000,
      executionPlanningOverheadMs: 0,
      uncertaintyMarginFraction: 0,
    });
    assert.equal(r.predictedSelectiveDurationMs, 12_000); // median of [90000,10000,12000] is 12000
  });

  it("the uncertainty margin scales with the predicted full duration, not a flat constant", () => {
    const small = decideActivation({ correctnessSafe: true, samples: [{ fullMs: 10_000, selectedMs: 1_000 }], analysisOverheadMs: 0, executionPlanningOverheadMs: 0, uncertaintyMarginFraction: 0.1 });
    const large = decideActivation({ correctnessSafe: true, samples: [{ fullMs: 1_000_000, selectedMs: 100_000 }], analysisOverheadMs: 0, executionPlanningOverheadMs: 0, uncertaintyMarginFraction: 0.1 });
    assert.equal(small.uncertaintyMarginMs, 1_000);
    assert.equal(large.uncertaintyMarginMs, 100_000);
  });

  it("a single sample is used as real evidence but always flagged lowConfidence; 3+ samples are not", () => {
    const one = decideActivation({ correctnessSafe: true, samples: [{ fullMs: 10_000, selectedMs: 1_000 }], analysisOverheadMs: 0, executionPlanningOverheadMs: 0, uncertaintyMarginFraction: 0 });
    const three = decideActivation({ correctnessSafe: true, samples: [{ fullMs: 10_000, selectedMs: 1_000 }, { fullMs: 10_000, selectedMs: 1_000 }, { fullMs: 10_000, selectedMs: 1_000 }], analysisOverheadMs: 0, executionPlanningOverheadMs: 0, uncertaintyMarginFraction: 0 });
    assert.equal(one.lowConfidence, true);
    assert.equal(three.lowConfidence, false);
  });

  it("the break-even (requiredSavingsMs) is exactly overhead + planning + margin, auditable from the result alone", () => {
    const r = decideActivation({
      correctnessSafe: true,
      samples: [{ fullMs: 200_000, selectedMs: 50_000 }],
      analysisOverheadMs: 5_000,
      executionPlanningOverheadMs: 3_000,
      uncertaintyMarginFraction: 0.05, // 5% of 200,000 = 10,000
    });
    assert.equal(r.requiredSavingsMs, 18_000);
    assert.equal(r.predictedGrossSavingsMs, 150_000);
    assert.equal(r.netSavingsMs, 132_000);
    assert.equal(r.decision, "EXECUTE_SELECTIVELY");
  });
});
