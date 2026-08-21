/**
 * Stage 2 ground-truth reconciliation (Phase 6/7). Deliberately reuses Stage 1B's already-validated
 * generic safety-measurement pipeline (src/research/historical/evidence-collector.ts -
 * collectHistoricalEvidenceForDelta) rather than the DentalPresence-specific one
 * (src/shadow/failure-recall.ts, which matches on hardcoded step-name substrings only meaningful for
 * this repo's own CI). Stage 2's Gate A targets arbitrary third-party repositories, so the generic,
 * task-registry-driven matcher is the correct one to build on here - it's also the one that already
 * carries the Stage 1B methodology fixes this task explicitly asks to apply (test-category filtering,
 * cross-commit flakiness exclusion).
 *
 * Pure and Workers-native: no filesystem/git access, no Sandbox Container needed - fetchBaselineEvidence
 * is a plain `fetch()` to the GitHub REST API, which Cloudflare Workers can call directly. Reconciliation
 * can therefore run straight from the Worker's own fetch()/scheduled() handler.
 */
import type { ExecutionPlan } from "../planner/types.js";
import { collectHistoricalEvidenceForDelta, filterToTestCategoryTaskIds, type FetchBaselineFn } from "../research/historical/evidence-collector.js";
import { checkJobFlakiness } from "../research/historical/flakiness-check.js";
import { computeMeasuredMetrics } from "./task-mapping.js";
import { predictionPrecededGroundTruth } from "./event-identity.js";
import { createRateBudget, type RateBudget } from "../research/historical/rate-budget.js";
import type { BaselineEvidence } from "./types.js";

export interface PendingPrediction {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  plan: ExecutionPlan;
  /** Task-level PATH selection (runGenericPathBaseline), NOT the test-file-level pathSelectedTests count
   * used for the coverage/test-count comparison - safety-recall matching happens at the task/job level. */
  pathSelectedTaskIds: string[];
  diffciAnalysisOverheadMs: number;
  predictionCreatedAt: string;
}

export interface ReconcileResult {
  status: "STILL_PENDING" | "RECONCILED";
  reason?: string;
  /** Structured classification of `reason` for STILL_PENDING - see HistoricalEvidenceResult.pendingReason.
   * Undefined for RECONCILED (not meaningful there). */
  pendingReason?: "no_matching_workflow" | "ci_queued" | "ci_in_progress" | "github_rate_limit" | "fetch_error";
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  groundTruthStatus?: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  workflowRunId?: string;
  workflowConclusion?: string;
  workflowCompletedAt?: string;
  relevantFailuresObserved?: number;
  relevantFailuresEvaluable?: number;
  failuresPreservedByDiffci?: number;
  failuresPreservedByPath?: number;
  diffciProspectiveRecallPercent?: number;
  pathProspectiveRecallPercent?: number;
  diffciHypotheticalUnsafeMisses?: string[];
  pathHypotheticalUnsafeMisses?: string[];
  nonTestCategoryExcludedTargets?: string[];
  likelyFlakyExcludedTargets?: string[];
  measured?: ReturnType<typeof computeMeasuredMetrics>;
  predictionPrecededGroundTruth?: boolean;
  groundTruthFetchedAt: string;
  baseline?: BaselineEvidence;
}

export interface ReconcilePredictionOptions {
  token?: string;
  budget?: RateBudget;
  checkFlakiness?: boolean;
  /** Injectable for testing without live GitHub calls. */
  fetchFn?: FetchBaselineFn;
  flakinessCheckFn?: typeof checkJobFlakiness;
}

/**
 * Attempts to reconcile one pending prediction against real CI outcomes. Returns STILL_PENDING (not an
 * error) when no completed non-shadow CI run exists yet for this commit - the caller should try again
 * later, not treat this as a failure or as an "unsafe miss" by omission (never claim recall from an
 * empty denominator - Phase 7).
 */
