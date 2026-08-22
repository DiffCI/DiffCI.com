-- Preflight P1 schema (Parts D, E, H). Deliberately its OWN D1 database (`diffci-preflight`, see
-- wrangler.preflight.jsonc), never Stage 2F's shadow_predictions/shadow_ground_truth tables in
-- src/research/cloudflare/schema-migration-2026-08-21-stage2-shadow.sql, and never even sharing the
-- diffci-product database - true storage separation, not just a separate table name, so a bug or
-- migration in one can never touch the other, and Stage 2F's own frozen-core verification
-- (`git diff --stat -- ... src/research/cloudflare/schema*.sql`) can never be tripped by Preflight P1
-- work. `repository_owner_name`/`repository_id` below are plain TEXT, deliberately NOT a foreign key
-- into diffci-product's `repositories` table (different database entirely - D1 has no cross-database
-- FKs) - joins across the two happen in application code, never in SQL.
--
-- Apply with: wrangler d1 execute diffci-preflight --remote --file=src/preflight/cloudflare/schema.sql

-- One row per repo opted into live prospective Preflight observation (Part M: "DiffCI.com only, not
-- DentalPresence.in"). Existence of a row here is the enrollment; absence means "not observed."
CREATE TABLE IF NOT EXISTS preflight_repositories (
  repository_owner_name TEXT PRIMARY KEY,      -- "owner/name", e.g. "adityankale190895/DiffCI.com"
  observation_start_at TEXT NOT NULL,          -- Part M's preflight_observation_start_at - set exactly
                                                -- once, at enrollment, never edited afterwards
  enabled INTEGER NOT NULL DEFAULT 1           -- 0/1 - a kill switch that stops NEW predictions without
                                                -- deleting history or touching observation_start_at
);

-- Part D. Written EXACTLY ONCE per prediction, at creation time, before any CI ground truth for that
-- commit can possibly be known - see src/preflight/prediction-store.ts's PredictionStore interface,
-- which is the only sanctioned writer and which enforces this ordering in code, not just in this
-- schema comment. NEVER UPDATED after insert - full stop, not even for a typo fix. Any reconciliation
-- data lives exclusively in preflight_reconciliations below, a separate table, so "immutable except
-- reconciliation fields" (the spec's own phrasing) is enforced structurally: there ARE no reconciliation
-- fields on this table to accidentally mutate.
CREATE TABLE IF NOT EXISTS preflight_predictions (
  id TEXT PRIMARY KEY,                         -- UUID (crypto.randomUUID())
  repository_owner_name TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  -- Real wall-clock creation time (LIVE mode) or the simulated as-of time this replayed prediction
  -- claims to represent (REPLAY mode) - see `mode`/`replayed_at` below for how these differ and why
  -- both matter for leakage-safety auditing.
  created_at TEXT NOT NULL,
  -- LIVE: a genuine prospective prediction, made before real CI ran, `created_at` is real wall-clock
  -- time. REPLAY: Part G's chronological historical replay, run long after the fact but required to
  -- use ONLY evidence that would have existed as of `created_at` - `replayed_at` records the real
  -- wall-clock time the replay was actually executed, so a reader can always tell "was this really
  -- prospective, or a leakage-safety-audited simulation of being prospective."
  mode TEXT NOT NULL CHECK (mode IN ('LIVE', 'REPLAY')),
  replayed_at TEXT,                            -- NULL for LIVE, required for REPLAY
  changed_files_json TEXT NOT NULL,            -- JSON string[] - the diff this prediction was made from
  risk_score REAL NOT NULL,
  risk_reasons_json TEXT NOT NULL,             -- JSON RiskReason[] (src/preflight/risk-model.ts)
  recommended_checks_json TEXT NOT NULL,       -- JSON string[] of check ids (src/preflight/planner.ts output)
  predicted_failure_classes_json TEXT NOT NULL,-- JSON FailureClass[] this prediction expects, if any
  expected_early_detection_strategy TEXT NOT NULL, -- free text: which check(s)/signal are expected to
                                                    -- catch it before full CI, and why
  -- Versioning so a later algorithm/evidence change never silently reinterprets an old prediction -
  -- Part D's own requirement, and essential for Part G's "do not tune repeatedly to reproduce 75%"
  -- discipline: a replay run must record which exact algorithm_version produced its numbers.
  evidence_version TEXT NOT NULL,
  algorithm_version TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preflight_predictions_repo_commit ON preflight_predictions(repository_owner_name, commit_sha);
CREATE INDEX IF NOT EXISTS idx_preflight_predictions_mode ON preflight_predictions(mode);

-- Part E. At most one row per prediction (UNIQUE below) - attaches real CI ground truth once it
-- becomes known, WITHOUT ever touching preflight_predictions. `outcome` follows Part E's TP/TN/FP/FN/
-- NOT_EVALUABLE definitions - see classifyReconciliationOutcome() in src/preflight/reconciliation.ts
-- for the actual, code-enforced definition of "eligible for prevention" this column encodes.
CREATE TABLE IF NOT EXISTS preflight_reconciliations (
  id TEXT PRIMARY KEY,                         -- UUID (crypto.randomUUID())
  prediction_id TEXT NOT NULL UNIQUE,          -- REFERENCES preflight_predictions(id) - same database,
                                                -- a real FK (unlike the cross-database repository fields above)
  reconciled_at TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  workflow_conclusion TEXT NOT NULL,           -- GitHub's own conclusion string: 'success' | 'failure' | ...
  actual_failure_class TEXT,                   -- FailureClass, NULL if workflow_conclusion = 'success'
  actual_error_fingerprint TEXT,
  failing_job TEXT,
  failing_test TEXT,
  time_to_failure_ms INTEGER,
  total_workflow_duration_ms INTEGER NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('TP', 'TN', 'FP', 'FN', 'NOT_EVALUABLE')),
  outcome_reason TEXT NOT NULL,                -- always populated, even for NOT_EVALUABLE - Part E/9's
                                                -- "never a bare classification with no explanation" discipline
  FOREIGN KEY (prediction_id) REFERENCES preflight_predictions(id)
);
CREATE INDEX IF NOT EXISTS idx_preflight_reconciliations_outcome ON preflight_reconciliations(outcome);

-- Part H. Historical failure "memory" for known-pattern recommendations - deliberately a SEPARATE,
-- smaller table from the full reconciliation history above, so a "have we seen this fingerprint
-- before" lookup stays cheap and doesn't require scanning every historical prediction. Rebuilt/upserted
-- from reconciliation data, never hand-edited. Similarity here is a real recorded recurrence count,
-- never presented as certainty - see src/preflight/preventability.ts's existing KNOWN_FAILURE_PREFLIGHT
-- discipline, which this table feeds.
CREATE TABLE IF NOT EXISTS preflight_known_failures (
  error_fingerprint TEXT PRIMARY KEY,
  failure_class TEXT NOT NULL,
  affected_files_json TEXT NOT NULL,           -- JSON string[] - files/modules seen implicated across occurrences
  recurrence_count INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
