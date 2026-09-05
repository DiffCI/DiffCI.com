/**
 * Stage economics on ADMITTED evidence only (2026-09-05, measurement-integrity repair step 3).
 *
 * Replaces shadow-economics.ts's deriveShadowEconomicsObservations for everything written from now on.
 * Differences, each one a fault in the legacy path the research note names:
 *   - admission: the caller passes the VERIFIED ground-truth row's evidence run and that run's jobs,
 *     nothing else - contaminated or unverified evidence never reaches this function;
 *   - classification: the repository's explicit stage_classification config (job + step rules) with
 *     conservative inference only when no config exists (stage-classification-config.ts);
 *   - provenance: every row records the evidence run, the workflow path, the classification basis and
 *     the classifier version, so a number in a report can be traced to the exact GitHub job or step;
 *   - honesty: an *_inseparable basis keeps its real measurement but derives NO avoidable-work estimate.
 *
 * Pure. One row per (stage, basis) bucket with a positive measured duration.
 */
import type { BaselineJobInfo, BaselineRunInfo } from "../shadow/types.js";
import type { CiStage } from "../shadow/stage-classification.js";
import { classifyRunJobs, isInseparable, STAGE_CLASSIFIER_VERSION, type ClassificationBasis, type StageClassificationConfig } from "../shadow/stage-classification-config.js";
import type { EvidenceTier } from "./economics-classification.js";
import { estimateStageEconomics, ESTIMATOR_VERSION } from "./economics-estimator.js";
import type { SavingsConfidence } from "./savings.js";

export interface StageEconomicsCandidate {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  testsSelectedDiffci: number;
  testsTotalFull: number;
  testsSelectedPath: number;
  planMode: "FULL" | "SELECTIVE" | undefined;
  diffciAnalysisOverheadMs: number;
}

export interface StageEconomicsObservation {
  logicalDeltaKey: string;
  stage: CiStage;
  classificationBasis: ClassificationBasis;
  classifierVersion: number;
  repository: string;
  headSha: string;
  evidenceRunId: string;
  evidenceWorkflowPath: string;
  evidenceValidity: "VERIFIED";
  jobIds: number[];
  stepRefs: string[];
  fullWorkloadMs: number;
  testsTotalFull: number | undefined;
  testsSelectedDiffci: number | undefined;
  testsSelectedPath: number | undefined;
  planMode: "FULL" | "SELECTIVE" | undefined;
  diffciAnalysisOverheadMs: number | undefined;
  selectedWorkloadMs: number | undefined;
  selectedWorkloadConfidence: SavingsConfidence | undefined;
  avoidableMs: number | undefined;
  avoidableTier: EvidenceTier;
  estimationMethod: string | undefined;
  estimatorVersion: number;
  observedAt: string;
}

/**
 * The primary key is (logical_delta_key, stage). When a stage has BOTH a separable and an inseparable
 * bucket (a repository half-way through splitting a mixed step), the separable one is the row and the
 * inseparable remainder is folded into 'other'/'unclassified' rather than double-counting the stage -
 * conservative in the direction of under-attributing test work, never over-attributing it.
 */
export function deriveStageEconomics(
  candidate: StageEconomicsCandidate,
  evidenceRun: Pick<BaselineRunInfo, "workflowRunId" | "workflowPath">,
  jobs: readonly BaselineJobInfo[],
  config: StageClassificationConfig | undefined,
  observedAt: string,
): StageEconomicsObservation[] {
  const buckets = classifyRunJobs(jobs, config);
  const byStage = new Map<CiStage, ReturnType<typeof classifyRunJobs>[number]>();
  const overflow: ReturnType<typeof classifyRunJobs> = [];
  for (const b of buckets) {
    const existing = byStage.get(b.stage);
    if (!existing) {
      byStage.set(b.stage, b);
      continue;
    }
    // Prefer the separable bucket as the stage's row; demote the other to overflow.
    if (isInseparable(existing.basis) && !isInseparable(b.basis)) {
      byStage.set(b.stage, b);
      overflow.push(existing);
    } else overflow.push(b);
  }
  if (overflow.length > 0) {
    const other = byStage.get("other") ?? { stage: "other" as CiStage, basis: "unclassified" as ClassificationBasis, durationMs: 0, jobIds: [], stepRefs: [], jobNames: [] };
    for (const o of overflow) {
      other.durationMs += o.durationMs;
      for (const id of o.jobIds) if (!other.jobIds.includes(id)) other.jobIds.push(id);
      other.stepRefs.push(...o.stepRefs);
    }
    other.basis = "unclassified";
    byStage.set("other", other);
  }

  return [...byStage.values()]
    .filter((b) => b.durationMs > 0)
    .map((bucket) => {
      const estimate = isInseparable(bucket.basis)
        ? { selectedWorkloadMs: undefined, selectedWorkloadConfidence: undefined, avoidableMs: undefined, avoidableTier: "UNKNOWN" as EvidenceTier, estimationMethod: "inseparable_workload" }
        : estimateStageEconomics({
            stage: bucket.stage,
            fullWorkloadMs: bucket.durationMs,
            testsSelectedDiffci: candidate.testsSelectedDiffci,
            testsTotalFull: candidate.testsTotalFull,
            planMode: candidate.planMode,
          });
      const isTest = bucket.stage === "test";
      return {
        logicalDeltaKey: candidate.logicalDeltaKey,
        stage: bucket.stage,
        classificationBasis: bucket.basis,
        classifierVersion: STAGE_CLASSIFIER_VERSION,
        repository: candidate.repository,
        headSha: candidate.headSha,
        evidenceRunId: String(evidenceRun.workflowRunId),
        evidenceWorkflowPath: evidenceRun.workflowPath,
        evidenceValidity: "VERIFIED",
        jobIds: bucket.jobIds,
        stepRefs: bucket.stepRefs,
        fullWorkloadMs: bucket.durationMs,
        testsTotalFull: isTest ? candidate.testsTotalFull : undefined,
        testsSelectedDiffci: isTest ? candidate.testsSelectedDiffci : undefined,
        testsSelectedPath: isTest ? candidate.testsSelectedPath : undefined,
        planMode: candidate.planMode,
        diffciAnalysisOverheadMs: isTest ? candidate.diffciAnalysisOverheadMs : undefined,
        selectedWorkloadMs: estimate.selectedWorkloadMs,
        selectedWorkloadConfidence: estimate.selectedWorkloadConfidence,
        avoidableMs: estimate.avoidableMs,
        avoidableTier: estimate.avoidableTier,
        estimationMethod: estimate.estimationMethod,
        estimatorVersion: ESTIMATOR_VERSION,
        observedAt,
      };
    });
}
