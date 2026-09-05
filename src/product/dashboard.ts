/**
 * Dashboard-facing response contracts (Part 21) - pure composition over already-built domain services
 * (entitlements, usage aggregation, savings, the shadow read boundary). Nothing here queries D1 directly;
 * every input is passed in already-computed, which keeps this module trivially unit-testable and keeps
 * "what counts as a safety claim" in one reviewable place (Part 21: "Do not expose misleading
 * production-safety claims").
 */
import type { Entitlements } from "../billing/types.js";
import type { AllowanceStatus } from "../usage/aggregation.js";
import type { UsageSummary } from "../usage/types.js";
import type { AggregateSavings } from "../usage/savings.js";
import type { ShadowEvidenceWorkflowState, ShadowSafetySnapshot } from "./shadow-read-boundary.js";
import type { Organization } from "./types.js";
import type { Runner } from "../runner/types.js";

export interface DashboardOverview {
  repositories: number;
  predictionsThisMonth: number;
  ciRunsAnalyzedThisMonth: number;
  selectivePercent: number;
  fullPercent: number;
  testsAvoided: number | "unknown";
  estimatedCiSecondsSaved: number | "unknown";
  estimatedCostSavedUsd: number | "unknown";
  /** Climate-impact sibling of estimatedCostSavedUsd - see src/usage/climate-model.ts for why this is
   * always an illustrative estimate, never a stronger claim, regardless of how the underlying compute
   * count was measured. */
  estimatedCarbonAvoidedKgCo2e: number | "unknown";
  activePlan: string;
  /**
   * 2026-09-05: the testsAvoided / estimatedCiSecondsSaved / estimatedCostSavedUsd /
   * estimatedCarbonAvoidedKgCo2e figures above are projected from selected-test COUNTS across this
   * month's predictions (src/usage/savings.ts). They are NOT derived from admitted CI evidence: no
   * workflow identity, no verified ground truth, no measured stage workload. Admitted stage-economics
   * estimates live in the per-repository report. A consumer must show `savingsNotice` beside them.
   */
  savingsBasis: "count_based_projection";
  savingsNotice: string;
}

export const SAVINGS_NOTICE =
  "Projected from selected-test counts across this month's predictions - not derived from admitted CI evidence. " +
  "Potential opportunity only; the per-repository report carries the evidence-labelled figures.";

export interface DashboardEvidenceWorkflow {
  /** 'awaiting_identification' when ANY of the organization's repositories has no identified evidence workflow. */
  state: "identified" | "awaiting_identification" | "no_repositories";
  repositoriesAwaiting: string[];
  /** Present whenever state is awaiting_identification - the sentence a consumer must show. */
  notice?: string;
}

export const AWAITING_EVIDENCE_WORKFLOW_NOTICE =
  "Awaiting CI evidence workflow identification - predictions may be generated, but ground truth and savings evidence are not yet available. " +
  "Zero observations is not zero opportunity.";

export interface DashboardSafety {
  evaluableFailures: number;
  failuresPreserved: number;
  falseNegatives: number;
  /**
   * Deliberately NOT "safe to enable enforcement" or any production-readiness claim - Stage 2F is
   * shadow-only by explicit, standing instruction across every Stage 2 task this build has seen. This
   * field can only ever be "shadow_observation_only" today; it exists as a field (rather than a
   * hardcoded string in every caller) so a future real Stage 3 status has exactly one place to change.
   */
  observationMode: "shadow_observation_only";
  /** 2026-09-05: the three figures above are counted over VERIFIED ground truth only. */
  evidenceBasis: "verified_ground_truth_only";
  verifiedGroundTruthRows: number;
  evidenceWorkflow: DashboardEvidenceWorkflow;
}

export interface DashboardUsage {
  ciRunsAnalyzed: AllowanceStatus;
}

