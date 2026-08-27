-- Ingest schema (Phase 03, 2026-08-26). Same diffci-product D1 database; applied after
-- src/product/cloudflare/schema.sql (references organizations(id), repositories(id), users(id)).
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/ingest/cloudflare/schema.sql
--
-- WHAT THIS IS FOR. Phase 02 produces an observation report on somebody else's runner. These two tables
-- are where such a report is allowed to land, and the credential that decides whose it is. Every other
-- tenancy control in this codebase (session -> membership -> organization) presumes a human behind a
-- browser; a report arrives from a CI job with no human, no session, and no cookie, so the only thing
-- that can establish identity is the token it carries.

-- One row per issued ingest credential. Scoped to ONE repository, not to an organization: a token that
-- could write for any repository in an organization would make "which repository sent this" a claim made
-- by the sender rather than a fact about the credential. Only the SHA-256 hash of the raw token is ever
-- stored - same primitive as src/auth/sessions.ts and src/runner/token.ts, reused rather than reinvented.
CREATE TABLE IF NOT EXISTS ingest_tokens (
  id TEXT PRIMARY KEY,                  -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  token_hash TEXT NOT NULL UNIQUE,      -- SHA-256 hex of the raw token; the raw token is shown once
  token_prefix TEXT NOT NULL,           -- first characters of the raw token, for display only ("dci_a1b2c3d4...")
  name TEXT,                            -- human label, e.g. "unjs/h3 CI"
  created_at TEXT NOT NULL,
  created_by_user_id TEXT REFERENCES users(id),
  last_used_at TEXT,                    -- updated on every accepted ingest; the only way an owner can
                                        -- see that a credential is live without reading logs
  revoked_at TEXT,
  expires_at TEXT                       -- nullable: a CI credential that silently expires mid-window
                                        -- would look like DiffCI breaking, so expiry is opt-in
);
CREATE INDEX IF NOT EXISTS idx_ingest_tokens_repo ON ingest_tokens(repository_id);
CREATE INDEX IF NOT EXISTS idx_ingest_tokens_org ON ingest_tokens(organization_id);

-- One row per accepted observation report.
--
-- organization_id is denormalised onto the row deliberately, even though it is derivable through
-- repository_id. Every read path filters on it directly, so tenant scoping is a predicate on the row
-- being read rather than a join the caller has to remember to write - and a query that forgot it is
-- visible as a missing WHERE clause instead of a missing JOIN condition (tests/ingest/tenancy.test.ts
-- enforces exactly that, by reading this module's own SQL).
--
-- report_json holds the document as received. The queryable columns beside it are derived from that
-- same document at insert time and exist so a month of reports can be counted without parsing JSON in
-- SQL; if they ever disagree with report_json, report_json is the record.
CREATE TABLE IF NOT EXISTS observations (
  id TEXT PRIMARY KEY,                  -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),

  -- The ONLY thing preventing double-counting when GitHub re-runs a job or the client retries a send.
  -- UNIQUE at the database layer, not merely checked in application code - same discipline as
  -- usage_events.idempotency_key.
  idempotency_key TEXT NOT NULL UNIQUE,

  schema_version TEXT NOT NULL,         -- e.g. "diffci.observation.v1"
  status TEXT NOT NULL CHECK (status IN ('OBSERVED', 'REFUSED', 'ERROR')),
  stage TEXT NOT NULL,                  -- where it stopped: context/eligibility/delta/graph/impact/command/complete
  refusal_reason TEXT,                  -- present for REFUSED/ERROR

  mode TEXT CHECK (mode IN ('SELECTIVE', 'FULL')), -- NULL unless status = 'OBSERVED'
  base_sha TEXT,
  head_sha TEXT,
  range_source TEXT,                    -- pull-request-event / push-event / head-parent / explicit-flags

  ci_run_id TEXT,
  ci_run_attempt TEXT,
  ci_event TEXT,
  ci_workflow TEXT,
  ci_job TEXT,

  changed_file_count INTEGER,
  selected_test_count INTEGER,
  total_test_count INTEGER,
  -- The comparator DiffCI's savings are measured against, carried per observation so no later ledger
  -- can quietly substitute "the whole suite" for it (Phase 01's finding).
  baseline_mode TEXT CHECK (baseline_mode IN ('SELECTIVE', 'FULL')),
  baseline_selected_test_count INTEGER,

  blind_spot INTEGER NOT NULL DEFAULT 0,             -- declared a framework, discovered no tests
  worktree_unchanged INTEGER NOT NULL DEFAULT 0,     -- the observer's own byte-identity evidence
  blocking_workflow_findings INTEGER NOT NULL DEFAULT 0,
  paths_redacted INTEGER NOT NULL DEFAULT 0,

  -- Whether the repository the report claims to be from matched the repository the token is scoped to.
  -- A report whose claim CONTRADICTS the token is rejected outright and never reaches this table; 0
  -- here means the report made no verifiable claim (a local run, no CI environment), not that a
  -- mismatch was tolerated.
  identity_verified INTEGER NOT NULL DEFAULT 0,

  observer_version TEXT,
  engine_sha TEXT,
  produced_at TEXT NOT NULL,            -- when the observer produced it, on their runner
  received_at TEXT NOT NULL,            -- when DiffCI accepted it
  report_bytes INTEGER NOT NULL,
  report_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_observations_org_time ON observations(organization_id, received_at);
CREATE INDEX IF NOT EXISTS idx_observations_repo_time ON observations(repository_id, received_at);
CREATE INDEX IF NOT EXISTS idx_observations_org_status ON observations(organization_id, status, received_at);
