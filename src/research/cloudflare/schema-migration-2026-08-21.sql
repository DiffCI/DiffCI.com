-- Full Stage 0 orchestrator additions (2026-08-21). Plain ADD COLUMN (not a CHECK-constraint change -
-- SQLite/D1 can't cheaply alter those without a full table rebuild) so this applies safely on top of
-- schema.sql's existing tables without touching any data already written by the medium batch.
--
-- Apply with: wrangler d1 execute diffci-research --remote --file=src/research/cloudflare/schema-migration-2026-08-21.sql

-- Safe STOP mechanism: an external caller sets this to 1 (via a dedicated endpoint) to request the
-- orchestrator halt cleanly - it's checked before scheduling any NEW repository work; already-dispatched
-- work in the current invocation is allowed to finish and checkpoint, per "prevent orchestration losing
-- completed work" and "expose a safe STOP mechanism".
ALTER TABLE experiment_runs ADD COLUMN stop_requested INTEGER NOT NULL DEFAULT 0;

-- Distinguishes transient (retry) from persistent (give up) repository failures across SEPARATE
-- orchestrator invocations - withContainerRetry already retries transient container failures within
-- one invocation (3 attempts), but a repository that fails on every fresh top-level orchestrator
-- dispatch needs its own giving-up threshold so the orchestrator doesn't retry it forever across
-- invocations, silently consuming budget without ever making progress.
ALTER TABLE repository_runs ADD COLUMN orchestrator_attempts INTEGER NOT NULL DEFAULT 0;
