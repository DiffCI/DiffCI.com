/**
 * Observation-coverage and evidence-readiness assessment (External Shadow Pilot M3.1, 2026-08-26).
 *
 * M3 proved DiffCI can produce an honest report. It did not prove the sample behind that report is
 * representative enough to ask a maintainer to act on it. Those are different claims, and conflating them
 * is how a shadow product ends up showing an impressive percentage after a single lucky commit.
 *
 * So readiness is a real state, decided here, not a judgement made in prose at render time:
 *
 *     SHADOW - COLLECTING        -> DiffCI is observing, and says so plainly. No recommendation.
 *     SHADOW - EVIDENCE READY    -> enough observations exist to put the report in front of a human.
 *
 * TIME IS NOT THE EVIDENCE UNIT - observations are. Seven days with 60 captured executions is stronger
 * evidence than thirty days with 7, so every threshold below counts observations, never elapsed days.
 *
 * Two distinct coverage questions, deliberately kept apart because a good number on one can hide a bad
 * number on the other:
 *   - PREDICTION capture coverage: of the eligible predictions DiffCI generated for this repository in
 *     the window, what fraction actually acquired workload telemetry? 3 of 4 and 3 of 47 tell completely
 *     different stories about whether the sample means anything.
 *   - CI-STAGE coverage: of the CI compute actually observed, what fraction can DiffCI classify at all?
 *     A perfectly captured prediction set can still describe only the test slice of a much larger pipeline.
 *
 * These thresholds are not statistical guarantees. They are a reasonable "enough evidence to show a human"
 * gate, chosen to be adjusted once the real distributions are visible.
 */

export interface EvidenceThresholds {
  /** Captured eligible predictions - the raw quantity of real observations behind the report. */
  minCapturedPredictions: number;
  /** SELECTIVE observations specifically. A report built entirely from FULL plans demonstrates nothing
   * about opportunity, however many observations it contains, because a FULL plan avoids nothing. */
  minSelectiveObservations: number;
}

export const DEFAULT_EVIDENCE_THRESHOLDS: EvidenceThresholds = {
  minCapturedPredictions: 20,
  minSelectiveObservations: 5,
};

export type EvidenceState = "COLLECTING" | "EVIDENCE_READY";

export interface EvidenceInput {
  /** Predictions DiffCI generated for this repository in the window - the denominator. */
  eligiblePredictions: number;
  /** Distinct predictions that actually acquired workload telemetry - the numerator. */
  capturedPredictions: number;
  selectiveObservations: number;
  fullObservations: number;
  /** Real failures that could be evaluated against DiffCI's hypothetical selection. Zero means safety is
   * UNTESTED, which is emphatically not the same as safe. */
  evaluableFailures: number;
}

export interface EvidenceAssessment extends EvidenceInput {
  state: EvidenceState;
  /** captured / eligible. Undefined when nothing was eligible - a ratio with a zero denominator is not
   * 100% coverage, it is no information, and rendering it as 1.0 would be actively misleading. */
  captureCoverage: number | undefined;
  /**
   * Whether the report may make ANY positive statement about selection safety. Requires at least one
   * real failing execution to have been evaluable: with zero failures observed, "0 missed failures" is
   * absence of evidence, and presenting it as a safety result is the most misleading thing this report
   * could do.
   */
  canMakePositiveSafetyStatement: boolean;
  /** Human-readable, specific, and ordered - what is still missing before a maintainer should be asked
   * to act. Empty when the state is EVIDENCE_READY. */
  unmetCriteria: string[];
}

export function assessEvidence(input: EvidenceInput, thresholds: EvidenceThresholds = DEFAULT_EVIDENCE_THRESHOLDS): EvidenceAssessment {
  const unmetCriteria: string[] = [];

  if (input.capturedPredictions < thresholds.minCapturedPredictions) {
    unmetCriteria.push(`${input.capturedPredictions} of ${thresholds.minCapturedPredictions} captured observations required`);
  }
  if (input.selectiveObservations < thresholds.minSelectiveObservations) {
    unmetCriteria.push(`${input.selectiveObservations} of ${thresholds.minSelectiveObservations} selective observations required (a FULL plan avoids nothing, so only selective plans evidence opportunity)`);
  }

  return {
    ...input,
    state: unmetCriteria.length === 0 ? "EVIDENCE_READY" : "COLLECTING",
    captureCoverage: input.eligiblePredictions > 0 ? input.capturedPredictions / input.eligiblePredictions : undefined,
    // Deliberately NOT part of the state gate: a repository with no failing CI can still have a complete,
    // useful opportunity report. It simply may not claim anything about safety while doing so.
    canMakePositiveSafetyStatement: input.evaluableFailures > 0,
    unmetCriteria,
  };
}
