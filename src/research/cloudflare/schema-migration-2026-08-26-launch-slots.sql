-- Atomic daily analysis-launch accounting (External Shadow Pilot ramp, 2026-08-26).
--
-- The first ceiling counted SUCCESSES: it summed json_array_length(repos_polled), and a poll that failed
-- never entered repos_polled at all. vitest-dev/vitest proved the hole live - it clone-excluded on every
-- sweep, each time spinning a full standard-2 container and cloning the repository, while the ceiling
-- read 1/60. A deterministically ineligible repository could therefore burn ~144 container launches a day
-- entirely invisibly, which is the exact cost the ceiling exists to bound.
--
-- The invariant this table enforces: EVERY container launch consumes exactly one daily budget slot,
-- independent of its result. A slot is reserved immediately BEFORE the container starts and is never
-- refunded - not on clone-exclusion, timeout, crash, or any other failure. Work refused before a launch
-- consumes nothing.
--
-- PRIMARY KEY (day, slot_no) is what makes reservation atomic across overlapping sweeps: two sweeps that
-- both read a count of 59 will both try to insert slot 60, and exactly one wins. The loser retries against
-- a fresh count and is refused if the budget is genuinely spent, so concurrent sweeps can never together
-- exceed the ceiling.
CREATE TABLE IF NOT EXISTS shadow_analysis_launches (
  day TEXT NOT NULL,              -- UTC date, YYYY-MM-DD
  slot_no INTEGER NOT NULL,       -- 1..maxPollsPerDay
  repository TEXT NOT NULL,
  reserved_at TEXT NOT NULL,
  -- NULL until the launch finishes. 'succeeded' | 'failed'. Deliberately recorded AFTER the fact, so a
  -- crash that never reports back still leaves its slot consumed rather than silently freeing budget.
  outcome TEXT,
  PRIMARY KEY (day, slot_no)
);
CREATE INDEX IF NOT EXISTS idx_launches_day_repo ON shadow_analysis_launches(day, repository);
