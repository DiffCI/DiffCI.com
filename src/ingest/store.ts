/**
 * Observation persistence (Phase 03, 2026-08-26).
 *
 * TENANCY IS A PREDICATE HERE, NOT A CONVENTION. Every read and every delete in this module takes
 * `organizationId` as its first argument and puts it in the SQL. Not because a caller could not be
 * trusted to filter afterwards, but because "the query returned nothing" is a safe failure and "the
 * caller forgot to filter" is not. tests/ingest/tenancy.test.ts reads this file's own SQL and fails if
 * a statement against `observations` lacks an organization_id predicate - so the property is checked by
 * a machine on every run, rather than by whoever reviews the next change.
 *
 * The two exceptions are named `unscoped`, take no organizationId, and exist for the retention sweep
 * that has to cross tenants by definition. Same discipline as ProductStore.listAllRepositories.
 */
import type { ObservationRecord } from "./types.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToRecord(row: Record<string, unknown>): ObservationRecord {
  const optionalString = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : (value as string));
  const optionalNumber = (value: unknown): number | undefined => (value === null || value === undefined ? undefined : Number(value));
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    repositoryId: row.repository_id as string,
    idempotencyKey: row.idempotency_key as string,
    schemaVersion: row.schema_version as string,
    status: row.status as ObservationRecord["status"],
    stage: row.stage as string,
    refusalReason: optionalString(row.refusal_reason),
    mode: optionalString(row.mode) as ObservationRecord["mode"],
    baseSha: optionalString(row.base_sha),
    headSha: optionalString(row.head_sha),
    rangeSource: optionalString(row.range_source),
    ciRunId: optionalString(row.ci_run_id),
    ciRunAttempt: optionalString(row.ci_run_attempt),
    ciEvent: optionalString(row.ci_event),
    ciWorkflow: optionalString(row.ci_workflow),
    ciJob: optionalString(row.ci_job),
    changedFileCount: optionalNumber(row.changed_file_count),
    selectedTestCount: optionalNumber(row.selected_test_count),
    totalTestCount: optionalNumber(row.total_test_count),
    baselineMode: optionalString(row.baseline_mode) as ObservationRecord["baselineMode"],
    baselineSelectedTestCount: optionalNumber(row.baseline_selected_test_count),
    blindSpot: Boolean(row.blind_spot),
    worktreeUnchanged: Boolean(row.worktree_unchanged),
    blockingWorkflowFindings: Number(row.blocking_workflow_findings ?? 0),
    pathsRedacted: Boolean(row.paths_redacted),
    identityVerified: Boolean(row.identity_verified),
    observerVersion: optionalString(row.observer_version),
    engineSha: optionalString(row.engine_sha),
    producedAt: row.produced_at as string,
    receivedAt: row.received_at as string,
    reportBytes: Number(row.report_bytes),
    report: JSON.parse(row.report_json as string) as unknown,
  };
}

/** Everything an insert needs. `id` and `receivedAt` are the server's to set, never the sender's. */
export type NewObservation = Omit<ObservationRecord, "id" | "receivedAt">;

export interface ObservationSummary {
  total: number;
  observed: number;
  refused: number;
  errored: number;
  selective: number;
  full: number;
  /** Observations whose own non-interference evidence says the checkout was left untouched. */
  worktreeUnchanged: number;
  distinctRepositories: number;
  firstReceivedAt?: string;
  lastReceivedAt?: string;
}

export interface ObservationStore {
  /**
   * Inserts unless this exact observation was already stored. Returns the existing row on a duplicate
   * rather than an error: a re-run, a client retry and a redelivered request are all routine, and each
   * must be counted exactly once. Idempotency is enforced by the UNIQUE constraint in the schema, not
   * by a read-then-write here, so two concurrent identical requests cannot both insert.
   */
  recordIfNew(input: NewObservation): Promise<{ record: ObservationRecord; duplicate: boolean }>;

  getForOrganization(organizationId: string, observationId: string): Promise<ObservationRecord | null>;
  listForOrganization(organizationId: string, options?: { limit?: number; since?: string }): Promise<ObservationRecord[]>;
  listForRepository(organizationId: string, repositoryId: string, options?: { limit?: number; since?: string }): Promise<ObservationRecord[]>;
  summarise(organizationId: string, options?: { since?: string }): Promise<ObservationSummary>;

  /** Erasure on request, scoped to one repository. Returns how many rows went. */
  deleteForRepository(organizationId: string, repositoryId: string): Promise<number>;
  /** Erasure on uninstall/account closure. Scoped to one organization by construction. */
  deleteForOrganization(organizationId: string): Promise<number>;

