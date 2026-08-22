/**
 * D1 persistence for runners (Part 14), same D1Binding idiom as the rest of the codebase. Every status
 * write goes through transitionRunnerStatus(), which calls lifecycle.ts's assertValidTransition() BEFORE
 * issuing the UPDATE - an illegal transition throws and the row is left untouched, never partially
 * updated.
 */
export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

import { assertValidTransition } from "./lifecycle.js";
import type { Runner, RunnerState } from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRunner(row: Record<string, unknown>): Runner {
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    provider: row.provider as string,
    providerRunnerId: (row.provider_runner_id as string | null) ?? undefined,
    status: row.status as RunnerState,
    requestedResourceClass: row.requested_resource_class as string,
    repositoryId: (row.repository_id as string | null) ?? undefined,
    assignedJobId: (row.assigned_job_id as string | null) ?? undefined,
    createdAt: row.created_at as string,
    readyAt: (row.ready_at as string | null) ?? undefined,
    startedAt: (row.started_at as string | null) ?? undefined,
    completedAt: (row.completed_at as string | null) ?? undefined,
    terminatedAt: (row.terminated_at as string | null) ?? undefined,
    runtimeSeconds: (row.runtime_seconds as number | null) ?? undefined,
    costEstimateUsd: (row.cost_estimate_usd as number | null) ?? undefined,
    costBasis: (row.cost_basis as string | null) ?? undefined,
    lastHeartbeatAt: (row.last_heartbeat_at as string | null) ?? undefined,
    failureReason: (row.failure_reason as string | null) ?? undefined,
  };
}

export interface RunnerStore {
  createRunner(input: { organizationId: string; provider: string; requestedResourceClass: string; repositoryId?: string }): Promise<Runner>;
  getRunner(id: string): Promise<Runner | null>;
  /** Tenant-scoped lookup (Part 14/23) - returns null (not the runner from another org) if the runner
   * exists but belongs to a different organization, so a caller that forgets to separately check
   * ownership still cannot leak cross-org data by construction. */
  getRunnerForOrganization(id: string, organizationId: string): Promise<Runner | null>;
  listRunnersForOrganization(organizationId: string, limit?: number): Promise<Runner[]>;
  setProviderRunnerId(id: string, providerRunnerId: string): Promise<void>;
  /** Throws InvalidRunnerTransitionError (lifecycle.ts) without writing anything if `to` is not a legal
   * transition from the runner's CURRENT persisted status. */
  transitionRunnerStatus(id: string, to: RunnerState, extra?: { runtimeSeconds?: number; costEstimateUsd?: number; costBasis?: string; failureReason?: string }): Promise<Runner>;
  assignJob(id: string, jobId: string): Promise<void>;
  /** Part 15 orphan detection: runners stuck in a non-terminal state past the given cutoff timestamp. */
  findStaleRunners(olderThanIso: string, statuses: RunnerState[]): Promise<Runner[]>;
  /** R1 Part 18: updated by every real runner-agent callback (register/heartbeat/claim/result), not
   * just the dedicated heartbeat route - any successful call from the runner IS a liveness signal. */
  recordHeartbeat(id: string): Promise<void>;
}

export function makeD1RunnerStore(db: D1Binding): RunnerStore {
  return {
    async createRunner({ organizationId, provider, requestedResourceClass, repositoryId }) {
      const id = crypto.randomUUID();
      const ts = nowIso();
      await db
        .prepare(`INSERT INTO runners (id, organization_id, provider, status, requested_resource_class, repository_id, created_at) VALUES (?, ?, ?, 'requested', ?, ?, ?)`)
        .bind(id, organizationId, provider, requestedResourceClass, repositoryId ?? null, ts)
        .run();
      return { id, organizationId, provider, status: "requested", requestedResourceClass, repositoryId, createdAt: ts };
    },

    async getRunner(id) {
      const row = await db.prepare(`SELECT * FROM runners WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return row ? rowToRunner(row) : null;
    },

    async getRunnerForOrganization(id, organizationId) {
      const row = await db.prepare(`SELECT * FROM runners WHERE id = ? AND organization_id = ?`).bind(id, organizationId).first<Record<string, unknown>>();
      return row ? rowToRunner(row) : null;
    },

    async listRunnersForOrganization(organizationId, limit = 50) {
      const { results } = await db.prepare(`SELECT * FROM runners WHERE organization_id = ? ORDER BY created_at DESC LIMIT ?`).bind(organizationId, limit).all<Record<string, unknown>>();
      return results.map(rowToRunner);
    },

    async setProviderRunnerId(id, providerRunnerId) {
      await db.prepare(`UPDATE runners SET provider_runner_id = ? WHERE id = ?`).bind(providerRunnerId, id).run();
    },

    async transitionRunnerStatus(id, to, extra) {
      const current = await db.prepare(`SELECT * FROM runners WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      if (!current) throw new Error(`Runner ${id} not found`);
      const from = current.status as RunnerState;
      assertValidTransition(from, to); // throws BEFORE any write on an illegal transition

      const ts = nowIso();
      const timestampColumn: Partial<Record<RunnerState, string>> = { ready: "ready_at", assigned: "started_at", completed: "completed_at", terminated: "terminated_at" };
      const col = timestampColumn[to];

      const setClauses = [
        "status = ?",
        ...(col ? [`${col} = ?`] : []),
        ...(extra?.runtimeSeconds !== undefined ? ["runtime_seconds = ?"] : []),
        ...(extra?.costEstimateUsd !== undefined ? ["cost_estimate_usd = ?"] : []),
        ...(extra?.costBasis !== undefined ? ["cost_basis = ?"] : []),
        ...(extra?.failureReason !== undefined ? ["failure_reason = ?"] : []),
      ];
      const values = [
        to,
        ...(col ? [ts] : []),
        ...(extra?.runtimeSeconds !== undefined ? [extra.runtimeSeconds] : []),
        ...(extra?.costEstimateUsd !== undefined ? [extra.costEstimateUsd] : []),
        ...(extra?.costBasis !== undefined ? [extra.costBasis] : []),
        ...(extra?.failureReason !== undefined ? [extra.failureReason] : []),
      ];

      await db
        .prepare(`UPDATE runners SET ${setClauses.join(", ")} WHERE id = ?`)
        .bind(...values, id)
        .run();

      const updated = await db.prepare(`SELECT * FROM runners WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return rowToRunner(updated!);
    },

    async assignJob(id, jobId) {
      await db.prepare(`UPDATE runners SET assigned_job_id = ? WHERE id = ?`).bind(jobId, id).run();
    },

    async findStaleRunners(olderThanIso, statuses) {
      if (statuses.length === 0) return [];
      const placeholders = statuses.map(() => "?").join(",");
      const { results } = await db
        .prepare(`SELECT * FROM runners WHERE created_at < ? AND status IN (${placeholders})`)
        .bind(olderThanIso, ...statuses)
        .all<Record<string, unknown>>();
      return results.map(rowToRunner);
    },

    async recordHeartbeat(id) {
      await db.prepare(`UPDATE runners SET last_heartbeat_at = ? WHERE id = ?`).bind(nowIso(), id).run();
    },
  };
}
