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
import { toEvidenceTier, type EvidenceTier } from "./economics-classification.js";
import { estimateStageEconomics, ESTIMATOR_VERSION } from "./economics-estimator.js";
import type { SavingsConfidence } from "./savings.js";

export const SHADOW_ECONOMICS_SCHEMA_VERSION = 1;

export interface ShadowEconomicsCandidate {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  /** DiffCI's own real selected-test count and the real total for this commit's prediction - only used
   * for the 'test' stage's selected-workload estimate. */
  testsSelectedDiffci: number;
  testsTotalFull: number;
  /** Raw input to the estimate and stored as such - a FULL plan must never report avoidable work. */
  planMode: "FULL" | "SELECTIVE" | undefined;
  /** YC readiness Week 2, incremental-economics comparator: the path-rule baseline's own selected-test
   * count for this same commit (src/planner/path-baseline.ts, computed by the poll container alongside
   * DiffCI's own selection - never derived here). Lets a report compare DiffCI against "what a path rule
   * would have run" instead of merely against FULL. */
  testsSelectedPath: number;
  /** DiffCI's own real, measured analysis wall-time for this prediction - the cost side of the
   * comparator, so a comparison cannot credit DiffCI's selection without also charging what producing it
   * cost. */
  diffciAnalysisOverheadMs: number;
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
  /** Raw inputs, persisted so a recompute is self-contained and auditable. Never rewritten. */
  testsSelectedDiffci: number | undefined;
  planMode: "FULL" | "SELECTIVE" | undefined;
  /** YC readiness Week 2 comparator inputs - same test-stage-only scoping as testsSelectedDiffci/
   * testsTotalFull above, for the same reason (no build/lint/typecheck/e2e selection concept exists for
   * either DiffCI or the path-rule baseline). */
  testsSelectedPath: number | undefined;
  diffciAnalysisOverheadMs: number | undefined;
  /** Which estimator produced the derived fields, and when - drives the recompute/backfill sweep. */
  estimatorVersion: number | undefined;
  estimatedAt: string | undefined;
  schemaVersion: number;
  observedAt: string;
}

/**
 * Derives one observation PER STAGE present in the real job list. Takes no history parameter: estimator v2
 * anchors the counterfactual to THIS commit's own measured workload, so a capture no longer depends on
 * (or can be contaminated by) another commit's timings. See economics-estimator.ts for why v1's
 * cross-commit average was withdrawn.
 */
export function deriveShadowEconomicsObservations(
  candidate: ShadowEconomicsCandidate,
  runs: readonly BaselineRunInfo[],
  jobs: readonly BaselineJobInfo[],
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
      // Every stage goes through the SAME estimator, which refuses (UNKNOWN) for non-test stages and for
      // absent/zero/inconsistent counts - so there is exactly one place where a counterfactual can be
      // produced, and exactly one place to audit.
      const estimate = estimateStageEconomics({
        stage: bucket.stage,
        fullWorkloadMs: bucket.totalDurationMs,
        testsSelectedDiffci: candidate.testsSelectedDiffci,
        testsTotalFull: candidate.testsTotalFull,
        planMode: candidate.planMode,
      });

      return {
        logicalDeltaKey: candidate.logicalDeltaKey,
        stage: bucket.stage,
        repository: candidate.repository,
        headSha: candidate.headSha,
        workflowRunIds,
        jobIds,
        fullWorkloadMs: bucket.totalDurationMs,
        // Only meaningful where the estimator could actually use them; kept NULL elsewhere so a
        // non-test row never implies DiffCI reasoned about its test counts.
        testsTotalFull: bucket.stage === "test" ? candidate.testsTotalFull : undefined,
        testsSelectedDiffci: bucket.stage === "test" ? candidate.testsSelectedDiffci : undefined,
        testsSelectedPath: bucket.stage === "test" ? candidate.testsSelectedPath : undefined,
        // A per-commit, not per-stage, cost - attached only to the 'test' row (where the rest of the
        // comparator's data already lives) so summing across a commit's stage rows never double-counts it.
        diffciAnalysisOverheadMs: bucket.stage === "test" ? candidate.diffciAnalysisOverheadMs : undefined,
        planMode: candidate.planMode,
        selectedWorkloadMs: estimate.selectedWorkloadMs,
        selectedWorkloadConfidence: estimate.selectedWorkloadConfidence,
        avoidableMs: estimate.avoidableMs,
        avoidableTier: estimate.avoidableTier,
        estimationMethod: estimate.estimationMethod,
        estimatorVersion: ESTIMATOR_VERSION,
        estimatedAt: observedAt,
        schemaVersion: SHADOW_ECONOMICS_SCHEMA_VERSION,
        observedAt,
      };
    });
}

export { toEvidenceTier };
