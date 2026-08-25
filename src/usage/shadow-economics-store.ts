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
    schemaVersion: row.schema_version as number,
    observedAt: row.observed_at as string,
  };
}

export interface ShadowEconomicsStore {
  /** Returns false if this exact (logicalDeltaKey, stage) pair was already recorded (routine dedup). */
  recordIfNew(observation: ShadowEconomicsObservation): Promise<boolean>;
  /** This repository's own past 'test'-stage observations - the exact input
   * computeHistoricalTestSecondsPerTest needs, scoped to avoid cross-repository/cross-stage contamination. */
  listTestStageObservations(repository: string, limit: number): Promise<ShadowEconomicsObservation[]>;
  /** All stages for a repository within a time window - the input a report rollup (M3) reads. */
  listForReport(repository: string, startIso: string, endIso: string): Promise<ShadowEconomicsObservation[]>;
}

export function makeD1ShadowEconomicsStore(db: D1Binding): ShadowEconomicsStore {
  return {
    async recordIfNew(observation) {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO shadow_economics_observations
             (logical_delta_key, stage, repository, head_sha, workflow_run_ids, job_ids, full_workload_ms,
              tests_total_full, selected_workload_ms, selected_workload_confidence, avoidable_ms,
              avoidable_tier, estimation_method, schema_version, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        )
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async listTestStageObservations(repository, limit) {
      const { results } = await db
        .prepare(`SELECT * FROM shadow_economics_observations WHERE repository = ? AND stage = 'test' ORDER BY observed_at DESC LIMIT ?`)
        .bind(repository, limit)
        .all<Record<string, unknown>>();
      return results.map(rowToObservation);
    },

    async listForReport(repository, startIso, endIso) {
      const { results } = await db
        .prepare(`SELECT * FROM shadow_economics_observations WHERE repository = ? AND observed_at >= ? AND observed_at < ? ORDER BY observed_at DESC`)
        .bind(repository, startIso, endIso)
        .all<Record<string, unknown>>();
      return results.map(rowToObservation);
    },
  };
}
