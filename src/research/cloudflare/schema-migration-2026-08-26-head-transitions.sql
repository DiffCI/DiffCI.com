-- Append-only log of every observed default-branch head transition (External Shadow Pilot ramp,
-- 2026-08-26).
--
-- shadow_repositories.last_observed_head_sha is OVERWRITTEN STATE: it answers "what is the head now?" and
-- destroys the answer to "what did the head used to be?". Missed-intermediate-commit measurement needs the
-- SEQUENCE of heads DiffCI observed, so that a GitHub compare between consecutive observed heads can later
-- count the commits that landed between two sweeps and were therefore never analysed individually.
--
-- Recorded now, derived later. The compare calls are deliberately NOT made during the 24-hour load-gate
-- window: adding live API calls after the gate was predeclared would change the very workload the gate is
-- measuring. If this table turns out not to retain a usable transition sequence, the metric must be
-- reported as UNAVAILABLE rather than reconstructed from overwritten state.
CREATE TABLE IF NOT EXISTS shadow_head_transitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repository TEXT NOT NULL,
  from_sha TEXT,               -- NULL on the first head ever observed for a repository
  to_sha TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  -- Whether this transition was actually handed to an analysis container, or deferred because the daily
  -- launch ceiling was already spent. A deferred transition is still a real observation.
  analysed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_head_transitions_repo ON shadow_head_transitions(repository, detected_at);
