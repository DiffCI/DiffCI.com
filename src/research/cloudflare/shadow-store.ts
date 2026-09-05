/**
 * D1 persistence for Stage 2 shadow predictions/ground-truth
 * (schema-migration-2026-08-21-stage2-shadow.sql). Mirrors the idiom already established for Stage 0/1's
 * completed_deltas (resumable-batch.ts, makeD1ResumabilityAdapter in validation-worker.ts): D1 is the
 * fast/queryable index, R2 (via the caller-supplied EvidenceStore) is evidence-of-record for the full
 * payload. INSERT ... ON CONFLICT DO NOTHING everywhere for idempotency, matching the same precedent.
 */

import type { RepositoryLivenessUpdate } from "./shadow-cron.js";
import type { PushPollKind, PushPollRecord } from "./shadow-push-poll.js";

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
  /** 2026-09-05 workflow identity: the evidence workflow file this row's run belongs to. When set the
   * row is stored as evidence_validity 'VERIFIED'; when absent, 'UNVERIFIED'. */
  evidenceWorkflowPath?: string;
}

export type GroundTruthValidity = "VERIFIED" | "UNVERIFIED" | "CONTAMINATED_WORKFLOW_IDENTITY";

export interface LaunchCaps {
  /** Launches one repository may consume per UTC day. */
  perRepositoryPerDay?: number;
  /** Launches all repositories of one observation source may consume per UTC day together. */
  perSourcePerDay?: Partial<Record<ObservationSource, number>>;
}

export type IdentificationStatus = "identified" | "verified" | "none_found" | "shape_mismatch" | "ineligible";

export interface RecordIdentificationInput {
  repository: string;
  status: IdentificationStatus;
  /** Present for identified/verified. */
  evidenceWorkflowPaths?: string[];
  stageClassificationJson?: string;
  derivationJson?: string;
  note?: string;
  workflowsTreeSha?: string;
  at: string;
}

export interface RepositoryIdentification {
  repository: string;
  state: ShadowRepositoryState;
  notes?: string;
  source?: "auto" | "explicit";
  evidenceWorkflowPaths?: string[];
  status?: IdentificationStatus;
  checkedAt?: string;
  note?: string;
  derivationJson?: string;
  workflowsTreeSha?: string;
}

/** Telemetry self-health invariants (2026-09-05). Every value is something the 2026-09-05 incident
 * review said a human should not have to discover by hand again. */
export interface ShadowSelfHealth {
  /** Pending predictions never attempted by the reconciler, and the oldest one's age. A large age with
   * a working cron was the two-week head-of-line block (F1). */
  neverAttemptedPredictions: number;
  oldestNeverAttemptedAgeMs?: number;
  /** Ground-truth rows with no evidence_validity label - only possible from a mixed-version window
   * between a schema migration and the Worker deploy that writes the column (19 rows on 2026-09-05). */
  unlabelledGroundTruthRows: number;
  /** Predictions whose ground truth is VERIFIED but which have no stage-economics row yet - the
   * step-3 sweep's backlog; growing without bound means the sweep is not running or cannot classify. */
  verifiedWithoutStageEconomics: number;
  /** Repositories in an observed state with no evidence workflow configured - reconciling nothing. */
  unconfiguredEvidenceRepositories: string[];
  /** Repositories in an observed state that have predictions but no VERIFIED ground truth at all. */
  observedWithoutVerifiedGroundTruth: string[];
}

export interface PendingPredictionRow {
  logicalDeltaKey: string;
  repository: string;
  headSha: string;
  r2EvidenceKey: string;
  diffciAnalysisOverheadMs: number;
  predictionCreatedAt: string;
  /** The most recent STILL_PENDING attempt BEFORE this one, as recorded by recordReconcileAttempt -
   * the prior observation that shadow-reconcile-terminal.ts needs (2026-09-05). Undefined = never attempted. */
  lastReconcileAttemptedAt?: string;
  lastReconcileReason?: string;
}

