/**
 * Counterfactual CI savings (Part 8/9) built from Stage 2F's real shadow prediction evidence, read only
 * via src/product/shadow-read-boundary.ts. Every numeric result is tagged with a confidence/source level
 * (Part 9) - nothing is presented as more certain than the underlying evidence supports, and a value
 * this module cannot honestly compute is returned as the literal string "unknown" rather than a
 * fabricated number (Part 8: "If evidence is insufficient, return unknown rather than inventing
 * precision").
 */
import type { ComputeCostModel } from "./cost-model.js";
import type { ShadowPredictionSummary } from "../product/shadow-read-boundary.js";

export type SavingsConfidence = "measured" | "historical_estimate" | "count_based_estimate" | "unavailable";

export interface ValueWithConfidence<T> {
  value: T | "unknown";
  confidence: SavingsConfidence;
}

export interface PredictionSavings {
  logicalDeltaKey: string;
  /** 1 - selected/total. Directly derived from the real recorded selection - always "measured" when a
   * prediction exists at all (there is nothing to estimate here; these are the actual counted numbers
   * DiffCI itself produced, not a projection). */
  workReductionPercent: ValueWithConfidence<number>;
  testsAvoided: ValueWithConfidence<number>;
  /** Only computable when a per-test duration assumption is supplied (Part 8: "Where reliable
   * historical execution durations exist, estimate... Prefer actual test/job history over uniform
   * assumptions"). This module does NOT currently have access to real per-test historical timing data
   * (no such column exists in shadow_predictions/shadow_ground_truth today - confirmed by the schema),
   * so the best available confidence level here is "count_based_estimate" (a uniform assumption applied
   * to a real, measured count of avoided tests), never "historical_estimate" - that would require wiring
   * real per-test duration history, which is future work (see the final report's remaining blockers).
   */
  estimatedComputeSecondsAvoided: ValueWithConfidence<number>;
  estimatedCostAvoidedUsd: ValueWithConfidence<number>;
}

export interface SavingsOptions {
  /** A uniform seconds-per-avoided-test assumption. Omit to get "unavailable" for the
   * compute/cost-avoided fields rather than a silently invented number. */
  averageSecondsPerAvoidedTest?: number;
  costModel?: ComputeCostModel;
}

export function computeSavingsForPrediction(prediction: ShadowPredictionSummary, options: SavingsOptions = {}): PredictionSavings {
  const { testsSelectedDiffci, testsTotalFull, logicalDeltaKey } = prediction;

  if (testsTotalFull <= 0) {
    // No real baseline to compare against - genuinely cannot say anything about reduction (Part 8: do
    // not invent precision).
    return {
      logicalDeltaKey,
      workReductionPercent: { value: "unknown", confidence: "unavailable" },
      testsAvoided: { value: "unknown", confidence: "unavailable" },
      estimatedComputeSecondsAvoided: { value: "unknown", confidence: "unavailable" },
      estimatedCostAvoidedUsd: { value: "unknown", confidence: "unavailable" },
    };
  }

  const workReductionPercent = Math.max(0, 1 - testsSelectedDiffci / testsTotalFull) * 100;
  const testsAvoided = Math.max(0, testsTotalFull - testsSelectedDiffci);

  let estimatedComputeSecondsAvoided: ValueWithConfidence<number> = { value: "unknown", confidence: "unavailable" };
  let estimatedCostAvoidedUsd: ValueWithConfidence<number> = { value: "unknown", confidence: "unavailable" };

  if (typeof options.averageSecondsPerAvoidedTest === "number" && options.averageSecondsPerAvoidedTest >= 0) {
    const seconds = testsAvoided * options.averageSecondsPerAvoidedTest;
    estimatedComputeSecondsAvoided = { value: seconds, confidence: "count_based_estimate" };
    if (options.costModel) {
      const estimate = options.costModel.estimateCost({ computeSeconds: seconds });
      estimatedCostAvoidedUsd = { value: estimate.estimatedUsd, confidence: "count_based_estimate" };
    }
  }

  return {
    logicalDeltaKey,
    workReductionPercent: { value: workReductionPercent, confidence: "measured" },
    testsAvoided: { value: testsAvoided, confidence: "measured" },
    estimatedComputeSecondsAvoided,
    estimatedCostAvoidedUsd,
  };
}

export interface AggregateSavings {
  predictionsConsidered: number;
  medianWorkReductionPercent: ValueWithConfidence<number>;
  totalTestsAvoided: ValueWithConfidence<number>;
  totalEstimatedComputeSecondsAvoided: ValueWithConfidence<number>;
  totalEstimatedCostAvoidedUsd: ValueWithConfidence<number>;
}

/** Aggregates a batch of per-prediction savings (e.g. "this month") - confidence of an aggregate field
 * is the WEAKEST confidence among its inputs (never stronger than any individual contributor), and an
 * aggregate over zero predictions is "unavailable", not zero-with-false-confidence. */
export function aggregateSavings(perPrediction: PredictionSavings[]): AggregateSavings {
  if (perPrediction.length === 0) {
    return {
      predictionsConsidered: 0,
      medianWorkReductionPercent: { value: "unknown", confidence: "unavailable" },
      totalTestsAvoided: { value: "unknown", confidence: "unavailable" },
      totalEstimatedComputeSecondsAvoided: { value: "unknown", confidence: "unavailable" },
      totalEstimatedCostAvoidedUsd: { value: "unknown", confidence: "unavailable" },
    };
  }

  const reductions = perPrediction.map((p) => p.workReductionPercent.value).filter((v): v is number => typeof v === "number").sort((a, b) => a - b);
  const median = reductions.length ? (reductions.length % 2 === 0 ? (reductions[reductions.length / 2 - 1]! + reductions[reductions.length / 2]!) / 2 : reductions[(reductions.length - 1) / 2]!) : undefined;

  return {
    predictionsConsidered: perPrediction.length,
    medianWorkReductionPercent: median !== undefined ? { value: median, confidence: "measured" } : { value: "unknown", confidence: "unavailable" },
    totalTestsAvoided: sumField(perPrediction, (p) => p.testsAvoided),
    totalEstimatedComputeSecondsAvoided: sumField(perPrediction, (p) => p.estimatedComputeSecondsAvoided),
    totalEstimatedCostAvoidedUsd: sumField(perPrediction, (p) => p.estimatedCostAvoidedUsd),
  };
}

const CONFIDENCE_RANK: Record<SavingsConfidence, number> = { measured: 3, historical_estimate: 2, count_based_estimate: 1, unavailable: 0 };

function sumField(perPrediction: PredictionSavings[], pick: (p: PredictionSavings) => ValueWithConfidence<number>): ValueWithConfidence<number> {
  const fields = perPrediction.map(pick);
  const numeric = fields.filter((f): f is { value: number; confidence: SavingsConfidence } => typeof f.value === "number");
  if (numeric.length === 0) return { value: "unknown", confidence: "unavailable" };
  const total = numeric.reduce((sum, f) => sum + f.value, 0);
  const weakestConfidence = numeric.reduce((weakest, f) => (CONFIDENCE_RANK[f.confidence] < CONFIDENCE_RANK[weakest] ? f.confidence : weakest), numeric[0]!.confidence);
  return { value: total, confidence: weakestConfidence };
}
