-- Usage schema, same diffci-product D1 database. Applied after src/product/cloudflare/schema.sql
-- (references organizations(id), repositories(id)).
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/usage/cloudflare/schema.sql

-- Provider-independent usage ledger (Part 5). idempotency_key is the ONLY thing that prevents
-- double-counting (Part 6) - INSERT OR IGNORE keyed on it, enforced at the database layer via the UNIQUE
-- constraint, not merely checked in application code (a second concurrent request racing the same event
-- must still only be counted once).
CREATE TABLE IF NOT EXISTS usage_events (
  id TEXT PRIMARY KEY,              -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  repository_id TEXT REFERENCES repositories(id), -- nullable: some event types are org-level, not repo-level
  event_type TEXT NOT NULL CHECK (event_type IN (
    'prediction', 'ci_run_analyzed', 'tests_considered', 'tests_selected',
    'estimated_compute_seconds', 'runner_seconds', 'runner_job', 'repository_active'
  )),
  quantity REAL NOT NULL,
  unit TEXT NOT NULL,                -- e.g. 'count', 'seconds'
  source_type TEXT NOT NULL,         -- e.g. 'github_webhook', 'shadow_reconciliation', 'runner_completion'
  source_id TEXT NOT NULL,           -- the upstream event's own identity (e.g. a workflow_run id) - part
                                      -- of the idempotency key derivation, see src/usage/store.ts
  occurred_at TEXT NOT NULL,         -- when the underlying activity actually happened
  recorded_at TEXT NOT NULL,         -- when DiffCI recorded it (may lag occurred_at)
  idempotency_key TEXT NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS idx_usage_events_org_time ON usage_events(organization_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_usage_events_org_type_time ON usage_events(organization_id, event_type, occurred_at);

-- Real per-commit CI duration observations, captured for the cost/carbon-savings estimate (see
-- src/usage/savings.ts, src/usage/climate-model.ts). Deliberately a SEPARATE, additive, product-owned
-- table - it never touches diffci-research's shadow_predictions/shadow_ground_truth (Stage 2F's frozen
-- schema, under its own 14-day observation-window freeze as of 2026-08-22 - see docs/research). The
-- capture job (src/usage/duration-capture-job.ts) only ever READS Stage 2F predictions through the
-- existing, already-sanctioned read-only ShadowReadBoundary (Part 20), and independently re-fetches real
-- job timing from GitHub's own API (src/shadow/github-baseline.ts's fetchBaselineEvidence, unmodified) -
-- nothing here writes to, or depends on the internal shape of, any Stage 2F table.
CREATE TABLE IF NOT EXISTS ci_duration_observations (
  logical_delta_key TEXT PRIMARY KEY, -- same identity as the Stage 2F prediction it was derived from, purely for idempotency/dedup - this table has no foreign key into shadow_predictions
  repository TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  workflow_run_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of real GitHub Actions workflow_run ids this observation was derived from (audit provenance) - never raw log content
  job_ids TEXT NOT NULL DEFAULT '[]', -- JSON array of real GitHub Actions job ids
  tests_total_full INTEGER NOT NULL,
  real_job_duration_ms INTEGER NOT NULL,
  seconds_per_test REAL NOT NULL,
  observed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ci_duration_observations_repository ON ci_duration_observations(repository, observed_at);
