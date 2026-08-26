/**
 * Rolls captured shadow_economics_observations rows up into the seven-day, repository-level report model
 * (External Shadow Pilot M3, 2026-08-26). Pure - no I/O, no clock, no formatting. The renderer is a
 * separate module so the numbers can be tested without asserting on prose.
 *
 * The report is a ROLLUP, never a second source of truth: every field below is a sum, count or ratio of
 * rows the capture sweep already wrote, so any number in the rendered page can be traced back to specific
 * (logical_delta_key, stage) rows.
 *
 * Three rules govern what this may claim, in order of importance:
 *
 *  1. This report describes POTENTIAL only - static selection against measured full workload. It is not
 *     validated savings (which requires the selected subset to have actually executed and been measured)
 *     and it is certainly not billable. Nothing here may be invoiced from. See the evidence-level model:
 *     Potential -> Validated -> Billable, and the rule that only validated NET savings are billable.
 *  2. Measured avoidable opportunity is STRUCTURALLY zero in shadow mode, not incidentally zero. Shadow
 *     mode never executes the counterfactual, so there is nothing to measure. The report states that zero
 *     explicitly rather than hiding the line, because its absence would imply the number was simply
 *     missing rather than impossible.
 *  3. A weak tier anywhere in a stage degrades that stage's total. Summing an ESTIMATED row with an
 *     UNKNOWN one cannot produce an ESTIMATED total covering both - the total is reported over the rows
 *     that could be estimated, with the unestimated ones counted separately and visibly.
 */
import type { CiStage } from "../shadow/stage-classification.js";
import type { EvidenceTier } from "./economics-classification.js";
import type { ShadowEconomicsObservation } from "./shadow-economics.js";
import { assessEvidence, type EvidenceAssessment, type EvidenceThresholds } from "./shadow-evidence-readiness.js";

/** Stage display order - deliberately fixed rather than derived from the data, so a repository with no
 * lint stage still shows lint as absent rather than silently omitting the category. */
export const STAGE_ORDER: readonly CiStage[] = ["test", "build", "lint", "typecheck", "e2e", "other"];

export interface CommitDetail {
  headSha: string;
  testsSelectedDiffci: number | undefined;
  testsTotalFull: number | undefined;
  planMode: "FULL" | "SELECTIVE" | undefined;
  fullWorkloadMs: number;
  estimatedAvoidableMs: number | undefined;
  avoidableTier: EvidenceTier;
}

export interface StageRollup {
  stage: CiStage;
  /** Real, measured consumption for this stage across the window. Always a genuine sum of real job times. */
  observedMs: number;
  observationCount: number;
  /** Sum of avoidable_ms across rows this estimator could actually evaluate. Undefined when none could be. */
  estimatedAvoidableMs: number | undefined;
  /** How many rows in this stage carry each tier - makes partial coverage visible instead of averaged away. */
  estimatedRows: number;
  unknownRows: number;
  /** Per-commit evidence for the test stage, so the report can show selection ratios rather than a bare
   * percentage. This is what makes a large avoidable figure inspectable instead of merely assertable. */
  commits: CommitDetail[];
}

export interface ShadowRepositoryReport {
  repository: string;
  windowStartIso: string;
  windowEndIso: string;
  /** False when there is nothing honest to report. The renderer must say so plainly rather than emit a
   * page of zeros, which would read as "your CI did nothing" instead of "DiffCI observed nothing". */
  hasSufficientData: boolean;
  insufficientReason: string | undefined;
  commitsObserved: number;
  workflowRunsObserved: number;
  totalObservedMs: number;
  stages: StageRollup[];
  /** Tests-only in v1. The engine models no selection concept for other stages. */
  totalEstimatedAvoidableMs: number | undefined;
  /** ALWAYS 0. Kept as an explicit field, not omitted: shadow mode cannot measure a counterfactual, and
   * the report is more credible for saying so than for leaving the reader to wonder. */
  totalMeasuredAvoidableMs: 0;
  /** Observation coverage and readiness state. Answers "what did DiffCI actually observe?" BEFORE the
   * report asks anyone to believe anything about opportunity. */
  evidence: EvidenceAssessment;
  /** Share of observed CI time DiffCI can currently classify at all (test stage). The load-bearing
   * falsifiable metric: a low value is useful information about DiffCI's coverage, not a failure to hide
   * by narrowing the denominator to just the tests. */
  classifiedFraction: number;
  safety: { evaluableFailures: number; failuresPreserved: number; falseNegatives: number };
}

