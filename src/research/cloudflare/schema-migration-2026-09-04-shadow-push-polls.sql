-- 2026-09-04: durable record of every push-triggered (webhook) poll attempt.
--
-- Incident this closes (docs/research/2026-09-04-shadow-push-poll-lifetime.md): push-triggered polls
-- ran inside the webhook handler's ctx.waitUntil(), which the Workers runtime cancels 30 seconds after
-- the response is sent. A container poll only finishes that fast for a tiny repository on a warm
-- container, so DentalPresence.in was silently unobserved for 168 commits (last poll 2026-08-27) and
-- DiffCI.com lost the tail of its own history - and NOTHING durable recorded any of it, because the
-- webhook path logged to the Worker console only. Push-triggered polls now run from a Queue consumer
-- (validation-worker.ts queue()) and every attempt - started, finished, refused - lands here, so the
-- next gap is a D1 query away instead of a wrangler-tail session.
--
-- Apply (same shape as every earlier migration):
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-04-shadow-push-polls.sql

CREATE TABLE IF NOT EXISTS shadow_push_polls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('poll', 'ci-reproduction-bridge')),
  head_sha TEXT,                         -- the push payload's `after` SHA, when the delivery carried one
  enqueued_at TEXT NOT NULL,             -- when the webhook accepted the delivery
  started_at TEXT NOT NULL,              -- when the queue consumer picked it up
  -- NULL while the attempt is in flight. A row whose finished_at stays NULL for longer than any poll
  -- can run (shadow-push-poll.ts IN_FLIGHT_WINDOW_MS) is a consumer that died mid-poll - visible, not
  -- silent, and never treated as still running by the cron's in-flight check after that window.
  finished_at TEXT,
  -- 'succeeded' | 'failed' | 'refused-state' | 'refused-source' | 'refused-ceiling' | 'refused-unknown-repository'
  outcome TEXT,
  predictions_recorded INTEGER NOT NULL DEFAULT 0,
  slot_no INTEGER,                       -- shadow_analysis_launches slot consumed, when one was reserved
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_shadow_push_polls_repo_started ON shadow_push_polls(repository, started_at);
