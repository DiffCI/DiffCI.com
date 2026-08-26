/**
 * D1 persistence for shadow_economics_observations (see
 * src/usage/cloudflare/schema-migration-2026-08-25-shadow-economics.sql for the full rationale). Same
 * idempotency idiom as duration-observation-store.ts's ci_duration_observations: INSERT OR IGNORE keyed
 * on a compound PRIMARY KEY, so a capture sweep that re-observes the same (commit, stage) pair twice
 * (retried sweep, overlapping cron runs) can only ever produce one row for it.
 */
import type { ShadowEconomicsObservation } from "./shadow-economics.js";
import type { EvidenceTier } from "./economics-classification.js";
import type { SavingsConfidence } from "./savings.js";
import type { CiStage } from "../shadow/stage-classification.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

function parseIdArray(value: unknown): number[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((v): v is number => typeof v === "number") : [];
  } catch {
    return [];
  }
}

function rowToObservation(row: Record<string, unknown>): ShadowEconomicsObservation {
  return {
    logicalDeltaKey: row.logical_delta_key as string,
    stage: row.stage as CiStage,
    repository: row.repository as string,
    headSha: row.head_sha as string,
    workflowRunIds: parseIdArray(row.workflow_run_ids),
    jobIds: parseIdArray(row.job_ids),
    fullWorkloadMs: row.full_workload_ms as number,
    testsTotalFull: (row.tests_total_full as number | null) ?? undefined,
    selectedWorkloadMs: (row.selected_workload_ms as number | null) ?? undefined,
    selectedWorkloadConfidence: (row.selected_workload_confidence as SavingsConfidence | null) ?? undefined,
    avoidableMs: (row.avoidable_ms as number | null) ?? undefined,
    avoidableTier: row.avoidable_tier as EvidenceTier,
    estimationMethod: (row.estimation_method as string | null) ?? undefined,
    testsSelectedDiffci: (row.tests_selected_diffci as number | null) ?? undefined,
    planMode: (row.plan_mode as "FULL" | "SELECTIVE" | null) ?? undefined,
    estimatorVersion: (row.estimator_version as number | null) ?? undefined,
    estimatedAt: (row.estimated_at as string | null) ?? undefined,
    schemaVersion: row.schema_version as number,
    observedAt: row.observed_at as string,
  };
}

export interface ShadowEconomicsStore {
  /** Returns false if this exact (logicalDeltaKey, stage) pair was already recorded (routine dedup). */
  recordIfNew(observation: ShadowEconomicsObservation): Promise<boolean>;
  /** All stages for a repository within a time window - the input a report rollup (M3) reads. */
  listForReport(repository: string, startIso: string, endIso: string): Promise<ShadowEconomicsObservation[]>;
  /** Rows whose DERIVED estimate is stale: either produced by an older estimator, or left UNKNOWN when
   * its inputs are now sufficient to estimate. Bounded by `limit` so a sweep is always cheap. */
  listRowsNeedingRecompute(currentEstimatorVersion: number, limit: number): Promise<ShadowEconomicsObservation[]>;
  /** Overwrites ONLY the derived estimate fields for one (logical_delta_key, stage), and appends an audit
   * row capturing before/after. Raw telemetry - measured workload, counts, commit identity, plan mode -
   * is never touched by this statement, which is enforced by the SQL itself listing only derived columns. */
  applyRecompute(input: RecomputeUpdate): Promise<void>;
  /** Every logical_delta_key this repository ALREADY has at least one stage row for. Read once per
   * repository per sweep so the sweep can skip predictions it has already measured WITHOUT spending a
   * GitHub API call or a slot of its per-sweep budget on them.
   *
   * Deliberately a whole-key set rather than a cursor/high-water-mark: predictions are not ordered by
   * capture-ability (an older commit whose CI was still running when it was first attempted becomes
   * capturable later, and a cursor would skip past it forever), and "skip what is recorded, keep
   * scanning" is naturally idempotent where a stored cursor is one more piece of state to get wrong. */
  listRecordedDeltaKeys(repository: string): Promise<string[]>;
}

export interface RecomputeUpdate {
  logicalDeltaKey: string;
  stage: CiStage;
  repository: string;
  reason: "unknown_now_estimable" | "estimator_version_upgrade";
  fromEstimatorVersion: number | undefined;
  toEstimatorVersion: number;
  before: { selectedWorkloadMs: number | undefined; avoidableMs: number | undefined; avoidableTier: EvidenceTier };
  after: {
    selectedWorkloadMs: number | undefined;
    selectedWorkloadConfidence: SavingsConfidence | undefined;
    avoidableMs: number | undefined;
    avoidableTier: EvidenceTier;
    estimationMethod: string | undefined;
  };
  recomputedAt: string;
}

