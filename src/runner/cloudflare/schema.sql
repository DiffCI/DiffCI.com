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
  cost_estimate_usd REAL,
  -- R1 additions (DiffCI Real Runner R1 - real ephemeral cloud execution):
  cost_basis TEXT,                   -- e.g. 'provider_estimate' - see src/usage/cost-model.ts's own
                                      -- distinction between an illustrative 'estimated' placeholder and a
                                      -- real, provider-sourced 'provider_estimate' rate. NULL until a real
                                      -- cost is actually computed for this runner (Part 24).
  last_heartbeat_at TEXT,            -- Part 18: updated by POST /v1/runner/heartbeat and implicitly by
                                      -- /register and /claim (a successful call from the runner IS a
                                      -- liveness signal, not just the dedicated heartbeat route)
  failure_reason TEXT                -- Part 19: set when a runner transitions to 'failed', human-readable,
                                      -- never a raw stack trace or secret value
);
CREATE INDEX IF NOT EXISTS idx_runners_org ON runners(organization_id);
CREATE INDEX IF NOT EXISTS idx_runners_status ON runners(status);

-- Part 12 (R1): short-lived, runner-scoped, job-scoped, single-use credential a real ephemeral runner
-- uses to authenticate to DiffCI's own control plane (distinct from the GitHub App installation token
-- used elsewhere for GitHub API calls, and distinct from the old shared, long-lived
-- RUNNER_CONTROL_TOKEN the synchronous Cloudflare Containers provider still uses for its own
-- control-plane-to-Worker call). Only the SHA-256 hash of the raw token is ever stored - same pattern
-- as src/auth/sessions.ts's hashSessionToken/generateSessionToken, reused rather than reinvented.
CREATE TABLE IF NOT EXISTS runner_tokens (
  id TEXT PRIMARY KEY,               -- UUID (crypto.randomUUID())
  runner_id TEXT NOT NULL REFERENCES runners(id),
  job_id TEXT NOT NULL,              -- execution_queue_items(id) this token is scoped to - a runner
                                      -- presenting this token can only ever claim THIS job, never another
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  claimed_at TEXT,                   -- set exactly once, on the first successful /v1/runner/claim - the
                                      -- single-use enforcement point; a second claim attempt with the same
                                      -- token is rejected (Part 28: "wrong job claim"/token replay)
  result_submitted_at TEXT,          -- set exactly once, on the first successful /v1/runner/result -
                                      -- rejects a duplicate result submission (Part 28: "duplicate result")
  revoked_at TEXT                    -- set if the runner/job is torn down before the token was ever used
                                      -- (e.g. provisioning timeout) - a revoked token can never be used
);
CREATE INDEX IF NOT EXISTS idx_runner_tokens_runner ON runner_tokens(runner_id);