export interface RepositorySummaryRow {
  repository: string;
  state: ShadowRepositoryState;
  predictionsRecorded: number;
  /** Every ground-truth row, whatever its evidence_validity - the raw count. */
  groundTruthRecorded: number;
  /** Rows written (or re-labelled) as VERIFIED under workflow identity (2026-09-05). Every recall /
   * failure figure below is computed over these rows only; UNVERIFIED and CONTAMINATED rows are kept
   * but never counted. */
  groundTruthVerified: number;
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
  /** Predictions with a non-NULL reconcile_terminal_reason: ground truth provably cannot exist (today only
   * NO_MATCHING_WORKFLOW, decided by shadow-reconcile-terminal.ts on positive evidence, never age alone -
   * the Task 2 §11 rule stands). Excluded from `pending`; the prediction row itself is untouched. Reserved
   * as "always 0" on 2026-08-21 for exactly this feature; populated since 2026-09-05. */
  terminalUnevaluable: number;
  /** Breakdown of terminalUnevaluable by reconcile_terminal_reason. */
  terminalReasons: PendingReasonBreakdown[];
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
  /** Append-only head-transition log. Preserves the SEQUENCE of observed heads, which
   * last_observed_head_sha (overwritten state) cannot. */
  recordHeadTransition(t: { repository: string; fromSha?: string; toSha: string; detectedAt: string; analysed: boolean }): Promise<void>;
  /** Pauses a repository with a durable reason - explicit refusal, reversible by a data change. */
  pauseRepository(repository: string, reason: string): Promise<void>;
  /** Consecutive prior poll failures for a repository. */
  consecutivePollErrors(repository: string): Promise<number>;
  /** Atomically reserves one daily launch slot. Granted:false when the day's budget is spent, when the
   * repository has used its own daily cap, or when its observation source has used its share
   * (2026-09-05: one busy repository, or the research corpus as a whole, can no longer starve an
   * external installation). */
  reserveLaunchSlot(repository: string, maxPerDay: number, caps?: LaunchCaps): Promise<{ granted: boolean; slotNo?: number; refusedBy?: "day" | "repository" | "source" }>;
  /** Records how a reserved launch finished. Never frees the slot. */
  recordLaunchOutcome(slotNo: number, outcome: "succeeded" | "failed"): Promise<void>;
  /** M3.2 liveness facts for the repositories examined in one sweep. */
  recordRepositoryLiveness(updates: RepositoryLivenessUpdate[]): Promise<void>;
  /** Idempotent - does nothing if the repository is already enrolled. `language` only applies to the
   * initial enrollment insert; it never overwrites an existing row's value. */
  ensureRepository(repository: string, observationSource: ObservationSource, language?: string): Promise<void>;
  getRepositoryPollState(repository: string): Promise<{ state: ShadowRepositoryState; lastPolledSha?: string; language: string } | undefined>;
  /** 2026-09-05 workflow identity: the repository's explicitly configured evidence workflow file(s), or
   * undefined when nobody has identified one yet (then nothing may become ground truth). */
  getEvidenceWorkflowPaths(repository: string): Promise<string[] | undefined>;
  setEvidenceWorkflowPaths(repository: string, paths: string[]): Promise<{ changed: boolean }>;
  /** Re-labels an existing ground-truth row's validity (backfill / contamination marking). Never deletes. */
  setGroundTruthValidity(logicalEventKey: string, validity: GroundTruthValidity, evidenceWorkflowPath?: string): Promise<{ changed: boolean }>;
  /** 2026-09-05 repair step 3: the repository's explicit stage classification JSON (raw; parsed and
   * validated by stage-classification-config.ts), or undefined when none is configured. */
  getStageClassificationRaw(repository: string): Promise<string | undefined>;
  setStageClassificationRaw(repository: string, json: string): Promise<{ changed: boolean }>;
  /** 2026-09-05 seamless install: persists an automatic identification (never over an 'explicit' one). */
  recordIdentification(input: RecordIdentificationInput): Promise<{ applied: boolean; reason?: string }>;
  getIdentification(repository: string): Promise<RepositoryIdentification | undefined>;
  /** Repositories in an observable state that have no evidence workflow yet, or whose automatic
   * identification should be re-checked (none_found / shape_mismatch older than `recheckAfterMs`). */
  listRepositoriesNeedingIdentification(nowIso: string, recheckAfterMs: number, limit: number): Promise<string[]>;
  /** Report access: a private repository's report needs its token. Generates the token on first call. */
  setRepositoryPrivacy(repository: string, isPrivate: boolean): Promise<void>;
  getReportAccess(repository: string): Promise<{ isPrivate: boolean; token?: string } | undefined>;
  /** Sets state/notes for a repository the automatic path found ineligible or observable again. */
  setRepositoryStateWithNote(repository: string, state: ShadowRepositoryState, note: string | undefined): Promise<void>;
  /** Telemetry self-health invariants (research note, "Decisions"): facts a human should never have to
   * discover by hand again. Each is a count or an age; the cron-status route exposes them. */
  getSelfHealth(nowIso: string): Promise<ShadowSelfHealth>;
  /** Repositories the cron runner may poll: observation_source 'cloudflare-poll' OR 'github-app-webhook'
   * in a pollable state, never-polled first, then oldest-polled first. Webhook-enrolled repositories
   * were excluded until 2026-09-04; the cron's cheap head check is now their safety net for a lost push
   * delivery or a push-triggered poll that never finished (shadow-push-poll.ts). */
  listPollableRepositories(): Promise<PollableRepositoryRow[]>;
  /** shadow_push_polls: durable trail of push-triggered poll attempts (schema-migration-2026-09-04). */
  beginPushPoll(input: { kind: PushPollKind; repository: string; headSha?: string; enqueuedAt: string; startedAt: string }): Promise<number>;
  finishPushPoll(id: number, record: PushPollRecord): Promise<void>;
  listRecentPushPolls(limit: number): Promise<unknown[]>;
  /** True when a push-triggered poll for this repository started after `sinceIso` and has not finished -
   * the cron uses it to avoid launching a second container against the same sandbox session. */
  hasInFlightPushPoll(repository: string, sinceIso: string): Promise<boolean>;
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
  /** Predictions with no shadow_ground_truth row and no terminal reason, capped at `limit`. Ordered
   * never-attempted first, then least recently attempted (2026-09-05) - NOT oldest first: that order let
   * ten permanently-pending rows occupy the whole window for two weeks (research note 2026-09-05, F1). */
  findPendingPredictions(repository: string, limit: number): Promise<PendingPredictionRow[]>;
  /** Marks a prediction's ground truth as provably unobtainable (shadow-reconcile-terminal.ts). Refuses
   * (changed:false) when a ground-truth row already exists or the row is already terminal, so a decision
   * can never overwrite real evidence. The prediction row is otherwise untouched. */
  terminalizePrediction(logicalDeltaKey: string, reason: string, at: string, detail: Record<string, unknown>): Promise<{ changed: boolean }>;
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