  /**
   * Retention sweep. Crosses tenants by definition - it enforces the published cap ("90 days maximum,
   * regardless") which is a promise about every row, not about one organization's rows. Named
   * `unscoped` so its absence of an organizationId reads as deliberate at every call site.
   */
  unscopedPurgeReceivedBefore(cutoffIso: string): Promise<number>;
  /** How many rows the sweep above would remove. Used to report retention health without deleting. */
  unscopedCountReceivedBefore(cutoffIso: string): Promise<number>;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;

function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export function makeD1ObservationStore(db: D1Binding): ObservationStore {
  return {
    async recordIfNew(input) {
      const id = crypto.randomUUID();
      const receivedAt = nowIso();
      const reportJson = JSON.stringify(input.report);
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO observations (
             id, organization_id, repository_id, idempotency_key, schema_version, status, stage,
             refusal_reason, mode, base_sha, head_sha, range_source, ci_run_id, ci_run_attempt, ci_event,
             ci_workflow, ci_job, changed_file_count, selected_test_count, total_test_count,
             baseline_mode, baseline_selected_test_count, blind_spot, worktree_unchanged,
             blocking_workflow_findings, paths_redacted, identity_verified, observer_version, engine_sha,
             produced_at, received_at, report_bytes, report_json
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.organizationId,
          input.repositoryId,
          input.idempotencyKey,
          input.schemaVersion,
          input.status,
          input.stage,
          input.refusalReason ?? null,
          input.mode ?? null,
          input.baseSha ?? null,
          input.headSha ?? null,
          input.rangeSource ?? null,
          input.ciRunId ?? null,
          input.ciRunAttempt ?? null,
          input.ciEvent ?? null,
          input.ciWorkflow ?? null,
          input.ciJob ?? null,
          input.changedFileCount ?? null,
          input.selectedTestCount ?? null,
          input.totalTestCount ?? null,
          input.baselineMode ?? null,
          input.baselineSelectedTestCount ?? null,
          input.blindSpot ? 1 : 0,
          input.worktreeUnchanged ? 1 : 0,
          input.blockingWorkflowFindings,
          input.pathsRedacted ? 1 : 0,
          input.identityVerified ? 1 : 0,
          input.observerVersion ?? null,
          input.engineSha ?? null,
          input.producedAt,
          receivedAt,
          input.reportBytes,
          reportJson,
        )
        .run();

      if ((result.meta?.changes ?? 0) > 0) {
        return { record: { ...input, id, receivedAt }, duplicate: false };
      }
      // Lost the insert (or repeated it): return what is actually stored, scoped to the organization
      // this credential belongs to. A key collision across organizations would return nothing here
      // rather than another tenant's row.
      const row = await db
        .prepare(`SELECT * FROM observations WHERE idempotency_key = ? AND organization_id = ?`)
        .bind(input.idempotencyKey, input.organizationId)
        .first<Record<string, unknown>>();
      if (!row) {
        throw new Error("observation insert was ignored but no existing row is visible to this organization");
      }
      return { record: rowToRecord(row), duplicate: true };
    },

    async getForOrganization(organizationId, observationId) {
      const row = await db
        .prepare(`SELECT * FROM observations WHERE id = ? AND organization_id = ?`)
        .bind(observationId, organizationId)
        .first<Record<string, unknown>>();
      return row ? rowToRecord(row) : null;
    },

    async listForOrganization(organizationId, options) {
      const { results } = await db
        .prepare(
          `SELECT * FROM observations WHERE organization_id = ? AND received_at >= ?
           ORDER BY received_at DESC LIMIT ?`,
        )
        .bind(organizationId, options?.since ?? "", clampLimit(options?.limit))
        .all<Record<string, unknown>>();
      return results.map(rowToRecord);
    },

    async listForRepository(organizationId, repositoryId, options) {
      const { results } = await db
        .prepare(
          `SELECT * FROM observations WHERE organization_id = ? AND repository_id = ? AND received_at >= ?
           ORDER BY received_at DESC LIMIT ?`,
        )
        .bind(organizationId, repositoryId, options?.since ?? "", clampLimit(options?.limit))
        .all<Record<string, unknown>>();
      return results.map(rowToRecord);
    },

    async summarise(organizationId, options) {
      const row = await db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN status = 'OBSERVED' THEN 1 ELSE 0 END) AS observed,
             SUM(CASE WHEN status = 'REFUSED' THEN 1 ELSE 0 END) AS refused,
             SUM(CASE WHEN status = 'ERROR' THEN 1 ELSE 0 END) AS errored,
             SUM(CASE WHEN mode = 'SELECTIVE' THEN 1 ELSE 0 END) AS selective,
             SUM(CASE WHEN mode = 'FULL' THEN 1 ELSE 0 END) AS full_runs,
             SUM(CASE WHEN worktree_unchanged = 1 THEN 1 ELSE 0 END) AS worktree_unchanged,
             COUNT(DISTINCT repository_id) AS distinct_repositories,
             MIN(received_at) AS first_received_at,
             MAX(received_at) AS last_received_at
           FROM observations WHERE organization_id = ? AND received_at >= ?`,
        )
        .bind(organizationId, options?.since ?? "")
        .first<Record<string, unknown>>();
      const number = (value: unknown): number => Number(value ?? 0);
      return {
        total: number(row?.total),
        observed: number(row?.observed),
        refused: number(row?.refused),
        errored: number(row?.errored),
        selective: number(row?.selective),
        full: number(row?.full_runs),
        worktreeUnchanged: number(row?.worktree_unchanged),
        distinctRepositories: number(row?.distinct_repositories),
        firstReceivedAt: (row?.first_received_at as string | null) ?? undefined,
        lastReceivedAt: (row?.last_received_at as string | null) ?? undefined,
      };
    },

    async deleteForRepository(organizationId, repositoryId) {
      const result = await db
        .prepare(`DELETE FROM observations WHERE organization_id = ? AND repository_id = ?`)
        .bind(organizationId, repositoryId)
        .run();
      return result.meta?.changes ?? 0;
    },

    async deleteForOrganization(organizationId) {
      const result = await db.prepare(`DELETE FROM observations WHERE organization_id = ?`).bind(organizationId).run();
      return result.meta?.changes ?? 0;
    },

    async unscopedPurgeReceivedBefore(cutoffIso) {
      const result = await db.prepare(`DELETE FROM observations WHERE received_at < ?`).bind(cutoffIso).run();
      return result.meta?.changes ?? 0;
    },

    async unscopedCountReceivedBefore(cutoffIso) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM observations WHERE received_at < ?`)
        .bind(cutoffIso)
        .first<Record<string, unknown>>();
      return Number(row?.n ?? 0);
    },
  };
}
