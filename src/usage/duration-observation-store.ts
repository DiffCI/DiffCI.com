/**
 * D1 persistence for ci_duration_observations (see src/usage/cloudflare/schema.sql for the full
 * rationale). Same idempotency idiom as src/usage/store.ts's usage_events: INSERT OR IGNORE keyed on a
 * UNIQUE/PRIMARY KEY identity, so a capture sweep that re-observes the same commit twice (retried sweep,
 * overlapping cron runs) can only ever produce one row for it.
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

export interface DurationObservation {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  /** Real GitHub Actions workflow_run ids this observation was derived from (audit provenance) - never
   * raw log content, just identity. Empty when the underlying evidence didn't carry one (defensive; in
   * practice fetchBaselineEvidence always returns at least one run for a COMPLETE result). */
  workflowRunIds: number[];
  jobIds: number[];
  testsTotalFull: number;
  realJobDurationMs: number;
  secondsPerTest: number;
  observedAt: string;
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

function rowToObservation(row: Record<string, unknown>): DurationObservation {
  return {
    logicalDeltaKey: row.logical_delta_key as string,
    repository: row.repository as string,
    headSha: row.head_sha as string,
    workflowRunIds: parseIdArray(row.workflow_run_ids),
    jobIds: parseIdArray(row.job_ids),
    testsTotalFull: row.tests_total_full as number,
    realJobDurationMs: row.real_job_duration_ms as number,
    secondsPerTest: row.seconds_per_test as number,
    observedAt: row.observed_at as string,
  };
}

export interface DurationObservationStore {
  /** Returns false if this exact logicalDeltaKey was already recorded (routine dedup, not an error). */
  recordIfNew(observation: DurationObservation): Promise<boolean>;
  /** Most recent observations, optionally scoped to one repository, newest first. */
  listRecent(repository: string | undefined, limit: number): Promise<DurationObservation[]>;
}

export function makeD1DurationObservationStore(db: D1Binding): DurationObservationStore {
  return {
    async recordIfNew(observation) {
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO ci_duration_observations
             (logical_delta_key, repository, head_sha, workflow_run_ids, job_ids, tests_total_full, real_job_duration_ms, seconds_per_test, observed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          observation.logicalDeltaKey,
          observation.repository,
          observation.headSha,
          JSON.stringify(observation.workflowRunIds),
          JSON.stringify(observation.jobIds),
          observation.testsTotalFull,
          observation.realJobDurationMs,
          observation.secondsPerTest,
          observation.observedAt,
        )
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async listRecent(repository, limit) {
      const { results } = repository
        ? await db
            .prepare(`SELECT * FROM ci_duration_observations WHERE repository = ? ORDER BY observed_at DESC LIMIT ?`)
            .bind(repository, limit)
            .all<Record<string, unknown>>()
        : await db.prepare(`SELECT * FROM ci_duration_observations ORDER BY observed_at DESC LIMIT ?`).bind(limit).all<Record<string, unknown>>();
      return results.map(rowToObservation);
    },
  };
}
