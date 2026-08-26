-- External Shadow Pilot M2 (2026-08-26) - estimator v2, plus the raw inputs and audit trail a safe
-- recompute needs.
--
-- WHY v1 WAS WITHDRAWN. v1 estimated a commit's selected test workload from a CROSS-COMMIT historical
-- average seconds-per-test. Live evidence killed it: unjs/h3 commit b137cde2 is plan_mode FULL with
-- tests_selected_diffci = tests_total_full = 70 - DiffCI selected every single test and skipped nothing -
-- yet v1 reported 28s avoidable. History said 0.5s/test (from a commit where 70 tests took 35s); this
-- commit's same 70 tests actually took 63s, and v1 attributed the entire 28s difference to DiffCI. It was
-- measuring test-suite run-to-run variance and labelling it savings. A FULL plan cannot avoid work it
-- fully executed.
--
-- v2 anchors the counterfactual to THIS commit's own measured workload:
--   estimatedSelectedMs  = fullWorkloadMs * (testsSelected / testsTotal), clamped to [0, fullWorkloadMs]
--   estimatedAvoidableMs = max(0, fullWorkloadMs - estimatedSelectedMs)
-- FULL (ratio 1) therefore yields avoidable 0 by construction, with no special case, and another commit's
-- variance can no longer leak in. It remains a LINEAR-COST estimate: per-test cost is assumed uniform and
-- fixed per-invocation overhead (bootstrap, install, compile) is NOT modeled, so it OVERSTATES savings at
-- small selection ratios - a 1-of-70 run still pays the suite's startup cost. That refinement needs real
-- selected-run measurements before it can be honest, so the overhead term is deliberately not invented
-- here. The tier stays ESTIMATED forever; nothing in shadow mode can make it MEASURED.
--
-- tests_selected_diffci/plan_mode are added because they are RAW INPUTS to the estimate. Storing them
-- makes a recompute self-contained and auditable rather than dependent on re-joining shadow_predictions,
-- and they are facts about the prediction, never derived values - a recompute must never rewrite them.

ALTER TABLE shadow_economics_observations ADD COLUMN tests_selected_diffci INTEGER;
ALTER TABLE shadow_economics_observations ADD COLUMN plan_mode TEXT;
ALTER TABLE shadow_economics_observations ADD COLUMN estimator_version INTEGER;
ALTER TABLE shadow_economics_observations ADD COLUMN estimated_at TEXT;

-- Backfill the raw inputs for rows captured before these columns existed, from the authoritative source
-- (shadow_predictions, same database). Correlated subquery rather than UPDATE...FROM for SQLite
-- portability. Writes only to this table; shadow_predictions is read, never modified.
UPDATE shadow_economics_observations
SET tests_selected_diffci = (SELECT p.tests_selected_diffci FROM shadow_predictions p WHERE p.logical_delta_key = shadow_economics_observations.logical_delta_key)
WHERE tests_selected_diffci IS NULL;

UPDATE shadow_economics_observations
SET plan_mode = (SELECT p.plan_mode FROM shadow_predictions p WHERE p.logical_delta_key = shadow_economics_observations.logical_delta_key)
WHERE plan_mode IS NULL;

-- Every recompute writes one row here BEFORE mutating the observation, so a value that ever appeared in a
-- research or customer-facing report can always be reconstructed and explained. Append-only.
CREATE TABLE IF NOT EXISTS shadow_economics_recompute_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  logical_delta_key TEXT NOT NULL,
  stage TEXT NOT NULL,
  repository TEXT NOT NULL,
  reason TEXT NOT NULL, -- 'unknown_now_estimable' | 'estimator_version_upgrade'
  from_estimator_version INTEGER,
  to_estimator_version INTEGER NOT NULL,
  before_selected_workload_ms INTEGER,
  before_avoidable_ms INTEGER,
  before_avoidable_tier TEXT,
  after_selected_workload_ms INTEGER,
  after_avoidable_ms INTEGER,
  after_avoidable_tier TEXT,
  recomputed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_shadow_economics_audit_delta ON shadow_economics_recompute_audit(logical_delta_key, stage);
CREATE INDEX IF NOT EXISTS idx_shadow_economics_estimator_version ON shadow_economics_observations(estimator_version);
