/**
 * Pure logic for turning real GitHub Actions job-duration evidence into a DurationObservation, and for
 * aggregating stored observations into a real, historically-derived average-seconds-per-test figure -
 * the piece savings.ts was missing (its own comment: "This module does NOT currently have access to
 * real per-test historical timing data... a future 'historical_estimate'... is future work"). This is
 * that future work, kept deliberately separate from savings.ts itself (single responsibility, and this
 * module has no dependency on ShadowPredictionSummary or any Stage 2F type).
 *
 * IMPORTANT - what this figure actually is, and is NOT (R2.1 Part A.3): `secondsPerTest` is
 * `real total job duration / testsTotalFull`, a coarse per-commit AVERAGE, never a measurement of any
 * individual test's real runtime. It is honestly tagged "historical_estimate", never "measured per-test
 * duration". Known, disclosed distortions this average does NOT correct for:
 *   - setup time is included: checkout, dependency install, and any other pre-test job steps are folded
 *     into the same duration as the tests themselves.
 *   - non-uniform test costs: a job with one 60s integration test and 45 sub-second unit tests produces
 *     the exact same average as 46 uniformly-2s tests - this cannot distinguish the two.
 *   - parallelism: if the real CI job runs tests across multiple parallel shards/workers, wall-clock job
 *     duration understates real aggregate CPU-time, which would understate compute/cost/carbon avoided.
 *   - non-test work: teardown, artifact upload, or any other non-test step inside the same job also gets
 *     folded in.
 * These are real, structural limitations of the (jobDuration / testCount) approximation, not
 * implementation bugs - a caller must never present this as "measured" or as precise per-test timing.
 */
import type { DurationObservation } from "./duration-observation-store.js";
import type { SavingsConfidence, ValueWithConfidence } from "./savings.js";

export interface DurationCaptureCandidate {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  testsTotalFull: number;
}

/**
 * Derives one observation from a real, COMPLETE baseline duration (see
 * src/shadow/github-baseline.ts's fetchBaselineEvidence -> BaselineEvidence.baselineDurationMs).
 * `workflowRunIds`/`jobIds` are the real GitHub Actions identities the duration was summed across -
 * audit provenance (Part A.4), never raw log content. Returns null when the inputs can't honestly
 * produce a seconds-per-test figure (zero/negative test count or duration) - never divides by zero,
 * never records a fabricated 0.
 */
export function deriveDurationObservation(candidate: DurationCaptureCandidate, realJobDurationMs: number, workflowRunIds: number[], jobIds: number[], observedAt: string): DurationObservation | null {
  if (candidate.testsTotalFull <= 0 || realJobDurationMs <= 0) return null;
  return {
    logicalDeltaKey: candidate.logicalDeltaKey,
    repository: candidate.repository,
    headSha: candidate.headSha,
    workflowRunIds,
    jobIds,
    testsTotalFull: candidate.testsTotalFull,
    realJobDurationMs,
    secondsPerTest: realJobDurationMs / 1000 / candidate.testsTotalFull,
    observedAt,
  };
}

/**
 * A real average across stored observations - honestly tagged "historical_estimate" (real per-commit CI
 * job timing, not a uniform guess) whenever at least one observation exists, "unavailable" otherwise.
 * Never "measured": this is still an average across commits with different test suites/CI shapes, not a
 * per-avoided-test measurement of the SPECIFIC tests a given prediction skipped.
 */
export function computeHistoricalAverageSecondsPerTest(observations: DurationObservation[]): ValueWithConfidence<number> {
  if (observations.length === 0) return { value: "unknown", confidence: "unavailable" };
  const total = observations.reduce((sum, o) => sum + o.secondsPerTest, 0);
  return { value: total / observations.length, confidence: "historical_estimate" satisfies SavingsConfidence };
}
