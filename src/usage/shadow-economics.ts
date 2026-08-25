/**
 * Pure logic for turning real GitHub Actions job evidence into per-stage shadow-economics observations
 * (2026-08-25, External Shadow Pilot M1). Sibling to duration-capture.ts, same discipline, different
 * question: duration-capture.ts sums ALL jobs into one undifferentiated per-commit figure (correct for
 * its own purpose - a coarse historical average); this module keeps the CI/CD-optimization thesis honest
 * by never letting that lump sum stand in for "test workload" - see stage-classification.ts.
 *
 * v1 can only produce a selected-workload figure (and therefore an avoidable-opportunity figure) for the
 * 'test' stage - the engine has no build/lint/typecheck/e2e selection concept yet. Every other real stage
 * still gets a row (full_workload_ms is real regardless of stage), with selected/avoidable left unknown -
 * never silently dropped, never guessed.
 */
import type { BaselineJobInfo, BaselineRunInfo } from "../shadow/types.js";
import { bucketJobsByStage, type CiStage } from "../shadow/stage-classification.js";
import { toEvidenceTier, combineForAvoidable, type EvidenceTier } from "./economics-classification.js";
import type { SavingsConfidence, ValueWithConfidence } from "./savings.js";

export const SHADOW_ECONOMICS_SCHEMA_VERSION = 1;

export interface ShadowEconomicsCandidate {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  /** DiffCI's own real selected-test count and the real total for this commit's prediction - only used
   * for the 'test' stage's selected-workload estimate. */
  testsSelectedDiffci: number;
  testsTotalFull: number;
}

export interface ShadowEconomicsObservation {
  logicalDeltaKey: string;
  stage: CiStage;
  repository: string;
  headSha: string;
  workflowRunIds: number[];
  jobIds: number[];
  fullWorkloadMs: number;
  testsTotalFull: number | undefined;
  selectedWorkloadMs: number | undefined;
  selectedWorkloadConfidence: SavingsConfidence | undefined;
  avoidableMs: number | undefined;
  avoidableTier: EvidenceTier;
  estimationMethod: string | undefined;
  schemaVersion: number;
  observedAt: string;
}

/**
 * Derives one observation PER STAGE present in the real job list. `historicalSecondsPerTest` is this
 * repository's own historical average (see computeHistoricalTestSecondsPerTest below) - the ONLY source
 * for a 'test' stage selected-workload estimate; when it's `unavailable` (no history yet, or too little),
 * the test stage's own avoidable figure is honestly UNKNOWN, exactly like every non-test stage.
 */
export function deriveShadowEconomicsObservations(
  candidate: ShadowEconomicsCandidate,
  runs: readonly BaselineRunInfo[],
  jobs: readonly BaselineJobInfo[],
  historicalSecondsPerTest: ValueWithConfidence<number>,
  observedAt: string,
): ShadowEconomicsObservation[] {
  const buckets = bucketJobsByStage(jobs);
  const workflowRunIds = runs.map((r) => r.workflowRunId);

  return buckets
    // A stage whose every job lacked usable start/end timestamps (rare - only possible on a malformed
    // COMPLETE run) is skipped entirely rather than persisted with a fabricated fullWorkloadMs of 0 - a
    // real 0ms row would misreport "measured, took no time" when the truth is "present, unmeasurable".
    // This is a full-workload-side simplification only; it never applies to the selected/avoidable side,
    // which is always given an explicit UNKNOWN row rather than omitted (see the schema's own comment).
    .filter((b) => b.totalDurationMs > 0)
    .map((bucket) => {
      const jobIds = jobs.filter((j) => bucket.jobNames.includes(j.jobName)).map((j) => j.jobId);

      if (bucket.stage !== "test" || candidate.testsTotalFull <= 0) {
        return {
          logicalDeltaKey: candidate.logicalDeltaKey,
          stage: bucket.stage,
          repository: candidate.repository,
          headSha: candidate.headSha,
          workflowRunIds,
          jobIds,
          fullWorkloadMs: bucket.totalDurationMs,
          testsTotalFull: undefined,
          selectedWorkloadMs: undefined,
          selectedWorkloadConfidence: undefined,
          avoidableMs: undefined,
          avoidableTier: "UNKNOWN" as const,
          estimationMethod: undefined,
          schemaVersion: SHADOW_ECONOMICS_SCHEMA_VERSION,
          observedAt,
        };
      }

      // Test stage, real total tests known - the one case v1 can attempt a selected-workload estimate.
      const full: ValueWithConfidence<number> = { value: bucket.totalDurationMs, confidence: "measured" };
      let selected: ValueWithConfidence<number> = { value: "unknown", confidence: "unavailable" };
      let estimationMethod: string | undefined;
      if (typeof historicalSecondsPerTest.value === "number") {
        const selectedMs = candidate.testsSelectedDiffci * historicalSecondsPerTest.value * 1000;
        selected = { value: selectedMs, confidence: historicalSecondsPerTest.confidence };
        estimationMethod = `historical_avg_seconds_per_test_x${candidate.testsSelectedDiffci}`;
      }
      const avoidable = combineForAvoidable(full, selected);

      return {
        logicalDeltaKey: candidate.logicalDeltaKey,
        stage: "test" as const,
        repository: candidate.repository,
        headSha: candidate.headSha,
        workflowRunIds,
        jobIds,
        fullWorkloadMs: bucket.totalDurationMs,
        testsTotalFull: candidate.testsTotalFull,
        selectedWorkloadMs: typeof selected.value === "number" ? selected.value : undefined,
        selectedWorkloadConfidence: typeof selected.value === "number" ? selected.confidence : undefined,
        avoidableMs: avoidable.value,
        avoidableTier: avoidable.tier,
        estimationMethod,
        schemaVersion: SHADOW_ECONOMICS_SCHEMA_VERSION,
        observedAt,
      };
    });
}

/** This repository's own historical real-test-time-per-test average, computed ONLY from this repository's
 * own 'test'-stage shadow-economics observations - deliberately narrower than duration-capture.ts's
 * cross-repository computeHistoricalAverageSecondsPerTest, since a build/lint-contaminated lump sum from
 * the OLD (pre-stage-aware) pipeline must never leak into this repository's test-only estimate. */
export function computeHistoricalTestSecondsPerTest(testStageObservations: readonly { fullWorkloadMs: number; testsTotalFull: number | undefined }[]): ValueWithConfidence<number> {
  const usable = testStageObservations.filter((o): o is { fullWorkloadMs: number; testsTotalFull: number } => typeof o.testsTotalFull === "number" && o.testsTotalFull > 0);
  if (usable.length === 0) return { value: "unknown", confidence: "unavailable" };
  const total = usable.reduce((sum, o) => sum + o.fullWorkloadMs / 1000 / o.testsTotalFull, 0);
  return { value: total / usable.length, confidence: "historical_estimate" };
}

export { toEvidenceTier };
