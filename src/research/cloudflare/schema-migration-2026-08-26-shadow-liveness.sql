-- Shadow liveness facts, per repository (External Shadow Pilot M3.2, 2026-08-26).
--
-- Exists because "DiffCI is broken" and "this repository is quiet" were indistinguishable from the data
-- we stored, and that ambiguity produced a real misdiagnosis: last_polled_at for unjs/h3 sat five days
-- stale and was read as a five-day outage. The cron had actually run 144 times a day throughout with zero
-- errors. last_polled_at only advances on an ACTUAL analysis poll; a head check that skips an unchanged
-- repository never touches it, so it is the wrong fact to judge liveness by.
--
-- last_head_check_at is therefore the liveness clock (a skip still counts as DiffCI doing its job), while
-- last_poll_success_at records analysis progress. Separating them is the entire point.
--
-- Note for the record: source integrity did NOT detect that ambiguity and is not credited with it here.
-- It was never consulted during head-check-only sweeps and was never observed non-CURRENT. The invariant
-- is kept because it is worth keeping, not because it caught this.

ALTER TABLE shadow_repositories ADD COLUMN last_head_check_at TEXT;
ALTER TABLE shadow_repositories ADD COLUMN last_head_changed_at TEXT;
ALTER TABLE shadow_repositories ADD COLUMN last_poll_attempt_at TEXT;
ALTER TABLE shadow_repositories ADD COLUMN last_poll_success_at TEXT;
ALTER TABLE shadow_repositories ADD COLUMN consecutive_head_check_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE shadow_repositories ADD COLUMN consecutive_poll_errors INTEGER NOT NULL DEFAULT 0;

-- Seed from what is already known, so liveness is not reported as "never checked" for repositories that
-- have in fact been observed for days. last_polled_at is a genuine past analysis success, so it seeds both
-- the attempt and success clocks; it is deliberately NOT used to seed last_head_check_at, because that
-- would re-import the very conflation this migration exists to end - the next sweep sets it correctly.
UPDATE shadow_repositories SET last_poll_attempt_at = last_polled_at WHERE last_poll_attempt_at IS NULL AND last_polled_at IS NOT NULL;
UPDATE shadow_repositories SET last_poll_success_at = last_polled_at WHERE last_poll_success_at IS NULL AND last_polled_at IS NOT NULL;
ALTER TABLE shadow_repositories ADD COLUMN last_observed_head_sha TEXT;
