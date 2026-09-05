/**
 * Assembles a live ShadowRepositoryReport straight from D1, for the hosted per-repository report route
 * (YC readiness Week 1, 2026-09-04). Mirrors scripts/generate-shadow-report.ts's own query shape exactly
 * (eligiblePredictions denominator, the prediction-window-membership join for observations, safety from
 * shadow_ground_truth) - that script's own header already anticipated this: "A route can come later if
 * this is ever automated." Read-only by construction - every statement here is a SELECT.
 *
 * A separate module from validation-worker.ts so this query-assembly logic is unit-testable against a
 * fake D1Binding, the same dependency-injection discipline the rest of this codebase already holds to.
 */
import { rollUpShadowReport, type EvidenceWorkflowState, type ShadowRepositoryReport } from "../../usage/shadow-report-rollup.js";
import type { ShadowEconomicsObservation } from "../../usage/shadow-economics.js";
import type { CiStage } from "../../shadow/stage-classification.js";
import type { EvidenceTier } from "../../usage/economics-classification.js";
import type { SavingsConfidence } from "../../usage/savings.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

interface RawObservationRow {
  logical_delta_key: string;
  stage: string;
  repository: string;
  head_sha: string;
  workflow_run_ids: string;
  job_ids: string;
  full_workload_ms: number;
  tests_total_full: number | null;
  tests_selected_diffci: number | null;
  tests_selected_path: number | null;
  diffci_analysis_overhead_ms: number | null;
  plan_mode: string | null;
  selected_workload_ms: number | null;
  selected_workload_confidence: string | null;
  avoidable_ms: number | null;
  avoidable_tier: string;
  estimation_method: string | null;
  estimator_version: number | null;
  estimated_at: string | null;
  schema_version: number;
  observed_at: string;
  classification_basis?: string | null;
  evidence_workflow_path?: string | null;
}