  // --- Erasure (site/data-handling.html's two deletion commitments, see shadow-erasure.ts) ---

  /** Repositories currently attributed to one installation - the set an `installation.deleted`
   * webhook must erase. */
  listRepositoriesByInstallation(installationId: string): Promise<string[]>;
  /** r2_evidence_key values (predictions + their ground truth) for one repository - must be read
   * BEFORE eraseAnalysisRecordsForRepository deletes the rows that name them; the R2 key exists
   * nowhere else. */
  collectEvidenceKeys(repository: string): Promise<string[]>;
  /** Deletes every prediction, ground-truth, and economics-observation row for one repository.
   * Deliberately does NOT touch the shadow_repositories row itself - the uninstall webhook path calls
   * markRepositoryRemoved separately; the (future, on-demand) 90-day sweep leaves an installed
   * repository's own row alone entirely, only its aged-out evidence. */
  eraseAnalysisRecordsForRepository(repository: string): Promise<{ predictionsDeleted: number; groundTruthDeleted: number; economicsDeleted: number }>;
  /** Uninstall-only: marks a repository REMOVED and clears its installation id, so a stale id can
   * never be used to mint a token again even if this repository is never re-enrolled. */
  markRepositoryRemoved(repository: string, removedAt: string): Promise<void>;
  /** r2_evidence_key values (predictions + their ground truth) for every prediction older than
   * cutoffIso, across every repository - the 90-day cap's unit of work, read before
   * eraseExpiredAnalysisRecords deletes the rows that name them. */
  listExpiredEvidenceKeys(cutoffIso: string): Promise<string[]>;
  /** Deletes every prediction, ground-truth, and economics-observation row whose PREDICTION predates
   * cutoffIso, across every repository. Cutoff is always the prediction's own prediction_created_at -
   * "the analysis that produced it", per site/data-handling.html - never created_at (insert-time
   * bookkeeping, not analysis time) and never the ground-truth or economics row's own timestamp, which
   * would let a slow-to-reconcile prediction escape the cap or a fast-to-reconcile one be purged early
   * relative to its sibling rows. */
  eraseExpiredAnalysisRecords(cutoffIso: string): Promise<{ predictionsDeleted: number; groundTruthDeleted: number; economicsDeleted: number }>;
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
    async recordHeadTransition(t: { repository: string; fromSha?: string; toSha: string; detectedAt: string; analysed: boolean }) {
      await db
        .prepare(`INSERT INTO shadow_head_transitions (repository, from_sha, to_sha, detected_at, analysed) VALUES (?, ?, ?, ?, ?)`)
        .bind(t.repository, t.fromSha ?? null, t.toSha, t.detectedAt, t.analysed ? 1 : 0)
        .run();
    },

    async pauseRepository(repository: string, reason: string) {
      await db.prepare(`UPDATE shadow_repositories SET state = 'PAUSED', notes = ? WHERE repository = ?`).bind(reason, repository).run();
    },

    async consecutivePollErrors(repository: string) {
      const row = await db.prepare(`SELECT consecutive_poll_errors as n FROM shadow_repositories WHERE repository = ?`).bind(repository).first<{ n: number }>();
      return row?.n ?? 0;
    },

