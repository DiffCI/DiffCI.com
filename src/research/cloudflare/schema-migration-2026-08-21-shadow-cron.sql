-- Stage 2 autonomous polling (2026-08-21): schema for the Cron Trigger runner (shadow-cron.ts).
-- Additive only - nothing here alters the Stage 0/1 tables or the existing Stage 2 shadow tables.
--
-- Apply with: wrangler d1 execute diffci-research --remote --file=src/research/cloudflare/schema-migration-2026-08-21-shadow-cron.sql

-- The cron runner polls repositories without a caller supplying per-request parameters, so the
-- repository row itself must carry the language that /v1/shadow/poll previously took from the request
-- form. Existing enrolled repositories (unjs/h3 era) were all polled as typescript, so the default is
-- also a correct backfill.
ALTER TABLE shadow_repositories ADD COLUMN language TEXT NOT NULL DEFAULT 'typescript';

-- One row per scheduled()/manual cron invocation - the audit trail that makes autonomous operation
-- verifiable after the fact (which runs happened, what they polled, what they skipped, what failed),
-- instead of observation volume silently accumulating or silently NOT accumulating.
CREATE TABLE IF NOT EXISTS shadow_cron_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('cron', 'manual')),
  repos_considered INTEGER NOT NULL,
  head_checks_skipped INTEGER NOT NULL,
  repos_polled TEXT NOT NULL,           -- JSON array of "owner/name"
  predictions_recorded INTEGER NOT NULL,
  repos_reconciled INTEGER NOT NULL,
  ground_truth_reconciled INTEGER NOT NULL,
  still_pending INTEGER NOT NULL,
  errors TEXT NOT NULL                  -- JSON array of strings
);
CREATE INDEX IF NOT EXISTS idx_shadow_cron_runs_started ON shadow_cron_runs(started_at);
