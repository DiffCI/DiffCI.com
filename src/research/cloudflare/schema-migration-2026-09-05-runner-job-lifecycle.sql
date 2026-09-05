-- 2026-09-05: durable lifecycle provenance for the ephemeral self-hosted runner fleet
-- (measurement-integrity repair step 4, F2 in docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md).
--
-- What the live tail on 2026-09-05 showed: the runner Worker started the whole runner lifecycle inside
-- the webhook's ctx.waitUntil(), which the runtime cancels ~30 s after the response - the container
-- kept running but the Worker never learned what happened (no "exec resolved" line ever appeared),
-- and a dispatch that failed to start (e.g. at the container application's 5-instance ceiling) left
-- no trace at all. And because every runner registered with the same two labels, GitHub handed each
-- new runner the OLDEST queued job: the runner spawned for job 101267766892 executed job
-- 101260055348. New work was starved by its own backlog.
--
-- Step 4 records every stage durably so a failure is attributable to GitHub scheduling, runner
-- provisioning, registration, assignment, execution or teardown - never "runner failed":
--   workflow queued -> dispatch requested -> token minted -> container started -> runner registered
--   -> job assigned (which job, which runner) -> execution completed -> runner disposition.
--
-- Apply (same shape as every earlier migration, same database as the shadow tables):
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-05-runner-job-lifecycle.sql

CREATE TABLE IF NOT EXISTS runner_job_lifecycle (
  job_id INTEGER PRIMARY KEY,           -- GitHub workflow_job id
  repository TEXT NOT NULL,             -- owner/name
  installation_id INTEGER NOT NULL,
  workflow_run_id INTEGER,
  workflow_name TEXT,
  job_name TEXT,
  labels TEXT NOT NULL DEFAULT '[]',    -- JSON array, the job's runs-on labels as delivered
  -- 1 when the labels carry a job-unique label (runs-on "diffci-job-<run id>-<job>"), so the runner
  -- registered for this job can only ever be assigned this job. 0 for legacy plain-label jobs (the
  -- backlog), which any plain-label runner may take - GitHub's oldest-first choice.
  pinned INTEGER NOT NULL DEFAULT 0,
  queued_at TEXT,                       -- workflow_job.queued delivery received
  dispatch_requested_at TEXT,           -- enqueued for the dispatch consumer
  dispatch_source TEXT,                 -- 'webhook' | 'reconcile'
  dispatch_attempts INTEGER NOT NULL DEFAULT 0,
  token_minted_at TEXT,
  container_started_at TEXT,            -- sandbox.exec() began
  runner_name TEXT,                     -- the runner THIS dispatch registered (cf-job-<id>)
  assigned_at TEXT,                     -- workflow_job.in_progress delivery received
  assigned_runner_name TEXT,            -- the runner GitHub actually assigned to THIS job (may differ from runner_name for unpinned jobs)
  execution_completed_at TEXT,          -- workflow_job.completed delivery received
  conclusion TEXT,                      -- success | failure | cancelled | skipped | ...
  -- What became of the runner this dispatch started, once sandbox.exec() resolved (or failed to start):
  -- 'exec-succeeded' | 'exec-failed' | 'exec-timeout' | 'start-failed' | 'capacity' | 'token-failed'
  disposition TEXT,
  disposition_at TEXT,
  error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_runner_job_lifecycle_repo ON runner_job_lifecycle(repository, queued_at);

-- Append-only stage trail behind the row above: one line per observed transition, never rewritten.
CREATE TABLE IF NOT EXISTS runner_job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id INTEGER NOT NULL,
  repository TEXT NOT NULL,
  at TEXT NOT NULL,
  stage TEXT NOT NULL,                  -- RunnerLifecycleStage in runner-dispatch.ts
  detail TEXT                           -- free text / JSON, e.g. the runner name or the error
);
CREATE INDEX IF NOT EXISTS idx_runner_job_events_job ON runner_job_events(job_id, id);