    async reserveLaunchSlot(repository: string, maxPerDay: number, caps?: LaunchCaps) {
      const now = new Date();
      const day = now.toISOString().slice(0, 10);
      // 2026-09-05 fairness caps, checked before the global ceiling: a repository's own share and its
      // observation source's share. Counted from the same table the ceiling uses.
      if (caps?.perRepositoryPerDay !== undefined) {
        const own = await db.prepare(`SELECT COUNT(*) as n FROM shadow_analysis_launches WHERE day = ? AND repository = ?`).bind(day, repository).first<{ n: number }>();
        if ((own?.n ?? 0) >= caps.perRepositoryPerDay) return { granted: false, refusedBy: "repository" };
      }
      if (caps?.perSourcePerDay) {
        const src = await db.prepare(`SELECT observation_source FROM shadow_repositories WHERE repository = ?`).bind(repository).first<{ observation_source: ObservationSource }>();
        const cap = src ? caps.perSourcePerDay[src.observation_source] : undefined;
        if (src && cap !== undefined) {
          const used = await db
            .prepare(`SELECT COUNT(*) as n FROM shadow_analysis_launches l JOIN shadow_repositories r ON r.repository = l.repository WHERE l.day = ? AND r.observation_source = ?`)
            .bind(day, src.observation_source)
            .first<{ n: number }>();
          if ((used?.n ?? 0) >= cap) return { granted: false, refusedBy: "source" };
        }
      }
      // Bounded retry: PRIMARY KEY (day, slot_no) is the arbiter. Two overlapping sweeps that both read
      // the same count will both try the same slot number and exactly one insert survives; the loser
      // re-reads and either takes the next slot or is refused because the budget really is spent.
      for (let attempt = 0; attempt < 8; attempt++) {
        const row = await db.prepare(`SELECT COUNT(*) as n FROM shadow_analysis_launches WHERE day = ?`).bind(day).first<{ n: number }>();
        const next = (row?.n ?? 0) + 1;
        if (next > maxPerDay) return { granted: false, refusedBy: "day" };
        try {
          await db
            .prepare(`INSERT INTO shadow_analysis_launches (day, slot_no, repository, reserved_at) VALUES (?, ?, ?, ?)`)
            .bind(day, next, repository, now.toISOString())
            .run();
          return { granted: true, slotNo: next };
        } catch {
          // Slot taken by a concurrent sweep - retry against a fresh count.
        }
      }
      // Persistent contention is treated as a refusal rather than an overrun: exceeding the ceiling is
      // worse than skipping one launch, and the next sweep is only minutes away.
      return { granted: false };
    },

