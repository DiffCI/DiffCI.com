-- Runner schema, same diffci-product D1 database. Applied after src/product/cloudflare/schema.sql.
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/runner/cloudflare/schema.sql

CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,               -- UUID (crypto.randomUUID()) - DiffCI's own id, stable even if the
                                      -- provider-side id is not yet known (status='requested')
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL,            -- e.g. 'mock', 'cloudflare-containers' - see src/runner/provider.ts
  provider_runner_id TEXT,           -- nullable until provisionRunner() returns one
  status TEXT NOT NULL CHECK (status IN (
    'requested', 'provisioning', 'ready', 'assigned', 'busy', 'completed', 'terminating', 'terminated', 'failed'
  )),
  requested_resource_class TEXT NOT NULL,
  repository_id TEXT REFERENCES repositories(id),
  assigned_job_id TEXT,              -- execution_queue_items(id) once assigned - no FK (execution_queue
                                      -- schema is applied after this one; kept a plain TEXT reference,
                                      -- matching the rest of the codebase's tolerance for late-bound refs
                                      -- e.g. shadow_predictions.r2_evidence_key)
  created_at TEXT NOT NULL,
  ready_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  terminated_at TEXT,
  runtime_seconds REAL,
  cost_estimate_usd REAL
);
CREATE INDEX IF NOT EXISTS idx_runners_org ON runners(organization_id);
CREATE INDEX IF NOT EXISTS idx_runners_status ON runners(status);
