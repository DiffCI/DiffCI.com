/**
 * D1 persistence for Stage 2 shadow predictions/ground-truth
 * (schema-migration-2026-08-21-stage2-shadow.sql). Mirrors the idiom already established for Stage 0/1's
 * completed_deltas (resumable-batch.ts, makeD1ResumabilityAdapter in validation-worker.ts): D1 is the
 * fast/queryable index, R2 (via the caller-supplied EvidenceStore) is evidence-of-record for the full
 * payload. INSERT ... ON CONFLICT DO NOTHING everywhere for idempotency, matching the same precedent.
 */

// Duplicated minimal shape rather than exported from validation-worker.ts - keeps this module
// independently importable/testable without pulling in the whole Worker file.
export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface EvidenceStoreLike {
  put(key: string, value: unknown): Promise<void>;
  get(key: string): Promise<unknown>;
}

export type ShadowRepositoryState =
  | "INSTALLING" | "VALIDATING" | "SHADOW_ACTIVE" | "SHADOW_LIMITED"
  | "PAUSED" | "UNSUPPORTED" | "READY_FOR_ENFORCEMENT_REVIEW" | "REMOVED";

export type ObservationSource = "cloudflare-poll" | "github-actions-step" | "github-app-webhook";

export interface RecordPredictionInput {
  logicalDeltaKey: string;
  repository: string;
  baseSha: string;
  headSha: string;
  diffciAnalysisVersion: string;
  graphVersion: string;
  shadowSchemaVersion: string;
  observationSource: ObservationSource;
  planMode: "FULL" | "SELECTIVE";
  fallback: boolean;
  effectiveGraphConfidence: string;
  opportunityCategory: string;
  testsSelectedDiffci: number;
  testsSelectedPath: number;
  testsTotalFull: number;
  diffciAnalysisOverheadMs: number;
  predictionCreatedAt: string;
}

export interface RecordGroundTruthInput {
  logicalEventKey: string;
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  workflowRunId?: string;
  workflowRunAttempt: number;
  eventType: "push" | "pull_request" | "poll-detected";
  pullRequestNumber?: number;
  workflowConclusion?: string;
  workflowCompletedAt?: string;
  groundTruthStatus: "COMPLETE" | "PARTIAL" | "UNAVAILABLE";
  relevantFailuresObserved: number;
  relevantFailuresEvaluable: number;
  failuresPreservedByDiffci: number;
  failuresPreservedByPath: number;
  predictionPrecededGroundTruth: boolean;
  groundTruthFetchedAt: string;
}

export interface PendingPredictionRow {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  r2EvidenceKey: string;
  diffciAnalysisOverheadMs: number;
  predictionCreatedAt: string;
}

export interface RepositorySummaryRow {
  repository: string;
  state: ShadowRepositoryState;
  predictionsRecorded: number;
  groundTruthRecorded: number;
  reconciledComplete: number;
  relevantFailuresObserved: number;
  relevantFailuresEvaluable: number;
  failuresPreservedByDiffci: number;
  failuresPreservedByPath: number;
  discriminativeOpportunities: number;
  mandatoryFallbacks: number;
  baselineAlreadyOptimal: number;
}

export interface PollableRepositoryRow {
  repository: string;
  state: ShadowRepositoryState;
  language: string;
  lastPolledSha?: string;
  lastPolledAt?: string;
}

export interface CronRunInput {
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  reposConsidered: number;
  headChecksSkipped: number;
  reposPolled: string[];
  predictionsRecorded: number;
  reposReconciled: number;
  groundTruthReconciled: number;
  stillPending: number;
  errors: string[];
}

export interface ShadowStore {
  /** Idempotent - does nothing if the repository is already enrolled. `language` only applies to the
   * initial enrollment insert; it never overwrites an existing row's value. */
  ensureRepository(repository: string, observationSource: ObservationSource, language?: string): Promise<void>;
  getRepositoryPollState(repository: string): Promise<{ state: ShadowRepositoryState; lastPolledSha?: string } | undefined>;
  /** Repositories the cron runner may poll: observation_source = 'cloudflare-poll' in a pollable state,
   * never-polled first, then oldest-polled first. */
  listPollableRepositories(): Promise<PollableRepositoryRow[]>;
  recordCronRun(input: CronRunInput): Promise<void>;
  listRecentCronRuns(limit: number): Promise<unknown[]>;
  updateLastPolled(repository: string, sha: string): Promise<void>;
  setRepositoryState(repository: string, state: ShadowRepositoryState): Promise<void>;
  recordPrediction(input: RecordPredictionInput, r2EvidenceKey: string): Promise<{ inserted: boolean }>;
  recordGroundTruth(input: RecordGroundTruthInput, r2EvidenceKey: string): Promise<{ inserted: boolean }>;
  /** Predictions with no corresponding shadow_ground_truth row yet, oldest first, capped at `limit`. */
  findPendingPredictions(repository: string, limit: number): Promise<PendingPredictionRow[]>;
  getRepositorySummary(repository: string): Promise<RepositorySummaryRow | undefined>;
}