    async recordLaunchOutcome(slotNo: number, outcome: "succeeded" | "failed") {
      const day = new Date().toISOString().slice(0, 10);
      await db.prepare(`UPDATE shadow_analysis_launches SET outcome = ? WHERE day = ? AND slot_no = ?`).bind(outcome, day, slotNo).run();
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
           WHERE observation_source IN ('cloudflare-poll', 'github-app-webhook') AND state IN ('VALIDATING', 'SHADOW_ACTIVE', 'SHADOW_LIMITED')
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

    async beginPushPoll(input) {
      const row = await db
        .prepare(
          `INSERT INTO shadow_push_polls (repository, kind, head_sha, enqueued_at, started_at)
           VALUES (?, ?, ?, ?, ?) RETURNING id`,
        )
        .bind(input.repository, input.kind, input.headSha ?? null, input.enqueuedAt, input.startedAt)
        .first<{ id: number }>();
      if (!row) throw new Error("shadow_push_polls insert returned no id");
      return row.id;
    },

    async finishPushPoll(id, record) {
      const error = [record.error, record.detail].filter(Boolean).join(" | ") || null;
      await db
        .prepare(
          `UPDATE shadow_push_polls SET finished_at = ?, outcome = ?, predictions_recorded = ?, slot_no = ?, error = ?
           WHERE id = ?`,
        )
        .bind(record.finishedAt, record.outcome, record.predictionsRecorded, record.slotNo ?? null, error, id)
        .run();
    },

    async listRecentPushPolls(limit) {
      const { results } = await db
        .prepare(`SELECT * FROM shadow_push_polls ORDER BY id DESC LIMIT ?`)
        .bind(Math.max(1, Math.min(100, limit)))
        .all();
      return results;
    },

    async hasInFlightPushPoll(repository, sinceIso) {
      const row = await db
        .prepare(
          `SELECT COUNT(*) as n FROM shadow_push_polls
           WHERE repository = ? AND kind = 'poll' AND finished_at IS NULL AND started_at > ?`,
        )
        .bind(repository, sinceIso)
        .first<{ n: number }>();
      return (row?.n ?? 0) > 0;
    },

    async getRepositoryPollState(repository) {
      const row = await db
        .prepare(`SELECT state, last_polled_sha, language FROM shadow_repositories WHERE repository = ?`)
        .bind(repository)
        .first<{ state: ShadowRepositoryState; last_polled_sha: string | null; language: string }>();
      if (!row) return undefined;
      return { state: row.state, lastPolledSha: row.last_polled_sha ?? undefined, language: row.language };
    },

    async getEvidenceWorkflowPaths(repository) {
      const row = await db
        .prepare(`SELECT evidence_workflow_paths FROM shadow_repositories WHERE repository = ?`)
        .bind(repository)
        .first<{ evidence_workflow_paths: string | null }>();
      if (!row?.evidence_workflow_paths) return undefined;
      try {
        const parsed = JSON.parse(row.evidence_workflow_paths) as unknown;
        return Array.isArray(parsed) && parsed.every((p) => typeof p === "string") && parsed.length > 0 ? (parsed as string[]) : undefined;
      } catch {
        return undefined;
      }
    },

    async setEvidenceWorkflowPaths(repository, paths) {
      // A founder-set configuration is 'explicit' and is never overwritten by automatic identification.
      const result = await db
        .prepare(`UPDATE shadow_repositories SET evidence_workflow_paths = ?, evidence_workflow_source = 'explicit', identification_status = 'identified', identification_note = NULL WHERE repository = ?`)
        .bind(JSON.stringify(paths), repository)
        .run();
      return { changed: (result.meta?.changes ?? 0) > 0 };
    },

    async recordIdentification(input) {
      const current = await db
        .prepare(`SELECT evidence_workflow_source FROM shadow_repositories WHERE repository = ?`)
        .bind(input.repository)
        .first<{ evidence_workflow_source: string | null }>();
      if (!current) return { applied: false, reason: "repository is not enrolled" };
      if (current.evidence_workflow_source === "explicit") {
        // Still record that the automatic path looked, so the check time is honest - but touch nothing else.
        await db.prepare(`UPDATE shadow_repositories SET identification_checked_at = ? WHERE repository = ?`).bind(input.at, input.repository).run();
        return { applied: false, reason: "explicit configuration takes precedence" };
      }
      if (input.status === "identified" || input.status === "verified") {
        await db
          .prepare(
            `UPDATE shadow_repositories
             SET evidence_workflow_paths = ?, stage_classification = ?, evidence_workflow_source = 'auto', evidence_workflow_derivation = ?,
                 identification_status = ?, identification_checked_at = ?, identification_note = ?, workflows_tree_sha = COALESCE(?, workflows_tree_sha)
             WHERE repository = ?`,
          )
          .bind(
            JSON.stringify(input.evidenceWorkflowPaths ?? []), input.stageClassificationJson ?? null, input.derivationJson ?? null,
            input.status, input.at, input.note ?? null, input.workflowsTreeSha ?? null, input.repository,
          )
          .run();
      } else {
        // none_found / shape_mismatch / ineligible: withdraw the automatic evidence workflow so nothing
        // is admitted on a derivation that no longer holds; keep the derivation for the record.
        await db
          .prepare(
            `UPDATE shadow_repositories
             SET evidence_workflow_paths = NULL, stage_classification = NULL, evidence_workflow_source = 'auto',
                 evidence_workflow_derivation = COALESCE(?, evidence_workflow_derivation),
                 identification_status = ?, identification_checked_at = ?, identification_note = ?, workflows_tree_sha = COALESCE(?, workflows_tree_sha)
             WHERE repository = ?`,
          )
          .bind(input.derivationJson ?? null, input.status, input.at, input.note ?? null, input.workflowsTreeSha ?? null, input.repository)
          .run();
      }
      return { applied: true };
    },

    async getIdentification(repository) {
      const r = await db
        .prepare(
          `SELECT repository, state, notes, evidence_workflow_source, evidence_workflow_paths, identification_status, identification_checked_at,
                  identification_note, evidence_workflow_derivation, workflows_tree_sha
           FROM shadow_repositories WHERE repository = ?`,
        )
        .bind(repository)
        .first<Record<string, unknown>>();
      if (!r) return undefined;
      let paths: string[] | undefined;
      try {
        const p = r.evidence_workflow_paths ? (JSON.parse(String(r.evidence_workflow_paths)) as unknown) : undefined;
        paths = Array.isArray(p) && p.length > 0 ? (p as string[]) : undefined;
      } catch {
        paths = undefined;
      }
      const s = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : undefined);
      return {
        repository: r.repository as string,
        state: r.state as ShadowRepositoryState,
        notes: s("notes"),
        source: (s("evidence_workflow_source") as "auto" | "explicit" | undefined) ?? undefined,
        evidenceWorkflowPaths: paths,
        status: s("identification_status") as IdentificationStatus | undefined,
        checkedAt: s("identification_checked_at"),
        note: s("identification_note"),
        derivationJson: s("evidence_workflow_derivation"),
        workflowsTreeSha: s("workflows_tree_sha"),
      };
    },

    async listRepositoriesNeedingIdentification(nowIso, recheckAfterMs, limit) {
      const cutoff = new Date(Date.parse(nowIso) - recheckAfterMs).toISOString();
      const { results } = await db
        .prepare(
          `SELECT repository FROM shadow_repositories
           WHERE state IN ('VALIDATING', 'SHADOW_ACTIVE', 'SHADOW_LIMITED')
             AND (evidence_workflow_source IS NULL OR evidence_workflow_source = 'auto')
             AND (
               evidence_workflow_paths IS NULL AND (identification_checked_at IS NULL OR identification_checked_at < ?)
             )
           ORDER BY COALESCE(identification_checked_at, '') ASC, enrolled_at ASC
           LIMIT ?`,
        )
        .bind(cutoff, limit)
        .all<{ repository: string }>();
      return results.map((r) => r.repository);
    },

    async setRepositoryPrivacy(repository, isPrivate) {
      const token = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
      await db
        .prepare(`UPDATE shadow_repositories SET is_private = ?, report_token = COALESCE(report_token, ?) WHERE repository = ?`)
        .bind(isPrivate ? 1 : 0, token, repository)
        .run();
    },

