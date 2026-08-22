-- Execution queue schema, same diffci-product D1 database. Applied after src/product/cloudflare/schema.sql
-- and src/runner/cloudflare/schema.sql (assigned_runner_id references runners(id)).
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/execution-queue/cloudflare/schema.sql

CREATE TABLE IF NOT EXISTS execution_queue_items (
  id TEXT PRIMARY KEY,              -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  repository_id TEXT REFERENCES repositories(id),
  job_reference TEXT NOT NULL,
  requested_resource_class TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN (
    'queued', 'assigning', 'assigned', 'running', 'completed', 'failed', 'cancelled', 'timed_out'
  )),
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  assigned_runner_id TEXT REFERENCES runners(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_queue_org_status ON execution_queue_items(organization_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_status_priority ON execution_queue_items(status, priority, created_at);