export async function reconcilePrediction(
  prediction: PendingPrediction,
  options: ReconcilePredictionOptions = {},
): Promise<ReconcileResult> {
  const { token, checkFlakiness = true, fetchFn, flakinessCheckFn } = options;
  const budget = options.budget ?? createRateBudget(token ? 4500 : 50);
  const groundTruthFetchedAt = new Date().toISOString();

  const evidence = await collectHistoricalEvidenceForDelta({
    repository: prediction.repository,
    headSha: prediction.headSha,
    token,
    plan: prediction.plan,
    pathSelectedTaskIds: prediction.pathSelectedTaskIds,
    changedFiles: [],
    budget,
    checkFlakiness,
    fetchFn,
    flakinessCheckFn,
  });

  if (evidence.status === "UNAVAILABLE") {
    return {
      status: "STILL_PENDING",
      reason: evidence.reason,
      pendingReason: evidence.pendingReason,
      logicalDeltaKey: prediction.logicalDeltaKey,
      repository: prediction.repository,
      headSha: prediction.headSha,
      groundTruthFetchedAt,
    };
  }

  // Re-fetch the raw baseline once more only to compute workflow-level metadata (completion timestamp,
  // conclusion, run id) that collectHistoricalEvidenceForDelta's return type doesn't carry through -
  // charged against the same budget, so it's still accounted for, not free.
  const rawBaseline = fetchFn
    ? await fetchFn({ repository: prediction.repository, headSha: prediction.headSha, token })
    : await (await import("./github-baseline.js")).fetchBaselineEvidence({ repository: prediction.repository, headSha: prediction.headSha, token });

  const { testTargets: allRelevantFailures } = filterToTestCategoryTaskIds(evidence.failedTargets, prediction.plan);
  const relevantFailuresObserved = allRelevantFailures.length;
  const realFailures = allRelevantFailures.filter((id) => !evidence.likelyFlakyExcludedTargets.includes(id));
  const relevantFailuresEvaluable = realFailures.length;
  const failuresMissedByDiffci = evidence.unsafeMissTargets.length;
  const failuresMissedByPath = evidence.pathUnsafeMissTargets.length;
  const failuresPreservedByDiffci = Math.max(0, relevantFailuresEvaluable - failuresMissedByDiffci);
  const failuresPreservedByPath = Math.max(0, relevantFailuresEvaluable - failuresMissedByPath);

  const latestJobCompletedAt = rawBaseline.jobs
    .map((j) => j.completedAt)
    .filter((v): v is string => typeof v === "string")
    .sort()
    .pop();
  const workflowConclusion = rawBaseline.fullRunsObserved.every((r) => r.conclusion === "success")
    ? "success"
    : rawBaseline.fullRunsObserved.some((r) => r.conclusion === "failure")
      ? "failure"
      : undefined;

  const measured = computeMeasuredMetrics(prediction.plan, rawBaseline, prediction.diffciAnalysisOverheadMs);

  return {
    status: "RECONCILED",
    logicalDeltaKey: prediction.logicalDeltaKey,
    repository: prediction.repository,
    headSha: prediction.headSha,
    // Map evidence-collector.ts's HistoricalEvidenceStatus vocabulary (MEASURABLE/PARTIALLY_MEASURABLE)
    // onto Stage 2's own ground-truth status vocabulary (COMPLETE/PARTIAL) - deliberately explicit rather
    // than a same-shape cast, since the two enums' literal values don't actually match.
    groundTruthStatus: evidence.status === "MEASURABLE" ? "COMPLETE" : "PARTIAL",
    workflowRunId: rawBaseline.fullRunsObserved[0]?.workflowRunId?.toString(),
    workflowConclusion,
    workflowCompletedAt: latestJobCompletedAt,
    relevantFailuresObserved,
    relevantFailuresEvaluable,
    failuresPreservedByDiffci,
    failuresPreservedByPath,
    diffciProspectiveRecallPercent: relevantFailuresEvaluable > 0 ? (failuresPreservedByDiffci / relevantFailuresEvaluable) * 100 : undefined,
    pathProspectiveRecallPercent: relevantFailuresEvaluable > 0 ? (failuresPreservedByPath / relevantFailuresEvaluable) * 100 : undefined,
    diffciHypotheticalUnsafeMisses: evidence.unsafeMissTargets,
    pathHypotheticalUnsafeMisses: evidence.pathUnsafeMissTargets,
    nonTestCategoryExcludedTargets: evidence.nonTestCategoryExcludedTargets,
    likelyFlakyExcludedTargets: evidence.likelyFlakyExcludedTargets,
    measured,
    predictionPrecededGroundTruth: predictionPrecededGroundTruth(prediction.predictionCreatedAt, {
      workflowCompletedAt: latestJobCompletedAt,
      groundTruthFetchedAt,
    }),
    groundTruthFetchedAt,
    baseline: rawBaseline,
  };
}
