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
