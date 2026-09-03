import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { aggregateSavings, computeSavingsForPrediction } from "../../src/usage/savings.js";
import { createDefaultComputeCostModel } from "../../src/usage/cost-model.js";
import { createDefaultClimateImpactModel } from "../../src/usage/climate-model.js";
import type { ShadowPredictionSummary } from "../../src/product/shadow-read-boundary.js";

function prediction(overrides: Partial<ShadowPredictionSummary> = {}): ShadowPredictionSummary {
  return {
    logicalDeltaKey: "k1",
    repository: "acme/web",
    headSha: "a".repeat(40),
    planMode: "SELECTIVE",
    opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY",
    testsSelectedDiffci: 9,
    testsTotalFull: 46,
    testsSelectedPath: 46,
    diffciAnalysisOverheadMs: 250,
    createdAt: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

describe("computeSavingsForPrediction - Part 8/9", () => {
  it("work reduction and tests avoided are 'measured' - directly derived from real counts", () => {
    const savings = computeSavingsForPrediction(prediction());
    assert.equal(savings.workReductionPercent.confidence, "measured");
    assert.ok(typeof savings.workReductionPercent.value === "number");
    assert.ok(Math.abs((savings.workReductionPercent.value as number) - (1 - 9 / 46) * 100) < 1e-9);
    assert.equal(savings.testsAvoided.value, 37);
    assert.equal(savings.testsAvoided.confidence, "measured");
  });

  it("compute/cost/carbon-avoided are 'unavailable' with value 'unknown' when no duration assumption is supplied - never invented", () => {
    const savings = computeSavingsForPrediction(prediction());
    assert.equal(savings.estimatedComputeSecondsAvoided.value, "unknown");
    assert.equal(savings.estimatedComputeSecondsAvoided.confidence, "unavailable");
    assert.equal(savings.estimatedCostAvoidedUsd.value, "unknown");
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.value, "unknown");
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.confidence, "unavailable");
  });

  it("carbon-avoided stays 'unavailable' even with a duration assumption when no climate model is supplied", () => {
    const savings = computeSavingsForPrediction(prediction(), { averageSecondsPerAvoidedTest: 2 });
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.value, "unknown");
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.confidence, "unavailable");
  });

  it("carbon-avoided is derived from the climate model when both a duration assumption and a climate model are supplied, tagged as count_based_estimate", () => {
    const climateModel = createDefaultClimateImpactModel();
    const savings = computeSavingsForPrediction(prediction(), { averageSecondsPerAvoidedTest: 2, climateModel });
    const expected = climateModel.estimateCarbon({ computeSeconds: 74 }).estimatedKgCo2e; // 37 tests * 2s
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.value, expected);
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.confidence, "count_based_estimate");
  });

  it("compute-avoided becomes a count_based_estimate when a duration assumption is supplied", () => {
    const savings = computeSavingsForPrediction(prediction(), { averageSecondsPerAvoidedTest: 2 });
    assert.equal(savings.estimatedComputeSecondsAvoided.value, 74); // 37 tests * 2s
    assert.equal(savings.estimatedComputeSecondsAvoided.confidence, "count_based_estimate");
  });

  it("a real historical duration assumption is honestly tagged 'historical_estimate', not upgraded to 'measured' or left at the placeholder tier", () => {
    const savings = computeSavingsForPrediction(prediction(), { averageSecondsPerAvoidedTest: { seconds: 2, confidence: "historical_estimate" } });
    assert.equal(savings.estimatedComputeSecondsAvoided.value, 74);
    assert.equal(savings.estimatedComputeSecondsAvoided.confidence, "historical_estimate");
  });

  it("cost-avoided is derived from the compute-cost model when both are supplied, tagged as count_based_estimate", () => {
    const savings = computeSavingsForPrediction(prediction(), { averageSecondsPerAvoidedTest: 2, costModel: createDefaultComputeCostModel(0.001) });
    assert.equal(savings.estimatedCostAvoidedUsd.value, 74 * 0.001);
    assert.equal(savings.estimatedCostAvoidedUsd.confidence, "count_based_estimate");
  });

  it("a prediction with zero total tests returns 'unknown' everywhere rather than dividing by zero", () => {
    const savings = computeSavingsForPrediction(prediction({ testsTotalFull: 0, testsSelectedDiffci: 0 }));
    assert.equal(savings.workReductionPercent.value, "unknown");
    assert.equal(savings.workReductionPercent.confidence, "unavailable");
    assert.equal(savings.estimatedCarbonAvoidedKgCo2e.value, "unknown");
  });
});

describe("aggregateSavings", () => {
  it("returns 'unavailable' for an empty batch, never a false zero", () => {
    const agg = aggregateSavings([]);
    assert.equal(agg.predictionsConsidered, 0);
    assert.equal(agg.medianWorkReductionPercent.value, "unknown");
  });

  it("computes a real median across several predictions", () => {
    const savingsList = [
      computeSavingsForPrediction(prediction({ testsSelectedDiffci: 0, testsTotalFull: 46 })), // 100%
      computeSavingsForPrediction(prediction({ testsSelectedDiffci: 23, testsTotalFull: 46 })), // 50%
      computeSavingsForPrediction(prediction({ testsSelectedDiffci: 46, testsTotalFull: 46 })), // 0%
    ];
    const agg = aggregateSavings(savingsList);
    assert.equal(agg.medianWorkReductionPercent.value, 50);
    assert.equal(agg.predictionsConsidered, 3);
  });

  it("aggregate confidence for a sum is the weakest confidence among its contributors", () => {
    const withDuration = computeSavingsForPrediction(prediction(), { averageSecondsPerAvoidedTest: 2 });
    const withoutDuration = computeSavingsForPrediction(prediction());
    const agg = aggregateSavings([withDuration, withoutDuration]);
    // withoutDuration contributes "unknown" (filtered out of the numeric sum), so the sum here is only
    // over the one numeric contributor - still tagged with ITS confidence, not silently upgraded.
    assert.equal(agg.totalEstimatedComputeSecondsAvoided.confidence, "count_based_estimate");
  });

  it("totals carbon-avoided across predictions the same way it totals cost-avoided", () => {
    const climateModel = createDefaultClimateImpactModel();
    const savingsList = [
      computeSavingsForPrediction(prediction({ testsSelectedDiffci: 0, testsTotalFull: 46 }), { averageSecondsPerAvoidedTest: 2, climateModel }),
      computeSavingsForPrediction(prediction({ testsSelectedDiffci: 23, testsTotalFull: 46 }), { averageSecondsPerAvoidedTest: 2, climateModel }),
    ];
    const agg = aggregateSavings(savingsList);
    const expectedTotal = (savingsList[0]!.estimatedCarbonAvoidedKgCo2e.value as number) + (savingsList[1]!.estimatedCarbonAvoidedKgCo2e.value as number);
    assert.equal(agg.totalEstimatedCarbonAvoidedKgCo2e.value, expectedTotal);
    assert.equal(agg.totalEstimatedCarbonAvoidedKgCo2e.confidence, "count_based_estimate");
  });

  it("carbon-avoided total is 'unavailable' for an empty batch", () => {
    const agg = aggregateSavings([]);
    assert.equal(agg.totalEstimatedCarbonAvoidedKgCo2e.value, "unknown");
    assert.equal(agg.totalEstimatedCarbonAvoidedKgCo2e.confidence, "unavailable");
  });
});
