/**
 * Economic activation gate (2026-08-24, execution-observability mission).
 *
 * A selection being CORRECTNESS-SAFE (the frozen engine's own SAFE_TO_PROPOSE verdict) does not imply it
 * is ECONOMICALLY worth activating - the cal.com PR #29940 run is the concrete case that motivated this:
 * a logically-safe 2/424 selection produced measured savings of roughly zero once analysis overhead was
 * netted out. This module is the decision layer that sits between "is this selection correct" and "should
 * DiffCI actually run fewer tests for this merge" - it must never let a safe-but-uneconomical selection
 * activate automatically.
 *
 * Deliberately pure and repository-independent: no network, no sandbox, no target-repo knowledge. Takes
 * whatever timing evidence is available (as few as one sample) and is honest about low confidence rather
 * than pretending a single data point is a reliable estimate.
 */

export type ActivationDecision = "SAFE_TO_PROPOSE" | "ECONOMICALLY_BENEFICIAL" | "EXECUTE_SELECTIVELY" | "RUN_FULL_SUITE";

export interface TimingSample {
  fullMs: number;
  selectedMs: number;
}

export interface ActivationInput {
  /** Whether the frozen engine's own correctness policy authorizes a selective run at all (its
   * analysisStatus === "SAFE_TO_PROPOSE" and the runtime-selection invariant was HONORED_*, not
   * IGNORED_OR_BROADENED/UNMEASURABLE - see classifyRuntimeSelection in execution-shard-do.ts). */
  correctnessSafe: boolean;
  /** One or more real timing samples (full-suite ms, selected-suite ms) for THIS repository/command
   * shape. A single sample is accepted but flagged low-confidence, never silently treated as reliable. */
  samples: TimingSample[];
  /** DiffCI's own measured/predicted analysis wall time (ms) to PRODUCE the selection. */
  analysisOverheadMs: number;
  /** Fixed cost of planning/dispatching a selective run instead of just invoking the normal full-suite
   * CI job as-is (e.g. constructing the filtered command, any extra CI orchestration). Repository- and
   * harness-specific; pass 0 when there genuinely is none to model yet - never guessed upward. */
  executionPlanningOverheadMs: number;
  /** Extra safety margin demanded ON TOP OF overhead before activating, as a fraction of the median full
   * suite duration (e.g. 0.05 = 5%). Exists because a single or small sample count under-states real
   * variance; the caller should widen this for low-sample-count runs. Required, not defaulted, so a
   * caller can never silently activate with zero margin by omission. */
  uncertaintyMarginFraction: number;
}

export interface ActivationResult {
  decision: ActivationDecision;
  correctnessSafe: boolean;
  economicallyBeneficial: boolean;
  sampleCount: number;
  lowConfidence: boolean;
  predictedFullDurationMs: number;
  predictedSelectiveDurationMs: number;
  predictedGrossSavingsMs: number;
  analysisOverheadMs: number;
  executionPlanningOverheadMs: number;
  uncertaintyMarginMs: number;
  /** The exact break-even point: gross savings must exceed this to activate. */
  requiredSavingsMs: number;
  netSavingsMs: number;
  explanation: string;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Decide whether DiffCI should activate selective execution for a given repository/command shape.
 * Policy (documented, not tunable per-call beyond the explicit inputs above):
 *
 *   predicted gross savings > analysis overhead + execution-planning overhead + uncertainty margin
 *
 * where predicted gross savings = median(full) - median(selected) across the supplied samples. A
 * correctness-unsafe or empty-sample input never reaches ECONOMICALLY_BENEFICIAL regardless of numbers.
 */
export function decideActivation(input: ActivationInput): ActivationResult {
  const { correctnessSafe, samples, analysisOverheadMs, executionPlanningOverheadMs, uncertaintyMarginFraction } = input;

  if (samples.length === 0) {
    return {
      decision: correctnessSafe ? "SAFE_TO_PROPOSE" : "RUN_FULL_SUITE",
      correctnessSafe,
      economicallyBeneficial: false,
      sampleCount: 0,
      lowConfidence: true,
      predictedFullDurationMs: 0,
      predictedSelectiveDurationMs: 0,
      predictedGrossSavingsMs: 0,
      analysisOverheadMs,
      executionPlanningOverheadMs,
      uncertaintyMarginMs: 0,
      requiredSavingsMs: 0,
      netSavingsMs: 0,
      explanation: "no timing samples available - economic benefit cannot be assessed, never assumed",
    };
  }

  const predictedFullDurationMs = median(samples.map((s) => s.fullMs));
  const predictedSelectiveDurationMs = median(samples.map((s) => s.selectedMs));
  const predictedGrossSavingsMs = predictedFullDurationMs - predictedSelectiveDurationMs;
  const uncertaintyMarginMs = predictedFullDurationMs * uncertaintyMarginFraction;
  const requiredSavingsMs = analysisOverheadMs + executionPlanningOverheadMs + uncertaintyMarginMs;
  const netSavingsMs = predictedGrossSavingsMs - requiredSavingsMs;
  const economicallyBeneficial = netSavingsMs > 0;
  // A single sample is real evidence, never discarded - but it is not a reliable ESTIMATE of variance,
  // so it is labeled, not silently trusted the same as a multi-sample median would be.
  const lowConfidence = samples.length < 3;

  let decision: ActivationDecision;
  let explanation: string;
  if (!correctnessSafe) {
    decision = "RUN_FULL_SUITE";
    explanation = "correctness policy does not authorize a selective run for this merge - economics is moot";
  } else if (!economicallyBeneficial) {
    decision = "SAFE_TO_PROPOSE";
    explanation = `safe but not activated: predicted gross savings ${predictedGrossSavingsMs.toFixed(0)}ms does not exceed required ${requiredSavingsMs.toFixed(0)}ms (overhead ${analysisOverheadMs.toFixed(0)}ms + planning ${executionPlanningOverheadMs.toFixed(0)}ms + margin ${uncertaintyMarginMs.toFixed(0)}ms)${lowConfidence ? " - based on a single sample, treat as preliminary" : ""}`;
  } else {
    decision = "EXECUTE_SELECTIVELY";
    explanation = `safe and economically beneficial: predicted net savings ${netSavingsMs.toFixed(0)}ms after overhead and margin${lowConfidence ? " - based on a single sample, treat as preliminary" : ""}`;
  }

  return {
    decision,
    correctnessSafe,
    economicallyBeneficial,
    sampleCount: samples.length,
    lowConfidence,
    predictedFullDurationMs,
    predictedSelectiveDurationMs,
    predictedGrossSavingsMs,
    analysisOverheadMs,
    executionPlanningOverheadMs,
    uncertaintyMarginMs,
    requiredSavingsMs,
    netSavingsMs,
    explanation,
  };
}