export interface RollupInput {
  repository: string;
  windowStartIso: string;
  windowEndIso: string;
  observations: readonly ShadowEconomicsObservation[];
  safety: { evaluableFailures: number; failuresPreserved: number; falseNegatives: number };
  /** How many predictions DiffCI generated for this repository in the window - the coverage denominator.
   * Without it the report can only say "3 commits observed", which is meaningless until you know whether
   * the total was 4 or 47. */
  eligiblePredictions: number;
  thresholds?: EvidenceThresholds;
}

export function rollUpShadowReport(input: RollupInput): ShadowRepositoryReport {
  const rows = input.observations;

  const distinctCommits = new Set(rows.map((r) => r.headSha));
  const distinctRuns = new Set(rows.flatMap((r) => r.workflowRunIds));
  const totalObservedMs = rows.reduce((sum, r) => sum + r.fullWorkloadMs, 0);

  const stages: StageRollup[] = [];
  for (const stage of STAGE_ORDER) {
    const stageRows = rows.filter((r) => r.stage === stage);
    if (stageRows.length === 0) continue;

    const estimable = stageRows.filter((r) => r.avoidableTier === "ESTIMATED" && typeof r.avoidableMs === "number");
    stages.push({
      stage,
      observedMs: stageRows.reduce((sum, r) => sum + r.fullWorkloadMs, 0),
      observationCount: stageRows.length,
      // Summed ONLY over rows that could actually be estimated. Rows that could not are counted in
      // unknownRows rather than being treated as zero-opportunity, which would understate silently.
      estimatedAvoidableMs: estimable.length > 0 ? estimable.reduce((sum, r) => sum + (r.avoidableMs ?? 0), 0) : undefined,
      estimatedRows: estimable.length,
      unknownRows: stageRows.length - estimable.length,
      commits: stageRows.map((r) => ({
        headSha: r.headSha,
        testsSelectedDiffci: r.testsSelectedDiffci,
        testsTotalFull: r.testsTotalFull,
        planMode: r.planMode,
        fullWorkloadMs: r.fullWorkloadMs,
        estimatedAvoidableMs: r.avoidableMs,
        avoidableTier: r.avoidableTier,
      })),
    });
  }

  const testStage = stages.find((s) => s.stage === "test");
  const classifiedMs = testStage?.observedMs ?? 0;

  // Plan mix is counted over DISTINCT predictions, not rows - one commit emitting test+build+other rows
  // is one observation, not three, and counting rows would inflate the evidence count severalfold.
  const planByDelta = new Map<string, "FULL" | "SELECTIVE" | undefined>();
  for (const r of rows) if (!planByDelta.has(r.logicalDeltaKey)) planByDelta.set(r.logicalDeltaKey, r.planMode);
  const plans = [...planByDelta.values()];

  const evidence = assessEvidence(
    {
      eligiblePredictions: input.eligiblePredictions,
      capturedPredictions: planByDelta.size,
      selectiveObservations: plans.filter((p) => p === "SELECTIVE").length,
      fullObservations: plans.filter((p) => p === "FULL").length,
      evaluableFailures: input.safety.evaluableFailures,
    },
    input.thresholds,
  );

  return {
    repository: input.repository,
    windowStartIso: input.windowStartIso,
    windowEndIso: input.windowEndIso,
    hasSufficientData: rows.length > 0,
    insufficientReason: rows.length === 0 ? "No completed CI workload was observed for this repository in this window." : undefined,
    commitsObserved: distinctCommits.size,
    workflowRunsObserved: distinctRuns.size,
    totalObservedMs,
    stages,
    totalEstimatedAvoidableMs: testStage?.estimatedAvoidableMs,
    totalMeasuredAvoidableMs: 0,
    evidence,
    classifiedFraction: totalObservedMs > 0 ? classifiedMs / totalObservedMs : 0,
    safety: input.safety,
  };
}
