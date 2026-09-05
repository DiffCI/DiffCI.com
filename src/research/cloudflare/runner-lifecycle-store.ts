/**
 * D1 persistence for runner_job_lifecycle / runner_job_events
 * (schema-migration-2026-09-05-runner-job-lifecycle.sql). One row per GitHub job, updated stage by
 * stage, plus an append-only event trail. Same hand-rolled D1Binding idiom as shadow-store.ts.
 */
import type { LifecycleView, RunnerDisposition, RunnerLifecycleStage } from "./runner-dispatch.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface RunnerLifecycleRow {
  jobId: number;
  repository: string;
  installationId: number;
  workflowRunId?: number;
  workflowName?: string;
  jobName?: string;
  labels: string[];
  pinned: boolean;
  queuedAt?: string;
  dispatchRequestedAt?: string;
  dispatchSource?: string;
  dispatchAttempts: number;
  tokenMintedAt?: string;
  containerStartedAt?: string;
  runnerName?: string;
  assignedAt?: string;
  assignedRunnerName?: string;
  executionCompletedAt?: string;
  conclusion?: string;
  disposition?: string;
  dispositionAt?: string;
  error?: string;
  updatedAt: string;
}

export interface RunnerLifecycleStore {
  /** Creates the row on first sight of a job (any stage), never overwrites what is already known. */
  ensureJob(input: { jobId: number; repository: string; installationId: number; workflowRunId?: number; workflowName?: string; jobName?: string; labels: string[]; pinned: boolean; at: string }): Promise<void>;
  recordQueued(jobId: number, at: string): Promise<void>;
  recordDispatchRequested(jobId: number, source: "webhook" | "reconcile", at: string): Promise<void>;
  recordDispatchStarted(jobId: number, at: string): Promise<{ attempts: number }>;
  recordTokenMinted(jobId: number, at: string): Promise<void>;
  recordContainerStarted(jobId: number, runnerName: string, at: string): Promise<void>;
  recordAssigned(jobId: number, runnerName: string | undefined, at: string): Promise<void>;
  recordCompleted(jobId: number, conclusion: string | undefined, at: string): Promise<void>;
  recordDisposition(jobId: number, disposition: RunnerDisposition, error: string | undefined, at: string): Promise<void>;
  appendEvent(jobId: number, repository: string, stage: RunnerLifecycleStage, detail: string | undefined, at: string): Promise<void>;
  get(jobId: number): Promise<RunnerLifecycleRow | undefined>;
  /** Lifecycle views for a set of job ids (the reconciler's input). */
  viewsFor(jobIds: readonly number[]): Promise<Map<number, LifecycleView>>;
  listRecent(repository: string | undefined, limit: number): Promise<RunnerLifecycleRow[]>;
  listEvents(jobId: number): Promise<{ at: string; stage: string; detail?: string }[]>;
  /** Dispatches started within the window that have no disposition yet - in-flight containers. */
  countInFlight(sinceIso: string): Promise<number>;
  /** Distinct (repository, installation) pairs this store has ever seen - the reconciler's scope. */
  listRepositories(): Promise<{ repository: string; installationId: number }[]>;
}

function rowFrom(r: Record<string, unknown>): RunnerLifecycleRow {
  let labels: string[] = [];
  try {
    const p = JSON.parse(String(r.labels ?? "[]")) as unknown;
    labels = Array.isArray(p) ? p.filter((x): x is string => typeof x === "string") : [];
  } catch {
    labels = [];
  }
  const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
  return {
    jobId: r.job_id as number,
    repository: r.repository as string,
    installationId: r.installation_id as number,
    workflowRunId: typeof r.workflow_run_id === "number" ? r.workflow_run_id : undefined,
    workflowName: s("workflow_name"),
    jobName: s("job_name"),
    labels,
    pinned: r.pinned === 1,
    queuedAt: s("queued_at"),
    dispatchRequestedAt: s("dispatch_requested_at"),
    dispatchSource: s("dispatch_source"),
    dispatchAttempts: (r.dispatch_attempts as number) ?? 0,
    tokenMintedAt: s("token_minted_at"),
    containerStartedAt: s("container_started_at"),
    runnerName: s("runner_name"),
    assignedAt: s("assigned_at"),
    assignedRunnerName: s("assigned_runner_name"),
    executionCompletedAt: s("execution_completed_at"),
    conclusion: s("conclusion"),
    disposition: s("disposition"),
    dispositionAt: s("disposition_at"),
    error: s("error"),
    updatedAt: r.updated_at as string,
  };
}

