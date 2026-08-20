-- Stage 2 shadow-validation schema: prospective, continuously-growing observation of real CI events,
-- as opposed to the Stage 0/1 tables above (schema.sql, schema-migration-2026-08-21.sql) which track one
-- bounded, historical benchmark run against a fixed corpus. These tables are additive and independent -
-- nothing here alters experiment_runs/repository_runs/completed_deltas/budget_ledger.
--
-- Apply with: wrangler d1 execute diffci-research --remote --file=src/research/cloudflare/schema-migration-2026-08-21-stage2-shadow.sql

-- One row per repository enrolled in shadow observation (Stage 2 Phase 12/14). `state` is the explicit
-- state machine from the Stage 2 spec - Stage 2 code must NEVER write 'READY_FOR_ENFORCEMENT_REVIEW'
-- automatically transitioning a repo into enforcement; that state means only "evidence threshold met,
-- awaiting human review" (see docs/research/2026-08-21-stage2-enforcement-thresholds.md).
CREATE TABLE IF NOT EXISTS shadow_repositories (
  repository TEXT PRIMARY KEY, -- "owner/name"
  state TEXT NOT NULL DEFAULT 'VALIDATING' CHECK (state IN (
    'INSTALLING', 'VALIDATING', 'SHADOW_ACTIVE', 'SHADOW_LIMITED', 'PAUSED',
    'UNSUPPORTED', 'READY_FOR_ENFORCEMENT_REVIEW', 'REMOVED'
  )),
  -- How events are observed for this repository - see the architecture doc for why three sources exist:
  -- 'cloudflare-poll' (Gate A default today - REST polling from a Cron Trigger, no GitHub App needed),
  -- 'github-actions-step' (the repo runs diffci-shadow.ts itself as a workflow step and POSTs its result),
  -- 'github-app-webhook' (the future, lower-latency, scale-to-many-repos path - designed, not yet live).
  observation_source TEXT NOT NULL CHECK (observation_source IN ('cloudflare-poll', 'github-actions-step', 'github-app-webhook')),
  enrolled_at TEXT NOT NULL,
  last_polled_sha TEXT,
  last_polled_at TEXT,
  removed_at TEXT,
  notes TEXT
);

-- One row per DISTINCT (repository, baseSha, headSha, analysis version) - i.e. one row per prediction
-- DiffCI actually computed. Deliberately NOT keyed by workflow run/attempt: the prediction is a pure
-- function of the commit pair and DiffCI's own version, so a workflow retry of the same commit must
-- reuse this same row, never recompute or overwrite it. `prediction_created_at` is written once at
-- INSERT and never updated by any later code path - it is the prospectiveness evidence (Phase 5): every
-- ground-truth row that later references this prediction can prove its outcome was observed strictly
-- after the prediction already existed.
CREATE TABLE IF NOT EXISTS shadow_predictions (
  logical_delta_key TEXT PRIMARY KEY, -- repository:baseSha:headSha:diffciAnalysisVersion:graphVersion
  repository TEXT NOT NULL REFERENCES shadow_repositories(repository),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  diffci_analysis_version TEXT NOT NULL,
  graph_version TEXT NOT NULL,
  shadow_schema_version TEXT NOT NULL,
  observation_source TEXT NOT NULL CHECK (observation_source IN ('cloudflare-poll', 'github-actions-step', 'github-app-webhook')),
  plan_mode TEXT NOT NULL CHECK (plan_mode IN ('FULL', 'SELECTIVE')),
  fallback INTEGER NOT NULL, -- 0/1
  effective_graph_confidence TEXT NOT NULL,
  opportunity_category TEXT NOT NULL CHECK (opportunity_category IN ('MANDATORY_FALLBACK', 'BASELINE_ALREADY_OPTIMAL', 'DISCRIMINATIVE_OPPORTUNITY')),
  tests_selected_diffci INTEGER NOT NULL,
  tests_selected_path INTEGER NOT NULL,
  tests_total_full INTEGER NOT NULL,
  diffci_analysis_overhead_ms REAL NOT NULL,
  r2_evidence_key TEXT NOT NULL, -- full ShadowRunRecord (prediction half - graph/impact/plan, no ground truth yet)
  prediction_created_at TEXT NOT NULL, -- immutable once written - see comment above
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_predictions_repository ON shadow_predictions(repository, created_at);
CREATE INDEX IF NOT EXISTS idx_shadow_predictions_opportunity ON shadow_predictions(opportunity_category);

-- One row per REAL observed CI attempt for a commit (Phase 6 ground truth). Deliberately one-per-attempt,
-- not deduped to one-per-commit: a workflow retry of the same head_sha can have a materially different
-- real outcome (pass after an infra flake, etc.), and Phase 6 explicitly wants that signal, not just the
-- final attempt. `logical_event_key` is what makes this idempotent against duplicate webhook deliveries
-- or duplicate polls of the same already-recorded attempt (INSERT ... ON CONFLICT(logical_event_key) DO
-- NOTHING, same idiom as completed_deltas in schema.sql).
--
-- Identity choice (Phase 2, documented per the spec's explicit request): logical_event_key =
-- `${repository}:${headSha}:${workflowRunId ?? "poll"}:${workflowRunAttempt ?? 1}`. workflowRunId is the
-- real GitHub Actions run id when known (github-actions-step / github-app-webhook sources); the literal
-- string "poll" stands in for it when ground truth was discovered by Cloudflare polling a repository's
-- completed runs rather than being told about one directly (cloudflare-poll source) - in that case the
-- workflow's own run id is embedded inside the fetched BaselineEvidence instead of the key, and the key's
-- unattributed run-id slot is deliberately not used to invent a fake one.
CREATE TABLE IF NOT EXISTS shadow_ground_truth (
  logical_event_key TEXT PRIMARY KEY,
  logical_delta_key TEXT NOT NULL REFERENCES shadow_predictions(logical_delta_key),
  repository TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  workflow_run_id TEXT,
  workflow_run_attempt INTEGER NOT NULL DEFAULT 1,
  event_type TEXT NOT NULL CHECK (event_type IN ('push', 'pull_request', 'poll-detected')),
  pull_request_number INTEGER,
  workflow_conclusion TEXT,
  workflow_completed_at TEXT,
  ground_truth_status TEXT NOT NULL CHECK (ground_truth_status IN ('COMPLETE', 'PARTIAL', 'UNAVAILABLE')),
  relevant_failures_observed INTEGER NOT NULL DEFAULT 0,
  relevant_failures_evaluable INTEGER NOT NULL DEFAULT 0,
  failures_preserved_by_diffci INTEGER NOT NULL DEFAULT 0,
  failures_preserved_by_path INTEGER NOT NULL DEFAULT 0,
  -- The prospectiveness proof itself (Phase 5): 1 iff this prediction's prediction_created_at is
  -- provably earlier than this event's own workflow_completed_at (or, when the workflow's completion
  -- timestamp isn't available, earlier than ground_truth_fetched_at as a conservative fallback). Computed
  -- once at insert time from data already on hand - never re-derived later, so it can't drift.
  prediction_preceded_ground_truth INTEGER NOT NULL,
  r2_evidence_key TEXT NOT NULL, -- full ShadowRunRecord (ground-truth half - baseline, failureRecallRecords, measured metrics)
  ground_truth_fetched_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_ground_truth_delta ON shadow_ground_truth(logical_delta_key);
CREATE INDEX IF NOT EXISTS idx_shadow_ground_truth_repository ON shadow_ground_truth(repository, created_at);