export function makeD1ShadowEconomicsStore(db: D1Binding): ShadowEconomicsStore {
  return {
    async recordIfNew(observation) {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO shadow_economics_observations
             (logical_delta_key, stage, repository, head_sha, workflow_run_ids, job_ids, full_workload_ms,
              tests_total_full, selected_workload_ms, selected_workload_confidence, avoidable_ms,
              avoidable_tier, estimation_method, schema_version, observed_at,
              tests_selected_diffci, plan_mode, estimator_version, estimated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          observation.logicalDeltaKey,
          observation.stage,
          observation.repository,
          observation.headSha,
          JSON.stringify(observation.workflowRunIds),
          JSON.stringify(observation.jobIds),
          observation.fullWorkloadMs,
          observation.testsTotalFull ?? null,
          observation.selectedWorkloadMs ?? null,
          observation.selectedWorkloadConfidence ?? null,
          observation.avoidableMs ?? null,
          observation.avoidableTier,
          observation.estimationMethod ?? null,
          observation.schemaVersion,
          observation.observedAt,
          observation.testsSelectedDiffci ?? null,
          observation.planMode ?? null,
          observation.estimatorVersion ?? null,
          observation.estimatedAt ?? null,
        )
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async listForReport(repository, startIso, endIso) {
      const { results } = await db
        .prepare(`SELECT * FROM shadow_economics_observations WHERE repository = ? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at DESC`)
        .bind(repository, startIso, endIso)
        .all<Record<string, unknown>>();
      return results.map(rowToObservation);
    },

    async listRowsNeedingRecompute(currentEstimatorVersion, limit) {
      const { results } = await db
        .prepare(
          `SELECT * FROM shadow_economics_observations
             WHERE estimator_version IS NULL OR estimator_version < ?
             ORDER BY observed_at ASC
             LIMIT ?`,
        )
        .bind(currentEstimatorVersion, limit)
        .all<Record<string, unknown>>();
      return results.map(rowToObservation);
    },

    async applyRecompute(input) {
      // Audit FIRST, so a value that ever appeared in a report is recoverable even if the update below
      // fails partway. Append-only; never updated or deleted.
      await db
        .prepare(
          `INSERT INTO shadow_economics_recompute_audit
             (logical_delta_key, stage, repository, reason, from_estimator_version, to_estimator_version,
              before_selected_workload_ms, before_avoidable_ms, before_avoidable_tier,
              after_selected_workload_ms, after_avoidable_ms, after_avoidable_tier, recomputed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.logicalDeltaKey,
          input.stage,
          input.repository,
          input.reason,
          input.fromEstimatorVersion ?? null,
          input.toEstimatorVersion,
          input.before.selectedWorkloadMs ?? null,
          input.before.avoidableMs ?? null,
          input.before.avoidableTier,
          input.after.selectedWorkloadMs ?? null,
          input.after.avoidableMs ?? null,
          input.after.avoidableTier,
          input.recomputedAt,
        )
        .run();

      // DERIVED COLUMNS ONLY. full_workload_ms, tests_total_full, tests_selected_diffci, plan_mode,
      // workflow_run_ids, job_ids, head_sha, observed_at and schema_version are deliberately absent from
      // this SET list - raw telemetry is immutable once captured.
      await db
        .prepare(
          `UPDATE shadow_economics_observations
             SET selected_workload_ms = ?, selected_workload_confidence = ?, avoidable_ms = ?,
                 avoidable_tier = ?, estimation_method = ?, estimator_version = ?, estimated_at = ?
             WHERE logical_delta_key = ? AND stage = ?`,
        )
        .bind(
          input.after.selectedWorkloadMs ?? null,
          input.after.selectedWorkloadConfidence ?? null,
          input.after.avoidableMs ?? null,
          input.after.avoidableTier,
          input.after.estimationMethod ?? null,
          input.toEstimatorVersion,
          input.recomputedAt,
          input.logicalDeltaKey,
          input.stage,
        )
        .run();
    },

    async listRecordedDeltaKeys(repository) {
      const { results } = await db
        .prepare(`SELECT DISTINCT logical_delta_key FROM shadow_economics_observations WHERE repository = ?`)
        .bind(repository)
        .all<{ logical_delta_key: string }>();
      return results.map((r) => r.logical_delta_key);
    },
  };
}
