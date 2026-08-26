/**
 * D1 persistence for Stage 2 shadow predictions/ground-truth
 * (schema-migration-2026-08-21-stage2-shadow.sql). Mirrors the idiom already established for Stage 0/1's
 * completed_deltas (resumable-batch.ts, makeD1ResumabilityAdapter in validation-worker.ts): D1 is the
 * fast/queryable index, R2 (via the caller-supplied EvidenceStore) is evidence-of-record for the full
 * payload. INSERT ... ON CONFLICT DO NOTHING everywhere for idempotency, matching the same precedent.
 */

import type { RepositoryLivenessUpdate } from "./shadow-cron.js";

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
  /** The exact DiffCI git commit that produced this prediction (schema-migration-2026-08-21-shadow-
   * source-integrity.sql) - undefined/omitted means genuinely unknown (stored as NULL), never guessed.
   * Populated from the verified R2 source archive's sourceSha for cron/webhook-triggered polls; may be
   * absent for an ad-hoc POST /v1/shadow/poll caller that didn't supply one. */
  engineSourceSha?: string;
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
  /** engine_source_sha of this repository's most recently recorded prediction - undefined when that
   * prediction predates the source-integrity fix (or came from a caller that didn't supply one), which
   * is reported as absent, never guessed at. */
  latestEngineSourceSha?: string;
  /** Task 2 (2026-08-21) §8 fix: the relevantFailures.../failuresPreserved... fields above are summed
   * across EVERY reconciled prediction regardless of opportunity_category, which trivially inflates
   * apparent safety -
   * a MANDATORY_FALLBACK prediction ran the FULL suite, so it preserves 100% of failures by construction,
   * not because selective skipping worked. These four fields are the SAME metrics scoped to
   * opportunity_category = 'DISCRIMINATIVE_OPPORTUNITY' only - the only category where DiffCI's selective
   * plan actually excluded anything a real failure could have hidden behind, and therefore the only
   * category where "did DiffCI preserve real failures" is a meaningful safety claim. */
  discriminativeRelevantFailuresObserved: number;
  discriminativeRelevantFailuresEvaluable: number;
  discriminativeFailuresPreservedByDiffci: number;
  discriminativeFailuresPreservedByPath: number;
}

export interface PollableRepositoryRow {
  repository: string;
  state: ShadowRepositoryState;
  language: string;
  lastPolledSha?: string;
  lastPolledAt?: string;
}

export interface PendingReasonBreakdown {
  reason: string; // "not_yet_attempted" for a prediction with no reconcile attempt recorded yet, else a pendingReason value
  count: number;
}

export interface StuckPendingPrediction {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  predictionCreatedAt: string;
  ageMs: number;
  lastReconcileAttemptedAt?: string;
  lastReconcileReason?: string;
}

export interface ReconcileDiagnostics {
  total: number;
  reconciled: number;
  pending: number;
  /** Always 0 today - nothing in this codebase ever auto-terminalizes a pending prediction (Task 2 §11:
   * age alone must never convert a normal delay into a failure). Reported explicitly, not omitted, so a
   * future terminal-state feature has an obvious existing field to populate rather than inventing a new
   * response shape. */
  terminalUnevaluable: number;
  pendingReasons: PendingReasonBreakdown[];
  oldestPendingAgeMs?: number;
  /** Pending predictions older than the stuck threshold - a diagnostic label computed at read time, never
   * persisted as a state transition (see terminalUnevaluable's comment). */
  stuck: StuckPendingPrediction[];
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
  /** What computeSourceIntegrity() found before this run attempted to poll, or undefined when the run
   * never reached a poll attempt (nothing needed polling this cycle). */
  sourceIntegrityStatus?: string;
}