    async getReportAccess(repository) {
      const r = await db.prepare(`SELECT is_private, report_token FROM shadow_repositories WHERE repository = ?`).bind(repository).first<{ is_private: number | null; report_token: string | null }>();
      if (!r) return undefined;
      return { isPrivate: r.is_private === 1, token: r.report_token ?? undefined };
    },

    async setRepositoryStateWithNote(repository, state, note) {
      await db.prepare(`UPDATE shadow_repositories SET state = ?, notes = ? WHERE repository = ?`).bind(state, note ?? null, repository).run();
    },

    async setGroundTruthValidity(logicalEventKey, validity, evidenceWorkflowPath) {
      const result = await db
        .prepare(`UPDATE shadow_ground_truth SET evidence_validity = ?, evidence_workflow_path = COALESCE(?, evidence_workflow_path) WHERE logical_event_key = ?`)
        .bind(validity, evidenceWorkflowPath ?? null, logicalEventKey)
        .run();
      return { changed: (result.meta?.changes ?? 0) > 0 };
    },

    async getStageClassificationRaw(repository) {
      const row = await db
        .prepare(`SELECT stage_classification FROM shadow_repositories WHERE repository = ?`)
        .bind(repository)
        .first<{ stage_classification: string | null }>();
      return row?.stage_classification ?? undefined;
    },

    async setStageClassificationRaw(repository, jsonText) {
      const result = await db
        .prepare(`UPDATE shadow_repositories SET stage_classification = ?, evidence_workflow_source = 'explicit' WHERE repository = ?`)
        .bind(jsonText, repository)
        .run();
      return { changed: (result.meta?.changes ?? 0) > 0 };
    },

