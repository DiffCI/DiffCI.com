-- YC readiness Week 2 (2026-09-03) - the incremental-economics comparator: every pilot report should
-- compare DiffCI against the path-rule baseline, not merely against FULL. Both raw inputs it needs
-- (tests_selected_path, diffci_analysis_overhead_ms) already exist on shadow_predictions - computed by
-- the poll container for every prediction, ever - just not previously read by the product/usage layer.
-- Same additive ALTER + backfill pattern as
-- schema-migration-2026-08-26-shadow-economics-estimator-v2.sql's tests_selected_diffci/plan_mode.
--
-- Apply with: wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc --file=src/research/cloudflare/schema-migration-2026-09-03-shadow-economics-path-comparator.sql

ALTER TABLE shadow_economics_observations ADD COLUMN tests_selected_path INTEGER;
ALTER TABLE shadow_economics_observations ADD COLUMN diffci_analysis_overhead_ms REAL;

-- Backfill from shadow_predictions (same database, authoritative source) so every historical row this
-- pilot already produced gains comparator data immediately, not only rows captured going forward.
UPDATE shadow_economics_observations
SET tests_selected_path = (SELECT p.tests_selected_path FROM shadow_predictions p WHERE p.logical_delta_key = shadow_economics_observations.logical_delta_key)
WHERE tests_selected_path IS NULL AND stage = 'test';

UPDATE shadow_economics_observations
SET diffci_analysis_overhead_ms = (SELECT p.diffci_analysis_overhead_ms FROM shadow_predictions p WHERE p.logical_delta_key = shadow_economics_observations.logical_delta_key)
WHERE diffci_analysis_overhead_ms IS NULL AND stage = 'test';