export interface ShadowStore {
  /** Analysis launches recorded since an instant - the daily-ceiling counter. Counts entries across each
   * run's repos_polled array, so it measures real container launches rather than sweeps. */
  countPollsSince(sinceIso: string): Promise<number>;
  /** M3.2 liveness facts for the repositories examined in one sweep. */
  recordRepositoryLiveness(updates: RepositoryLivenessUpdate[]): Promise<void>;
  /** Idempotent - does nothing if the repository is already enrolled. `language` only applies to the
   * initial enrollment insert; it never overwrites an existing row's value. */
  ensureRepository(repository: string, observationSource: ObservationSource, language?: string): Promise<void>;
  getRepositoryPollState(repository: string): Promise<{ state: ShadowRepositoryState; lastPolledSha?: string; language: string } | undefined>;
  /** Repositories the cron runner may poll: observation_source = 'cloudflare-poll' in a pollable state,
   * never-polled first, then oldest-polled first. */
  listPollableRepositories(): Promise<PollableRepositoryRow[]>;
  /** Repositories whose pending predictions the cron sweep may reconcile: any observation source, any
   * pollable/active state - webhook-enrolled repositories reconcile event-driven (workflow_run), but the
   * cron sweep is the safety net for missed deliveries. */
  listReconcilableRepositories(): Promise<PollableRepositoryRow[]>;
  setInstallationId(repository: string, installationId: string): Promise<void>;
  getInstallationId(repository: string): Promise<string | undefined>;
  recordCronRun(input: CronRunInput): Promise<void>;
  listRecentCronRuns(limit: number): Promise<unknown[]>;
  updateLastPolled(repository: string, sha: string): Promise<void>;
  setRepositoryState(repository: string, state: ShadowRepositoryState): Promise<void>;
  recordPrediction(input: RecordPredictionInput, r2EvidenceKey: string): Promise<{ inserted: boolean }>;
  recordGroundTruth(input: RecordGroundTruthInput, r2EvidenceKey: string): Promise<{ inserted: boolean }>;
  /** Predictions with no corresponding shadow_ground_truth row yet, oldest first, capped at `limit`. */
  findPendingPredictions(repository: string, limit: number): Promise<PendingPredictionRow[]>;
  getRepositorySummary(repository: string): Promise<RepositorySummaryRow | undefined>;
  /** Called after EVERY reconciliation attempt that returns STILL_PENDING (never for RECONCILED - see
   * the migration file's comment on why that's fine). Never throws in a way that should fail the
   * reconcile attempt itself - callers should treat this as best-effort telemetry, same posture as
   * recordCronRun's telemetry-write-failure handling. */
  recordReconcileAttempt(logicalDeltaKey: string, reason: string | undefined, attemptedAt: string): Promise<void>;
  /** Task 2 (2026-08-21) reconciliation observability - GET /v1/shadow/reconcile-diagnostics. `repository`
   * omitted means "across every enrolled repository". `nowIso`/`stuckThresholdMs` are caller-supplied
   * (not `new Date()` internally) so this stays testable against a real SQLite fixture with fixed clocks. */
  getReconcileDiagnostics(options: { repository?: string; nowIso: string; stuckThresholdMs: number; stuckLimit: number }): Promise<ReconcileDiagnostics>;
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