export interface DashboardRecentActivity {
  recentPredictions: Array<{ repository: string; planMode: "FULL" | "SELECTIVE"; testsSelected: number; testsTotal: number; createdAt: string }>;
  recentRunnerJobs: Array<{ runnerId: string; status: Runner["status"]; createdAt: string }>;
}

export interface DashboardContract {
  overview: DashboardOverview;
  safety: DashboardSafety;
  usage: DashboardUsage;
  recentActivity: DashboardRecentActivity;
}

export function buildDashboardOverview(
  org: Organization,
  repositoryCount: number,
  usage: UsageSummary,
  predictionCounts: { selective: number; full: number },
  savings: AggregateSavings,
): DashboardOverview {
  const totalModePredictions = predictionCounts.selective + predictionCounts.full;
  return {
    repositories: repositoryCount,
    predictionsThisMonth: usage.predictions,
    ciRunsAnalyzedThisMonth: usage.ciRunsAnalyzed,
    selectivePercent: totalModePredictions > 0 ? (predictionCounts.selective / totalModePredictions) * 100 : 0,
    fullPercent: totalModePredictions > 0 ? (predictionCounts.full / totalModePredictions) * 100 : 0,
    testsAvoided: savings.totalTestsAvoided.value,
    estimatedCiSecondsSaved: savings.totalEstimatedComputeSecondsAvoided.value,
    estimatedCostSavedUsd: savings.totalEstimatedCostAvoidedUsd.value,
    estimatedCarbonAvoidedKgCo2e: savings.totalEstimatedCarbonAvoidedKgCo2e.value,
    activePlan: org.currentPlan,
    savingsBasis: "count_based_projection",
    savingsNotice: SAVINGS_NOTICE,
  };
}

export function buildDashboardSafety(snapshot: ShadowSafetySnapshot, evidenceWorkflows: readonly ShadowEvidenceWorkflowState[]): DashboardSafety {
  const repositoriesAwaiting = evidenceWorkflows.filter((w) => w.state === "awaiting_identification").map((w) => w.ownerName);
  const evidenceWorkflow: DashboardEvidenceWorkflow =
    evidenceWorkflows.length === 0
      ? { state: "no_repositories", repositoriesAwaiting: [] }
      : repositoriesAwaiting.length > 0
        ? { state: "awaiting_identification", repositoriesAwaiting, notice: AWAITING_EVIDENCE_WORKFLOW_NOTICE }
        : { state: "identified", repositoriesAwaiting: [] };
  return {
    evaluableFailures: snapshot.evaluableFailures,
    failuresPreserved: snapshot.failuresPreserved,
    falseNegatives: snapshot.falseNegatives,
    observationMode: "shadow_observation_only",
    evidenceBasis: "verified_ground_truth_only",
    verifiedGroundTruthRows: snapshot.verifiedGroundTruthRows,
    evidenceWorkflow,
  };
}

export function buildDashboardUsage(entitlements: Entitlements, allowance: AllowanceStatus): DashboardUsage {
  void entitlements; // reserved for future multi-metric usage sections; kept in the signature so callers don't need to change when that lands
  return { ciRunsAnalyzed: allowance };
}

export function buildDashboardRecentActivity(
  predictions: Array<{ repository: string; planMode: "FULL" | "SELECTIVE"; testsSelectedDiffci: number; testsTotalFull: number; createdAt: string }>,
  runners: Runner[],
): DashboardRecentActivity {
  return {
    recentPredictions: predictions.map((p) => ({ repository: p.repository, planMode: p.planMode, testsSelected: p.testsSelectedDiffci, testsTotal: p.testsTotalFull, createdAt: p.createdAt })),
    recentRunnerJobs: runners.map((r) => ({ runnerId: r.id, status: r.status, createdAt: r.createdAt })),
  };
}

export function buildDashboardContract(
  overview: DashboardOverview,
  safety: DashboardSafety,
  usage: DashboardUsage,
  recentActivity: DashboardRecentActivity,
): DashboardContract {
  return { overview, safety, usage, recentActivity };
}