function parseIdArray(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function toObservation(row: RawObservationRow): ShadowEconomicsObservation {
  return {
    logicalDeltaKey: row.logical_delta_key,
    stage: row.stage as CiStage,
    repository: row.repository,
    headSha: row.head_sha,
    workflowRunIds: parseIdArray(row.workflow_run_ids),
    jobIds: parseIdArray(row.job_ids),
    fullWorkloadMs: row.full_workload_ms,
    testsTotalFull: row.tests_total_full ?? undefined,
    testsSelectedDiffci: row.tests_selected_diffci ?? undefined,
    testsSelectedPath: row.tests_selected_path ?? undefined,
    diffciAnalysisOverheadMs: row.diffci_analysis_overhead_ms ?? undefined,
    planMode: (row.plan_mode as "FULL" | "SELECTIVE" | null) ?? undefined,
    selectedWorkloadMs: row.selected_workload_ms ?? undefined,
    selectedWorkloadConfidence: (row.selected_workload_confidence as SavingsConfidence | null) ?? undefined,
    avoidableMs: row.avoidable_ms ?? undefined,
    avoidableTier: row.avoidable_tier as EvidenceTier,
    estimationMethod: row.estimation_method ?? undefined,
    estimatorVersion: row.estimator_version ?? undefined,
    estimatedAt: row.estimated_at ?? undefined,
    schemaVersion: row.schema_version,
    observedAt: row.observed_at,
  };
}

/** repository must already have passed the same `[A-Za-z0-9._-]+/[A-Za-z0-9._-]+` shape check every
 *  other shadow route in this Worker applies before reaching here - this function trusts its caller for
 *  that, exactly as validation-worker.ts's other D1-querying handlers already do. */
export async function buildLiveShadowReport(db: D1Binding, repository: string, days: number): Promise<ShadowRepositoryReport> {
  const windowEnd = new Date();
  const windowStart = new Date(windowEnd.getTime() - days * 86_400_000);
  const windowStartIso = windowStart.toISOString();
  const windowEndIso = windowEnd.toISOString();

  // 2026-09-05 (repair step 2): the repository's explicitly identified CI evidence workflow. Without it
  // nothing is admitted as ground truth or economics, and the report says so instead of showing zeros.
  const repoRow = await db
    .prepare(`SELECT evidence_workflow_paths FROM shadow_repositories WHERE repository = ?`)
    .bind(repository)
    .first<{ evidence_workflow_paths: string | null }>();
  let evidencePaths: string[] | undefined;
  try {
    const parsed = repoRow?.evidence_workflow_paths ? (JSON.parse(repoRow.evidence_workflow_paths) as unknown) : undefined;
    evidencePaths = Array.isArray(parsed) && parsed.length > 0 && parsed.every((x) => typeof x === "string") ? (parsed as string[]) : undefined;
  } catch {
    evidencePaths = undefined;
  }
  const evidenceWorkflow: EvidenceWorkflowState = evidencePaths ? { state: "IDENTIFIED", paths: evidencePaths } : { state: "AWAITING_IDENTIFICATION" };

  const eligibleRow = await db
    .prepare(`SELECT COUNT(*) as n FROM shadow_predictions WHERE repository = ? AND created_at >= ? AND created_at < ?`)
    .bind(repository, windowStartIso, windowEndIso)
    .first<{ n: number }>();
  const eligiblePredictions = eligibleRow?.n ?? 0;

  // 2026-09-05 (repair step 3): observations come from shadow_stage_economics - admitted (VERIFIED)
  // evidence, classified against the repository's explicit stage configuration - never from the
  // legacy shadow_economics_observations table, which is labelled LEGACY_UNVERIFIED and retired from
  // every report. Same column aliasing as scripts/generate-shadow-report.ts. Observations are selected
  // by their PREDICTION's window membership, not capture time - see that script's own comment on why
  // filtering by observed_at would drift the numerator away from the denominator.
  const { results: rawRows } = await db
    .prepare(
      `SELECT e.logical_delta_key, e.stage, e.repository, e.head_sha,
              [ || e.evidence_run_id || ] AS workflow_run_ids, e.job_ids, e.full_workload_ms,
              e.tests_total_full, e.tests_selected_diffci, e.tests_selected_path, e.diffci_analysis_overhead_ms, e.plan_mode,
              e.selected_workload_ms, e.selected_workload_confidence, e.avoidable_ms, e.avoidable_tier, e.estimation_method,
              e.estimator_version, e.observed_at AS estimated_at, 2 AS schema_version, e.observed_at,
              e.classification_basis, e.evidence_workflow_path
       FROM shadow_stage_economics e
       JOIN shadow_predictions p ON p.logical_delta_key = e.logical_delta_key
       WHERE e.repository = ? AND e.evidence_validity = VERIFIED AND p.created_at >= ? AND p.created_at < ?
       ORDER BY e.observed_at ASC`,
    )
    .bind(repository, windowStartIso, windowEndIso)
    .all<RawObservationRow>();

  // Safety over VERIFIED ground truth only (repair step 2): a run counts only if it is the identified
  // evidence workflow and actually executed. UNVERIFIED / CONTAMINATED rows are kept, never counted.
  const safetyRow = await db
    .prepare(
      `SELECT COALESCE(SUM(g.relevant_failures_evaluable), 0) as evaluable, COALESCE(SUM(g.failures_preserved_by_diffci), 0) as preserved
       FROM shadow_ground_truth g JOIN shadow_predictions p ON p.logical_delta_key = g.logical_delta_key
       WHERE p.repository = ? AND g.evidence_validity = VERIFIED`,
    )
    .bind(repository)
    .first<{ evaluable: number; preserved: number }>();
  const evaluableFailures = safetyRow?.evaluable ?? 0;
  const failuresPreserved = safetyRow?.preserved ?? 0;

  return rollUpShadowReport({
    repository,
    windowStartIso,
    windowEndIso,
    observations: rawRows.map(toObservation),
    eligiblePredictions,
    safety: { evaluableFailures, failuresPreserved, falseNegatives: Math.max(0, evaluableFailures - failuresPreserved) },
    evidenceWorkflow,
  });
}
