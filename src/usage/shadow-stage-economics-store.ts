/**
 * D1 persistence for shadow_stage_economics (2026-09-05, measurement-integrity repair step 3) - the
 * admitted, classified successor of shadow_economics_observations. The legacy table and its store are
 * untouched (labelled LEGACY_UNVERIFIED by the migration, excluded from reports).
 */
import type { StageEconomicsObservation } from "./shadow-stage-economics.js";
import type { CiStage } from "../shadow/stage-classification.js";
import type { ClassificationBasis } from "../shadow/stage-classification-config.js";
import type { EvidenceTier } from "./economics-classification.js";
import type { SavingsConfidence } from "./savings.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface ShadowStageEconomicsStore {
  /** False when this (logicalDeltaKey, stage) pair already exists - routine dedup, never an overwrite. */
  recordIfNew(observation: StageEconomicsObservation): Promise<boolean>;
  /** Delta keys already measured for a repository, so a sweep spends no GitHub call re-measuring them. */
  listRecordedDeltaKeys(repository: string): Promise<string[]>;
  /** Rows whose PREDICTION was created inside the window - the report input. */
  listForPredictionWindow(repository: string, startIso: string, endIso: string): Promise<StageEconomicsObservation[]>;
}

function ids(raw: unknown): number[] {
  try {
    const p = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(p) ? p.filter((x): x is number => typeof x === "number") : [];
  } catch {
    return [];
  }
}

function strings(raw: unknown): string[] {
  try {
    const p = JSON.parse(String(raw ?? "[]")) as unknown;
    return Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export function rowToStageObservation(row: Record<string, unknown>): StageEconomicsObservation {
  return {
    logicalDeltaKey: row.logical_delta_key as string,
    stage: row.stage as CiStage,
    classificationBasis: row.classification_basis as ClassificationBasis,
    classifierVersion: row.classifier_version as number,
    repository: row.repository as string,
    headSha: row.head_sha as string,
    evidenceRunId: String(row.evidence_run_id),
    evidenceWorkflowPath: row.evidence_workflow_path as string,
    evidenceValidity: "VERIFIED",
    jobIds: ids(row.job_ids),
    stepRefs: strings(row.step_refs),
    fullWorkloadMs: row.full_workload_ms as number,
    testsTotalFull: (row.tests_total_full as number | null) ?? undefined,
    testsSelectedDiffci: (row.tests_selected_diffci as number | null) ?? undefined,
    testsSelectedPath: (row.tests_selected_path as number | null) ?? undefined,
    planMode: (row.plan_mode as "FULL" | "SELECTIVE" | null) ?? undefined,
    diffciAnalysisOverheadMs: (row.diffci_analysis_overhead_ms as number | null) ?? undefined,
    selectedWorkloadMs: (row.selected_workload_ms as number | null) ?? undefined,
    selectedWorkloadConfidence: (row.selected_workload_confidence as SavingsConfidence | null) ?? undefined,
    avoidableMs: (row.avoidable_ms as number | null) ?? undefined,
    avoidableTier: row.avoidable_tier as EvidenceTier,
    estimationMethod: (row.estimation_method as string | null) ?? undefined,
    estimatorVersion: (row.estimator_version as number | null) ?? 0,
    observedAt: row.observed_at as string,
  };
}

export function makeD1ShadowStageEconomicsStore(db: D1Binding): ShadowStageEconomicsStore {
  return {
    async recordIfNew(o) {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO shadow_stage_economics
             (logical_delta_key, stage, classification_basis, classifier_version, repository, head_sha,
              evidence_run_id, evidence_workflow_path, evidence_validity, job_ids, step_refs, full_workload_ms,
              tests_total_full, tests_selected_diffci, tests_selected_path, plan_mode, diffci_analysis_overhead_ms,
              selected_workload_ms, selected_workload_confidence, avoidable_ms, avoidable_tier, estimation_method,
              estimator_version, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          o.logicalDeltaKey, o.stage, o.classificationBasis, o.classifierVersion, o.repository, o.headSha,
          o.evidenceRunId, o.evidenceWorkflowPath, o.evidenceValidity, JSON.stringify(o.jobIds), JSON.stringify(o.stepRefs), o.fullWorkloadMs,
          o.testsTotalFull ?? null, o.testsSelectedDiffci ?? null, o.testsSelectedPath ?? null, o.planMode ?? null, o.diffciAnalysisOverheadMs ?? null,
          o.selectedWorkloadMs ?? null, o.selectedWorkloadConfidence ?? null, o.avoidableMs ?? null, o.avoidableTier, o.estimationMethod ?? null,
          o.estimatorVersion, o.observedAt,
        )
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async listRecordedDeltaKeys(repository) {
      const { results } = await db
        .prepare(`SELECT DISTINCT logical_delta_key FROM shadow_stage_economics WHERE repository = ?`)
        .bind(repository)
        .all<{ logical_delta_key: string }>();
      return results.map((r) => r.logical_delta_key);
    },

    async listForPredictionWindow(repository, startIso, endIso) {
      const { results } = await db
        .prepare(
          `SELECT e.* FROM shadow_stage_economics e
           JOIN shadow_predictions p ON p.logical_delta_key = e.logical_delta_key
           WHERE e.repository = ? AND p.created_at >= ? AND p.created_at < ?
           ORDER BY e.observed_at ASC`,
        )
        .bind(repository, startIso, endIso)
        .all<Record<string, unknown>>();
      return results.map(rowToStageObservation);
    },
  };
}