export function makeD1ShadowStore(db: D1Binding): ShadowStore {
  return {
    async ensureRepository(repository, observationSource, language = "typescript") {
      const now = new Date().toISOString();
      await db
        .prepare(`INSERT INTO shadow_repositories (repository, state, observation_source, enrolled_at, language) VALUES (?, 'VALIDATING', ?, ?, ?) ON CONFLICT(repository) DO NOTHING`)
        .bind(repository, observationSource, now, language)
        .run();
    },

    async listPollableRepositories() {
      const { results } = await db
        .prepare(
          `SELECT repository, state, language, last_polled_sha, last_polled_at FROM shadow_repositories
           WHERE observation_source = 'cloudflare-poll' AND state IN ('VALIDATING', 'SHADOW_ACTIVE', 'SHADOW_LIMITED')
           ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC, repository ASC`,
        )
        .bind()
        .all<{ repository: string; state: ShadowRepositoryState; language: string; last_polled_sha: string | null; last_polled_at: string | null }>();
      return results.map((r) => ({
        repository: r.repository,
        state: r.state,
        language: r.language,
        lastPolledSha: r.last_polled_sha ?? undefined,
        lastPolledAt: r.last_polled_at ?? undefined,
      }));
    },

    async recordCronRun(input) {
      await db
        .prepare(
          `INSERT INTO shadow_cron_runs (
             started_at, finished_at, trigger_source, repos_considered, head_checks_skipped, repos_polled,
             predictions_recorded, repos_reconciled, ground_truth_reconciled, still_pending, errors
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.startedAt, input.finishedAt, input.trigger, input.reposConsidered, input.headChecksSkipped,
          JSON.stringify(input.reposPolled), input.predictionsRecorded, input.reposReconciled,
          input.groundTruthReconciled, input.stillPending, JSON.stringify(input.errors),
        )
        .run();
    },

    async listRecentCronRuns(limit) {
      const { results } = await db
        .prepare(`SELECT * FROM shadow_cron_runs ORDER BY id DESC LIMIT ?`)
        .bind(Math.max(1, Math.min(100, limit)))
        .all();
      return results;
    },

    async getRepositoryPollState(repository) {
      const row = await db
        .prepare(`SELECT state, last_polled_sha FROM shadow_repositories WHERE repository = ?`)
        .bind(repository)
        .first<{ state: ShadowRepositoryState; last_polled_sha: string | null }>();
      if (!row) return undefined;
      return { state: row.state, lastPolledSha: row.last_polled_sha ?? undefined };
    },

    async updateLastPolled(repository, sha) {
      const now = new Date().toISOString();
      await db.prepare(`UPDATE shadow_repositories SET last_polled_sha = ?, last_polled_at = ? WHERE repository = ?`).bind(sha, now, repository).run();
    },

    async setRepositoryState(repository, state) {
      await db.prepare(`UPDATE shadow_repositories SET state = ? WHERE repository = ?`).bind(state, repository).run();
    },

    async recordPrediction(input, r2EvidenceKey) {
      const now = new Date().toISOString();
      const result = await db
        .prepare(
          `INSERT INTO shadow_predictions (
             logical_delta_key, repository, base_sha, head_sha, diffci_analysis_version, graph_version,
             shadow_schema_version, observation_source, plan_mode, fallback, effective_graph_confidence,
             opportunity_category, tests_selected_diffci, tests_selected_path, tests_total_full,
             diffci_analysis_overhead_ms, r2_evidence_key, prediction_created_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(logical_delta_key) DO NOTHING`,
        )
        .bind(
          input.logicalDeltaKey, input.repository, input.baseSha, input.headSha, input.diffciAnalysisVersion,
          input.graphVersion, input.shadowSchemaVersion, input.observationSource, input.planMode,
          input.fallback ? 1 : 0, input.effectiveGraphConfidence, input.opportunityCategory,
          input.testsSelectedDiffci, input.testsSelectedPath, input.testsTotalFull,
          input.diffciAnalysisOverheadMs, r2EvidenceKey, input.predictionCreatedAt, now,
        )
        .run();
      return { inserted: (result.meta?.changes ?? 0) > 0 };
    },

    async recordGroundTruth(input, r2EvidenceKey) {
      const now = new Date().toISOString();
      const result = await db
        .prepare(
          `INSERT INTO shadow_ground_truth (
             logical_event_key, logical_delta_key, repository, head_sha, workflow_run_id, workflow_run_attempt,
             event_type, pull_request_number, workflow_conclusion, workflow_completed_at, ground_truth_status,
             relevant_failures_observed, relevant_failures_evaluable, failures_preserved_by_diffci,
             failures_preserved_by_path, prediction_preceded_ground_truth, r2_evidence_key,
             ground_truth_fetched_at, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(logical_event_key) DO NOTHING`,
        )
        .bind(
          input.logicalEventKey, input.logicalDeltaKey, input.repository, input.headSha,
          input.workflowRunId ?? null, input.workflowRunAttempt, input.eventType, input.pullRequestNumber ?? null,
          input.workflowConclusion ?? null, input.workflowCompletedAt ?? null, input.groundTruthStatus,
          input.relevantFailuresObserved, input.relevantFailuresEvaluable, input.failuresPreservedByDiffci,
          input.failuresPreservedByPath, input.predictionPrecededGroundTruth ? 1 : 0, r2EvidenceKey,
          input.groundTruthFetchedAt, now,
        )
        .run();
      return { inserted: (result.meta?.changes ?? 0) > 0 };
    },

    async findPendingPredictions(repository, limit) {
      const { results } = await db
        .prepare(
          `SELECT p.logical_delta_key, p.repository, p.head_sha, p.r2_evidence_key, p.diffci_analysis_overhead_ms, p.prediction_created_at
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE p.repository = ? AND g.logical_delta_key IS NULL
           ORDER BY p.created_at ASC
           LIMIT ?`,
        )
        .bind(repository, limit)
        .all<{ logical_delta_key: string; repository: string; head_sha: string; r2_evidence_key: string; diffci_analysis_overhead_ms: number; prediction_created_at: string }>();
      return results.map((r) => ({
        logicalDeltaKey: r.logical_delta_key,
        repository: r.repository,
        headSha: r.head_sha,
        r2EvidenceKey: r.r2_evidence_key,
        diffciAnalysisOverheadMs: r.diffci_analysis_overhead_ms,
        predictionCreatedAt: r.prediction_created_at,
      }));
    },

    async getRepositorySummary(repository) {
      const repoRow = await db.prepare(`SELECT state FROM shadow_repositories WHERE repository = ?`).bind(repository).first<{ state: ShadowRepositoryState }>();
      if (!repoRow) return undefined;

      const predictionCounts = await db
        .prepare(
          `SELECT
             COUNT(*) AS predictions_recorded,
             SUM(CASE WHEN opportunity_category = 'DISCRIMINATIVE_OPPORTUNITY' THEN 1 ELSE 0 END) AS discriminative,
             SUM(CASE WHEN opportunity_category = 'MANDATORY_FALLBACK' THEN 1 ELSE 0 END) AS mandatory,
             SUM(CASE WHEN opportunity_category = 'BASELINE_ALREADY_OPTIMAL' THEN 1 ELSE 0 END) AS baseline_optimal
           FROM shadow_predictions WHERE repository = ?`,
        )
        .bind(repository)
        .first<{ predictions_recorded: number; discriminative: number; mandatory: number; baseline_optimal: number }>();

      const groundTruthCounts = await db
        .prepare(
          `SELECT
             COUNT(*) AS ground_truth_recorded,
             SUM(CASE WHEN ground_truth_status = 'COMPLETE' THEN 1 ELSE 0 END) AS reconciled_complete,
             SUM(relevant_failures_observed) AS relevant_failures_observed,
             SUM(relevant_failures_evaluable) AS relevant_failures_evaluable,
             SUM(failures_preserved_by_diffci) AS failures_preserved_by_diffci,
             SUM(failures_preserved_by_path) AS failures_preserved_by_path
           FROM shadow_ground_truth WHERE repository = ?`,
        )
        .bind(repository)
        .first<{
          ground_truth_recorded: number; reconciled_complete: number; relevant_failures_observed: number | null;
          relevant_failures_evaluable: number | null; failures_preserved_by_diffci: number | null; failures_preserved_by_path: number | null;
        }>();

      return {
        repository,
        state: repoRow.state,
        predictionsRecorded: predictionCounts?.predictions_recorded ?? 0,
        groundTruthRecorded: groundTruthCounts?.ground_truth_recorded ?? 0,
        reconciledComplete: groundTruthCounts?.reconciled_complete ?? 0,
        relevantFailuresObserved: groundTruthCounts?.relevant_failures_observed ?? 0,
        relevantFailuresEvaluable: groundTruthCounts?.relevant_failures_evaluable ?? 0,
        failuresPreservedByDiffci: groundTruthCounts?.failures_preserved_by_diffci ?? 0,
        failuresPreservedByPath: groundTruthCounts?.failures_preserved_by_path ?? 0,
        discriminativeOpportunities: predictionCounts?.discriminative ?? 0,
        mandatoryFallbacks: predictionCounts?.mandatory ?? 0,
        baselineAlreadyOptimal: predictionCounts?.baseline_optimal ?? 0,
      };
    },
  };
}