    async getSelfHealth(nowIso) {
      const never = await db
        .prepare(
          `SELECT COUNT(*) AS n, MIN(p.prediction_created_at) AS oldest
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE g.logical_delta_key IS NULL AND p.reconcile_terminal_reason IS NULL AND p.last_reconcile_attempted_at IS NULL`,
        )
        .bind()
        .first<{ n: number; oldest: string | null }>();
      const unlabelled = await db.prepare(`SELECT COUNT(*) AS n FROM shadow_ground_truth WHERE evidence_validity IS NULL`).bind().first<{ n: number }>();
      const backlog = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM shadow_ground_truth g
           WHERE g.evidence_validity = 'VERIFIED'
             AND NOT EXISTS (SELECT 1 FROM shadow_stage_economics e WHERE e.logical_delta_key = g.logical_delta_key)`,
        )
        .bind()
        .first<{ n: number }>();
      const observed = await db
        .prepare(
          `SELECT r.repository, r.evidence_workflow_paths,
                  (SELECT COUNT(*) FROM shadow_predictions p WHERE p.repository = r.repository) AS predictions,
                  (SELECT COUNT(*) FROM shadow_ground_truth g WHERE g.repository = r.repository AND g.evidence_validity = 'VERIFIED') AS verified
           FROM shadow_repositories r WHERE r.state IN ('SHADOW_ACTIVE', 'SHADOW_LIMITED', 'VALIDATING')`,
        )
        .bind()
        .all<{ repository: string; evidence_workflow_paths: string | null; predictions: number; verified: number }>();
      const oldestMs = never?.oldest ? Date.parse(never.oldest) : Number.NaN;
      return {
        neverAttemptedPredictions: never?.n ?? 0,
        oldestNeverAttemptedAgeMs: Number.isFinite(oldestMs) ? Math.max(0, Date.parse(nowIso) - oldestMs) : undefined,
        unlabelledGroundTruthRows: unlabelled?.n ?? 0,
        verifiedWithoutStageEconomics: backlog?.n ?? 0,
        unconfiguredEvidenceRepositories: observed.results.filter((r) => !r.evidence_workflow_paths).map((r) => r.repository),
        observedWithoutVerifiedGroundTruth: observed.results.filter((r) => r.predictions > 0 && r.verified === 0).map((r) => r.repository),
      };
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
             ground_truth_fetched_at, created_at, evidence_workflow_path, evidence_validity
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(logical_event_key) DO NOTHING`,
        )
        .bind(
          input.logicalEventKey, input.logicalDeltaKey, input.repository, input.headSha,
          input.workflowRunId ?? null, input.workflowRunAttempt, input.eventType, input.pullRequestNumber ?? null,
          input.workflowConclusion ?? null, input.workflowCompletedAt ?? null, input.groundTruthStatus,
          input.relevantFailuresObserved, input.relevantFailuresEvaluable, input.failuresPreservedByDiffci,
          input.failuresPreservedByPath, input.predictionPrecededGroundTruth ? 1 : 0, r2EvidenceKey,
          input.groundTruthFetchedAt, now,
          input.evidenceWorkflowPath ?? null, input.evidenceWorkflowPath ? "VERIFIED" : "UNVERIFIED",
        )
        .run();
      return { inserted: (result.meta?.changes ?? 0) > 0 };
    },

    async findPendingPredictions(repository, limit) {
      const { results } = await db
        .prepare(
          `SELECT p.logical_delta_key, p.repository, p.head_sha, p.r2_evidence_key, p.diffci_analysis_overhead_ms, p.prediction_created_at,
                  p.last_reconcile_attempted_at, p.last_reconcile_reason
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE p.repository = ? AND g.logical_delta_key IS NULL AND p.reconcile_terminal_reason IS NULL
           ORDER BY (p.last_reconcile_attempted_at IS NOT NULL) ASC, p.last_reconcile_attempted_at ASC, p.created_at ASC
           LIMIT ?`,
        )
        .bind(repository, limit)
        .all<{
          logical_delta_key: string; repository: string; head_sha: string; r2_evidence_key: string; diffci_analysis_overhead_ms: number;
          prediction_created_at: string; last_reconcile_attempted_at: string | null; last_reconcile_reason: string | null;
        }>();
      return results.map((r) => ({
        logicalDeltaKey: r.logical_delta_key,
        repository: r.repository,
        headSha: r.head_sha,
        r2EvidenceKey: r.r2_evidence_key,
        diffciAnalysisOverheadMs: r.diffci_analysis_overhead_ms,
        predictionCreatedAt: r.prediction_created_at,
        lastReconcileAttemptedAt: r.last_reconcile_attempted_at ?? undefined,
        lastReconcileReason: r.last_reconcile_reason ?? undefined,
      }));
    },

    async terminalizePrediction(logicalDeltaKey, reason, at, detail) {
      const result = await db
        .prepare(
          `UPDATE shadow_predictions
           SET reconcile_terminal_reason = ?, reconcile_terminal_at = ?, reconcile_terminal_detail = ?
           WHERE logical_delta_key = ?
             AND reconcile_terminal_reason IS NULL
             AND NOT EXISTS (SELECT 1 FROM shadow_ground_truth g WHERE g.logical_delta_key = shadow_predictions.logical_delta_key)`,
        )
        .bind(reason, at, JSON.stringify(detail), logicalDeltaKey)
        .run();
      return { changed: (result.meta?.changes ?? 0) > 0 };
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
             SUM(CASE WHEN evidence_validity = 'VERIFIED' THEN 1 ELSE 0 END) AS ground_truth_verified,
             SUM(CASE WHEN evidence_validity = 'VERIFIED' AND ground_truth_status = 'COMPLETE' THEN 1 ELSE 0 END) AS reconciled_complete,
             SUM(CASE WHEN evidence_validity = 'VERIFIED' THEN relevant_failures_observed ELSE 0 END) AS relevant_failures_observed,
             SUM(CASE WHEN evidence_validity = 'VERIFIED' THEN relevant_failures_evaluable ELSE 0 END) AS relevant_failures_evaluable,
             SUM(CASE WHEN evidence_validity = 'VERIFIED' THEN failures_preserved_by_diffci ELSE 0 END) AS failures_preserved_by_diffci,
             SUM(CASE WHEN evidence_validity = 'VERIFIED' THEN failures_preserved_by_path ELSE 0 END) AS failures_preserved_by_path
           FROM shadow_ground_truth WHERE repository = ?`,
        )
        .bind(repository)
        .first<{
          ground_truth_recorded: number; ground_truth_verified: number | null; reconciled_complete: number | null; relevant_failures_observed: number | null;
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
           WHERE g.repository = ? AND p.opportunity_category = 'DISCRIMINATIVE_OPPORTUNITY' AND g.evidence_validity = 'VERIFIED'`,
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
        groundTruthVerified: groundTruthCounts?.ground_truth_verified ?? 0,
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
             SUM(CASE WHEN g.logical_delta_key IS NOT NULL THEN 1 ELSE 0 END) AS reconciled,
             SUM(CASE WHEN g.logical_delta_key IS NULL AND p.reconcile_terminal_reason IS NOT NULL THEN 1 ELSE 0 END) AS terminal
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE 1=1 ${repoFilter}`,
        )
        .bind(...bindArgs)
        .first<{ total: number; reconciled: number | null; terminal: number | null }>();

      const terminalRows = await db
        .prepare(
          `SELECT p.reconcile_terminal_reason AS reason, COUNT(*) AS count
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE g.logical_delta_key IS NULL AND p.reconcile_terminal_reason IS NOT NULL ${repoFilter}
           GROUP BY reason
           ORDER BY count DESC`,
        )
        .bind(...bindArgs)
        .all<{ reason: string; count: number }>();

      const reasonRows = await db
        .prepare(
          `SELECT COALESCE(p.last_reconcile_reason, 'not_yet_attempted') AS reason, COUNT(*) AS count
           FROM shadow_predictions p
           LEFT JOIN shadow_ground_truth g ON g.logical_delta_key = p.logical_delta_key
           WHERE g.logical_delta_key IS NULL AND p.reconcile_terminal_reason IS NULL ${repoFilter}
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
           WHERE g.logical_delta_key IS NULL AND p.reconcile_terminal_reason IS NULL ${repoFilter}
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
        terminalUnevaluable: totals?.terminal ?? 0,
        terminalReasons: terminalRows.results.map((r) => ({ reason: r.reason, count: r.count })),
        pendingReasons: reasonRows.results.map((r) => ({ reason: r.reason, count: r.count })),
        oldestPendingAgeMs: allPending.length > 0 ? Math.max(...allPending.map((p) => p.ageMs)) : undefined,
        stuck: allPending
          .filter((p) => p.ageMs >= stuckThresholdMs)
          .sort((a, b) => b.ageMs - a.ageMs)
          .slice(0, stuckLimit),
      };
    },

    async listRepositoriesByInstallation(installationId) {
      const { results } = await db
        .prepare(`SELECT repository FROM shadow_repositories WHERE installation_id = ?`)
        .bind(installationId)
        .all<{ repository: string }>();
      return results.map((r) => r.repository);
    },

    async collectEvidenceKeys(repository) {
      const predictionKeys = await db
        .prepare(`SELECT r2_evidence_key FROM shadow_predictions WHERE repository = ?`)
        .bind(repository)
        .all<{ r2_evidence_key: string }>();
      const groundTruthKeys = await db
        .prepare(`SELECT r2_evidence_key FROM shadow_ground_truth WHERE repository = ?`)
        .bind(repository)
        .all<{ r2_evidence_key: string }>();
      return [...predictionKeys.results.map((r) => r.r2_evidence_key), ...groundTruthKeys.results.map((r) => r.r2_evidence_key)].filter(Boolean);
    },

    async eraseAnalysisRecordsForRepository(repository) {
      // Children before parent: shadow_ground_truth/shadow_economics_observations reference
      // shadow_predictions.logical_delta_key - matches the same ordering discipline the uninstall
      // webhook doc comment (src/install/webhook.ts) already established for the product pipeline.
      const economics = await db
        .prepare(`DELETE FROM shadow_economics_observations WHERE logical_delta_key IN (SELECT logical_delta_key FROM shadow_predictions WHERE repository = ?)`)
        .bind(repository)
        .run();
      const groundTruth = await db.prepare(`DELETE FROM shadow_ground_truth WHERE repository = ?`).bind(repository).run();
      const predictions = await db.prepare(`DELETE FROM shadow_predictions WHERE repository = ?`).bind(repository).run();
      return {
        predictionsDeleted: predictions.meta?.changes ?? 0,
        groundTruthDeleted: groundTruth.meta?.changes ?? 0,
        economicsDeleted: economics.meta?.changes ?? 0,
      };
    },

    async markRepositoryRemoved(repository, removedAt) {
      await db
        .prepare(`UPDATE shadow_repositories SET state = 'REMOVED', removed_at = ?, installation_id = NULL WHERE repository = ?`)
        .bind(removedAt, repository)
        .run();
    },

    async listExpiredEvidenceKeys(cutoffIso) {
      // prediction_created_at, NOT created_at: created_at is insert-time bookkeeping (when the D1 row
      // happened to be written), prediction_created_at is "when the analysis that produced it ran" -
      // the immutable timestamp the schema's own comment calls out (shadow-migration-2026-08-21-stage2-
      // shadow.sql), and the one site/data-handling.html's "90 days ... from the analysis that produced
      // it" actually means.
      const predictionKeys = await db
        .prepare(`SELECT r2_evidence_key FROM shadow_predictions WHERE prediction_created_at < ?`)
        .bind(cutoffIso)
        .all<{ r2_evidence_key: string }>();
      const groundTruthKeys = await db
        .prepare(
          `SELECT g.r2_evidence_key FROM shadow_ground_truth g
           JOIN shadow_predictions p ON p.logical_delta_key = g.logical_delta_key
           WHERE p.prediction_created_at < ?`,
        )
        .bind(cutoffIso)
        .all<{ r2_evidence_key: string }>();
      return [...predictionKeys.results.map((r) => r.r2_evidence_key), ...groundTruthKeys.results.map((r) => r.r2_evidence_key)].filter(Boolean);
    },

    async eraseExpiredAnalysisRecords(cutoffIso) {
      // Same prediction_created_at cutoff as listExpiredEvidenceKeys above - both must agree on which
      // rows are "expired", or a key could be read (and its R2 object deleted) from one query while the
      // D1 row a different cutoff column leaves behind still points at it.
      const economics = await db
        .prepare(`DELETE FROM shadow_economics_observations WHERE logical_delta_key IN (SELECT logical_delta_key FROM shadow_predictions WHERE prediction_created_at < ?)`)
        .bind(cutoffIso)
        .run();
      const groundTruth = await db
        .prepare(`DELETE FROM shadow_ground_truth WHERE logical_delta_key IN (SELECT logical_delta_key FROM shadow_predictions WHERE prediction_created_at < ?)`)
        .bind(cutoffIso)
        .run();
      const predictions = await db.prepare(`DELETE FROM shadow_predictions WHERE prediction_created_at < ?`).bind(cutoffIso).run();
      return {
        predictionsDeleted: predictions.meta?.changes ?? 0,
        groundTruthDeleted: groundTruth.meta?.changes ?? 0,
        economicsDeleted: economics.meta?.changes ?? 0,
      };
    },
  };
}