    /** M3.2 liveness. Advances last_head_check_at for EVERY repository examined this sweep - including
     * one skipped for an unchanged head, because a skip proves the poller ran. That is precisely the fact
     * last_polled_at could not express, and reading last_polled_at as a liveness clock is what produced
     * the 2026-08-26 "five-day outage" that never happened. last_head_changed_at moves only when the
     * upstream head genuinely differs; the error counters reset to 0 on success so they mean
     * "consecutive", never "ever". */
    async countPollsSince(sinceIso: string) {
      const row = await db
        .prepare(`SELECT COALESCE(SUM(json_array_length(repos_polled)), 0) as n FROM shadow_cron_runs WHERE started_at >= ?`)
        .bind(sinceIso)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async recordRepositoryLiveness(updates: RepositoryLivenessUpdate[]) {
      for (const u of updates) {
        const sets: string[] = ["last_head_check_at = ?"];
        const binds: unknown[] = [u.headCheckAt];
        if (u.observedHeadSha) {
          sets.push("last_observed_head_sha = ?");
          binds.push(u.observedHeadSha);
        }
        if (u.headChanged) {
          sets.push("last_head_changed_at = ?");
          binds.push(u.headCheckAt);
        }
        if (u.pollAttempted) {
          sets.push("last_poll_attempt_at = ?");
          binds.push(u.headCheckAt);
        }
        if (u.pollSucceeded) {
          sets.push("last_poll_success_at = ?");
          binds.push(u.headCheckAt);
        }
        sets.push(`consecutive_head_check_errors = ${u.headCheckFailed ? "consecutive_head_check_errors + 1" : "0"}`);
        if (u.pollAttempted) sets.push(`consecutive_poll_errors = ${u.pollSucceeded ? "0" : "consecutive_poll_errors + 1"}`);
        binds.push(u.repository);
        await db.prepare(`UPDATE shadow_repositories SET ${sets.join(", ")} WHERE repository = ?`).bind(...binds).run();
      }
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

    async listReconcilableRepositories() {
      const { results } = await db
        .prepare(
          `SELECT repository, state, language, last_polled_sha, last_polled_at FROM shadow_repositories
           WHERE state IN ('VALIDATING', 'SHADOW_ACTIVE', 'SHADOW_LIMITED')
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

    async setInstallationId(repository, installationId) {
      await db.prepare(`UPDATE shadow_repositories SET installation_id = ? WHERE repository = ?`).bind(installationId, repository).run();
    },

    async getInstallationId(repository) {
      const row = await db.prepare(`SELECT installation_id FROM shadow_repositories WHERE repository = ?`).bind(repository).first<{ installation_id: string | null }>();
      return row?.installation_id ?? undefined;
    },

    async recordCronRun(input) {
      await db
        .prepare(
          `INSERT INTO shadow_cron_runs (
             started_at, finished_at, trigger_source, repos_considered, head_checks_skipped, repos_polled,
             predictions_recorded, repos_reconciled, ground_truth_reconciled, still_pending, errors,
             source_integrity_status
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          input.startedAt, input.finishedAt, input.trigger, input.reposConsidered, input.headChecksSkipped,
          JSON.stringify(input.reposPolled), input.predictionsRecorded, input.reposReconciled,
          input.groundTruthReconciled, input.stillPending, JSON.stringify(input.errors),
          input.sourceIntegrityStatus ?? null,
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
        .prepare(`SELECT state, last_polled_sha, language FROM shadow_repositories WHERE repository = ?`)
        .bind(repository)
        .first<{ state: ShadowRepositoryState; last_polled_sha: string | null; language: string }>();
      if (!row) return undefined;
      return { state: row.state, lastPolledSha: row.last_polled_sha ?? undefined, language: row.language };
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
             diffci_analysis_overhead_ms, r2_evidence_key, prediction_created_at, created_at,
             engine_source_sha
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(logical_delta_key) DO NOTHING`,
        )
        .bind(
          input.logicalDeltaKey, input.repository, input.baseSha, input.headSha, input.diffciAnalysisVersion,
          input.graphVersion, input.shadowSchemaVersion, input.observationSource, input.planMode,
          input.fallback ? 1 : 0, input.effectiveGraphConfidence, input.opportunityCategory,
          input.testsSelectedDiffci, input.testsSelectedPath, input.testsTotalFull,
          input.diffciAnalysisOverheadMs, r2EvidenceKey, input.predictionCreatedAt, now,
          input.engineSourceSha ?? null,
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

      // Separate query, not folded into predictionCounts' aggregate above: MAX(created_at) doesn't
      // reliably give you ITS ROW's engine_source_sha in portable SQL (SQLite's "bare column" leniency
      // isn't something to rely on), and this is cheap - one indexed row lookup.
      const latest = await db
        .prepare(`SELECT engine_source_sha FROM shadow_predictions WHERE repository = ? ORDER BY created_at DESC LIMIT 1`)
        .bind(repository)
        .first<{ engine_source_sha: string | null }>();

      // §8 fix: same failure-recall aggregate as groundTruthCounts above, but joined to shadow_predictions
      // and filtered to opportunity_category = 'DISCRIMINATIVE_OPPORTUNITY' - see RepositorySummaryRow's
      // doc comment on why the unfiltered numbers alone would overstate DiffCI's selective safety.
      const discriminativeCounts = await db
        .prepare(
          `SELECT
             SUM(g.relevant_failures_observed) AS relevant_failures_observed,
             SUM(g.relevant_failures_evaluable) AS relevant_failures_evaluable,
             SUM(g.failures_preserved_by_diffci) AS failures_preserved_by_diffci,
             SUM(g.failures_preserved_by_path) AS failures_preserved_by_path
           FROM shadow_ground_truth g
           JOIN shadow_predictions p ON p.logical_delta_key = g.logical_delta_key
           WHERE g.repository = ? AND p.opportunity_category = 'DISCRIMINATIVE_OPPORTUNITY'`,
        )
        .bind(repository)
        .first<{
          relevant_failures_observed: number | null; relevant_failures_evaluable: number | null;
          failures_preserved_by_diffci: number | null; failures_preserved_by_path: number | null;
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
        latestEngineSourceSha: latest?.engine_source_sha ?? undefined,
        discriminativeRelevantFailuresObserved: discriminativeCounts?.relevant_failures_observed ?? 0,
        discriminativeRelevantFailuresEvaluable: discriminativeCounts?.relevant_failures_evaluable ?? 0,
        discriminativeFailuresPreservedByDiffci: discriminativeCounts?.failures_preserved_by_diffci ?? 0,
        discriminativeFailuresPreservedByPath: discriminativeCounts?.failures_preserved_by_path ?? 0,
      };
    },

    async recordReconcileAttempt(logicalDeltaKey, reason, attemptedAt) {
      await db
        .prepare(`UPDATE shadow_predictions SET last_reconcile_attempted_at = ?, last_reconcile_reason = ? WHERE logical_delta_key = ?`)
        .bind(attemptedAt, reason ?? null, logicalDeltaKey)
        .run();
    },

    async getReconcileDiagnostics({ repository, nowIso, stuckThresholdMs, stuckLimit }) {
      const repoFilter = repository ? `AND p.repository = ?` : "";
      const bindArgs = repository ? [repository] : [];

      const totals = await db
        .prepare(
          `SELECT
             COUNT(*) AS total,
             SUM(CASE WHEN g.logical_delta_key IS NOT NULL THEN 1 ELSE 0 END) AS reconciled
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE 1=1 ${repoFilter}`,
        )
        .bind(...bindArgs)
        .first<{ total: number; reconciled: number | null }>();

      const reasonRows = await db
        .prepare(
          `SELECT COALESCE(p.last_reconcile_reason, 'not_yet_attempted') AS reason, COUNT(*) AS count
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE g.logical_delta_key IS NULL ${repoFilter}
           GROUP BY reason
           ORDER BY count DESC`,
        )
        .bind(...bindArgs)
        .all<{ reason: string; count: number }>();

      const pendingRows = await db
        .prepare(
          `SELECT p.logical_delta_key, p.repository, p.head_sha, p.prediction_created_at,
                  p.last_reconcile_attempted_at, p.last_reconcile_reason
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE g.logical_delta_key IS NULL ${repoFilter}
           ORDER BY p.prediction_created_at ASC`,
        )
        .bind(...bindArgs)
        .all<{
          logical_delta_key: string; repository: string; head_sha: string; prediction_created_at: string;
          last_reconcile_attempted_at: string | null; last_reconcile_reason: string | null;
        }>();

      const nowMs = Date.parse(nowIso);
      const allPending = pendingRows.results.map((r) => ({
        logicalDeltaKey: r.logical_delta_key,
        repository: r.repository,
        headSha: r.head_sha,
        predictionCreatedAt: r.prediction_created_at,
        ageMs: Math.max(0, nowMs - Date.parse(r.prediction_created_at)),
        lastReconcileAttemptedAt: r.last_reconcile_attempted_at ?? undefined,
        lastReconcileReason: r.last_reconcile_reason ?? undefined,
      }));

      return {
        total: totals?.total ?? 0,
        reconciled: totals?.reconciled ?? 0,
        pending: allPending.length,
        terminalUnevaluable: 0,
        pendingReasons: reasonRows.results.map((r) => ({ reason: r.reason, count: r.count })),
        oldestPendingAgeMs: allPending.length > 0 ? Math.max(...allPending.map((p) => p.ageMs)) : undefined,
        stuck: allPending
          .filter((p) => p.ageMs >= stuckThresholdMs)
          .sort((a, b) => b.ageMs - a.ageMs)
          .slice(0, stuckLimit),
      };
    },
  };
}
