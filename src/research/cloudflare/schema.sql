-- Stage 0 D1 schema: the completed-deltas index and budget ledger for the Cloudflare-hosted run.
-- Not yet deployed - see diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md §2/§3
-- for the design this implements. R2 (via R2EvidenceStore, src/research/cloudflare/r2-store.ts)
-- remains the evidence-of-record for full BenchmarkRecord payloads; this schema is the fast, queryable
-- index and ledger layered on top of it, not a replacement for it.
--
-- Apply with: wrangler d1 execute diffci-research --file=src/research/cloudflare/schema.sql
-- (after `wrangler d1 database create diffci-research` and adding the resulting database_id to a real
-- wrangler.toml copied from wrangler.toml.example - neither has been run yet).

-- One row per experiment invocation, so a resumed run can find its own prior manifest/progress.
CREATE TABLE IF NOT EXISTS experiment_runs (
  experiment_id TEXT PRIMARY KEY,
  diffci_version TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  target_repositories INTEGER NOT NULL,
  target_commit_deltas INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RUNNING' CHECK (status IN ('RUNNING', 'COMPLETE', 'BUDGET_STOPPED', 'FAILED'))
);

-- One row per repository work unit (one Cloudflare Workflow instance each - see architecture doc §2).
-- Lets the orchestrator know which repositories are done/excluded/still running without re-reading R2.
CREATE TABLE IF NOT EXISTS repository_runs (
  experiment_id TEXT NOT NULL REFERENCES experiment_runs(experiment_id),
  repository TEXT NOT NULL, -- "owner/name"
  status TEXT NOT NULL CHECK (status IN ('PENDING', 'RUNNING', 'COMPLETE', 'EXCLUDED', 'FAILED', 'BUDGET_STOPPED')),
  exclusion_reason TEXT,
  commits_analyzed INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  completed_at TEXT,
  PRIMARY KEY (experiment_id, repository)
);

-- The resumability index: one row per successfully persisted delta. A rerun checks this table (a
-- single indexed lookup on the primary key) before re-running expensive analysis, exactly mirroring
-- what LocalEvidenceStore.exists()/get() already does locally (see src/research/benchmark/runner.ts's
-- resumability check) - same interface, same behavior, D1 just makes the existence check fast and
-- queryable at Cloudflare scale instead of one R2 GET per delta.
CREATE TABLE IF NOT EXISTS completed_deltas (
  logical_delta_key TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL REFERENCES experiment_runs(experiment_id),
  repository TEXT NOT NULL,
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  r2_evidence_key TEXT NOT NULL, -- the R2EvidenceStore key holding the full BenchmarkRecord
  fallback INTEGER NOT NULL, -- 0/1
  graph_confidence TEXT NOT NULL,
  completed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_completed_deltas_experiment ON completed_deltas(experiment_id);
CREATE INDEX IF NOT EXISTS idx_completed_deltas_repository ON completed_deltas(experiment_id, repository);

-- The budget ledger: one row appended per repository/batch completion, so cumulative spend can be
-- queried without re-summing every R2 record, and so the three-tier budget guard (see cost-model.ts)
-- has a durable, resumable running total that survives a crash/restart. measured_usd and estimated_usd
-- are kept separate here too - never collapse them into one column, per the measured-vs-estimated
-- distinction the Stage 0 spec requires.
CREATE TABLE IF NOT EXISTS budget_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  experiment_id TEXT NOT NULL REFERENCES experiment_runs(experiment_id),
  recorded_at TEXT NOT NULL,
  repository TEXT, -- null for experiment-level entries (e.g. final aggregation cost)
  measured_usd REAL NOT NULL DEFAULT 0,
  estimated_usd REAL NOT NULL DEFAULT 0,
  cumulative_measured_usd REAL NOT NULL,
  cumulative_estimated_usd REAL NOT NULL,
  budget_status TEXT NOT NULL CHECK (budget_status IN ('OK', 'WARNING', 'RESERVE', 'BUDGET_STOPPED')),
  note TEXT
);
CREATE INDEX IF NOT EXISTS idx_budget_ledger_experiment ON budget_ledger(experiment_id, recorded_at);