export function makeD1RunnerLifecycleStore(db: D1Binding): RunnerLifecycleStore {
  const update = async (jobId: number, setClause: string, values: unknown[], at: string) => {
    await db.prepare(`UPDATE runner_job_lifecycle SET ${setClause}, updated_at = ? WHERE job_id = ?`).bind(...values, at, jobId).run();
  };
  return {
    async ensureJob(input) {
      await db
        .prepare(
          `INSERT INTO runner_job_lifecycle (job_id, repository, installation_id, workflow_run_id, workflow_name, job_name, labels, pinned, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(job_id) DO UPDATE SET
             workflow_run_id = COALESCE(runner_job_lifecycle.workflow_run_id, excluded.workflow_run_id),
             workflow_name = COALESCE(runner_job_lifecycle.workflow_name, excluded.workflow_name),
             job_name = COALESCE(runner_job_lifecycle.job_name, excluded.job_name),
             labels = CASE WHEN runner_job_lifecycle.labels = '[]' THEN excluded.labels ELSE runner_job_lifecycle.labels END,
             pinned = MAX(runner_job_lifecycle.pinned, excluded.pinned),
             updated_at = excluded.updated_at`,
        )
        .bind(input.jobId, input.repository, input.installationId, input.workflowRunId ?? null, input.workflowName ?? null, input.jobName ?? null, JSON.stringify(input.labels), input.pinned ? 1 : 0, input.at)
        .run();
    },
    async recordQueued(jobId, at) {
      await update(jobId, `queued_at = COALESCE(queued_at, ?)`, [at], at);
    },
    async recordDispatchRequested(jobId, source, at) {
      await update(jobId, `dispatch_requested_at = ?, dispatch_source = ?`, [at, source], at);
    },
    async recordDispatchStarted(jobId, at) {
      await update(jobId, `dispatch_attempts = dispatch_attempts + 1, disposition = NULL, disposition_at = NULL, error = NULL`, [], at);
      const row = await db.prepare(`SELECT dispatch_attempts FROM runner_job_lifecycle WHERE job_id = ?`).bind(jobId).first<{ dispatch_attempts: number }>();
      return { attempts: row?.dispatch_attempts ?? 0 };
    },
    async recordTokenMinted(jobId, at) {
      await update(jobId, `token_minted_at = ?`, [at], at);
    },
    async recordContainerStarted(jobId, runnerName, at) {
      await update(jobId, `container_started_at = ?, runner_name = ?`, [at, runnerName], at);
    },
    async recordAssigned(jobId, runnerName, at) {
      await update(jobId, `assigned_at = COALESCE(assigned_at, ?), assigned_runner_name = COALESCE(assigned_runner_name, ?)`, [at, runnerName ?? null], at);
    },
    async recordCompleted(jobId, conclusion, at) {
      await update(jobId, `execution_completed_at = COALESCE(execution_completed_at, ?), conclusion = COALESCE(?, conclusion)`, [at, conclusion ?? null], at);
    },
    async recordDisposition(jobId, disposition, error, at) {
      await update(jobId, `disposition = ?, disposition_at = ?, error = ?`, [disposition, at, error ?? null], at);
    },
    async appendEvent(jobId, repository, stage, detail, at) {
      await db.prepare(`INSERT INTO runner_job_events (job_id, repository, at, stage, detail) VALUES (?, ?, ?, ?, ?)`).bind(jobId, repository, at, stage, detail ?? null).run();
    },
    async get(jobId) {
      const row = await db.prepare(`SELECT * FROM runner_job_lifecycle WHERE job_id = ?`).bind(jobId).first<Record<string, unknown>>();
      return row ? rowFrom(row) : undefined;
    },
    async viewsFor(jobIds) {
      const out = new Map<number, LifecycleView>();
      if (jobIds.length === 0) return out;
      const placeholders = jobIds.map(() => "?").join(",");
      const { results } = await db
        .prepare(`SELECT job_id, dispatch_requested_at, container_started_at, assigned_at, execution_completed_at, disposition, dispatch_attempts FROM runner_job_lifecycle WHERE job_id IN (${placeholders})`)
        .bind(...jobIds)
        .all<Record<string, unknown>>();
      for (const r of results) {
        const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
        out.set(r.job_id as number, {
          jobId: r.job_id as number,
          dispatchRequestedAt: s("dispatch_requested_at"),
          containerStartedAt: s("container_started_at"),
          assignedAt: s("assigned_at"),
          executionCompletedAt: s("execution_completed_at"),
          disposition: s("disposition"),
          dispatchAttempts: (r.dispatch_attempts as number) ?? 0,
        });
      }
      return out;
    },
    async listRecent(repository, limit) {
      const { results } = repository
        ? await db.prepare(`SELECT * FROM runner_job_lifecycle WHERE repository = ? ORDER BY updated_at DESC LIMIT ?`).bind(repository, limit).all<Record<string, unknown>>()
        : await db.prepare(`SELECT * FROM runner_job_lifecycle ORDER BY updated_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
      return results.map(rowFrom);
    },
    async listEvents(jobId) {
      const { results } = await db.prepare(`SELECT at, stage, detail FROM runner_job_events WHERE job_id = ? ORDER BY id ASC`).bind(jobId).all<{ at: string; stage: string; detail: string | null }>();
      return results.map((e) => ({ at: e.at, stage: e.stage, detail: e.detail ?? undefined }));
    },
    async countInFlight(sinceIso) {
      const row = await db
        .prepare(`SELECT COUNT(*) AS n FROM runner_job_lifecycle WHERE container_started_at >= ? AND disposition IS NULL`)
        .bind(sinceIso)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },
    async listRepositories() {
      const { results } = await db.prepare(`SELECT repository, MAX(installation_id) AS installation_id FROM runner_job_lifecycle GROUP BY repository`).bind().all<{ repository: string; installation_id: number }>();
      return results.map((r) => ({ repository: r.repository, installationId: r.installation_id }));
    },
  };
}
