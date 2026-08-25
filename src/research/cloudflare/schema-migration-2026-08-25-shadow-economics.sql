-- External Shadow Pilot M1 (2026-08-25) - shadow_economics_observations.
--
-- Lives in diffci-research, NOT diffci-product. First built against diffci-product and moved here the
-- same day, for a reason worth recording: the capture sweep must make authenticated GitHub API calls,
-- and the GitHub credentials (GITHUB_TOKEN, SHADOW_GITHUB_APP_ID/PRIVATE_KEY) exist only on the
-- research-sandbox Worker. Proven live: the product Worker holds no GitHub secret at all, so every
-- fetchBaselineEvidence call it made was unauthenticated - 60 req/hour against a Cloudflare egress IP
-- shared across tenants, i.e. permanently exhausted. A whole sweep reported skippedFetchError:5 while
-- the identical calls succeeded from a laptop. The alternative (copy the App private key into the
-- internet-facing product Worker) was rejected deliberately: that key can mint tokens for every
-- installed repository, and duplicating it to widen a reporting path is a bad trade.
--
-- Being in the same database as shadow_predictions, logical_delta_key is now correlatable directly
-- rather than across a database boundary. Deliberately still a plain TEXT column and NOT a real foreign
-- key: INSERT OR IGNORE does not reliably swallow foreign-key violations the way it swallows PK
-- conflicts, so an FK would convert "this prediction was pruned" from a harmless skip into a sweep
-- error. Correlated by value, exactly as it was when the two tables genuinely could not reference each
-- other.
--
-- One row per (prediction, CI stage) - a single commit's workflow can (and usually does) span multiple
-- stages (test/build/lint/typecheck/e2e/other, see src/shadow/stage-classification.ts), and each stage's
-- workload/opportunity must be classified independently. A stage present in the real workflow but which
-- DiffCI cannot yet classify (v1: everything except 'test') still gets a row, with full_workload_ms real
-- (summed from real job durations) but selected_workload_ms/avoidable_ms left NULL and avoidable_tier
-- 'UNKNOWN' - an omitted row would read as "no such stage exists"; an explicit UNKNOWN row reads as
-- "DiffCI saw it and cannot classify it yet", the honest state.
--
-- Apply with: wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc --file=src/research/cloudflare/schema-migration-2026-08-25-shadow-economics.sql

CREATE TABLE IF NOT EXISTS shadow_economics_observations (
  logical_delta_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('test', 'build', 'lint', 'typecheck', 'e2e', 'other')),
  repository TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  workflow_run_ids TEXT NOT NULL DEFAULT '[]', -- JSON array, real GitHub Actions workflow_run ids (audit provenance)
  job_ids TEXT NOT NULL DEFAULT '[]', -- JSON array, real GitHub Actions job ids that fed this stage's bucket
  -- Real, MEASURED consumption for this stage - summed from real job start/end timestamps
  -- (fetchBaselineEvidence -> BaselineJobInfo.durationMs, bucketed by classifyJobStage). Never estimated.
  full_workload_ms INTEGER NOT NULL,
  -- Only meaningful for stage = 'test' in v1 - the engine has no build/lint/typecheck/e2e test-count
  -- concept yet. NULL for every other stage, not zero (zero would misreport "DiffCI knows this stage has
  -- no avoidable work" when the truth is "DiffCI cannot evaluate this stage at all").
  tests_total_full INTEGER,
  selected_workload_ms INTEGER,
  -- SavingsConfidence value ('measured' | 'historical_estimate' | 'count_based_estimate' | 'unavailable')
  -- - NEVER 'measured' for selected_workload_ms in pure shadow mode: DiffCI's own selected subset is never
  -- independently executed to measure it. See src/usage/economics-classification.ts's own doc comment.
  selected_workload_confidence TEXT,
  avoidable_ms INTEGER,
  -- The report-facing 3-tier vocabulary ('MEASURED' | 'ESTIMATED' | 'UNKNOWN') - the WEAKER of
  -- full_workload's and selected_workload's own tiers, per combineForAvoidable. Since selected_workload
  -- is never 'measured' in shadow mode, avoidable_tier can only reach 'MEASURED' in the activation phase,
  -- never here.
  avoidable_tier TEXT NOT NULL CHECK (avoidable_tier IN ('MEASURED', 'ESTIMATED', 'UNKNOWN')),
  -- Non-null only when avoidable_tier = 'ESTIMATED' - names the estimation method, e.g.
  -- 'historical_avg_seconds_per_test_n12'. Never populated by hand; always derived from the same
  -- computation that produced selected_workload_confidence.
  estimation_method TEXT,
  schema_version INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (logical_delta_key, stage)
);
CREATE INDEX IF NOT EXISTS idx_shadow_economics_repository ON shadow_economics_observations(repository, observed_at);
CREATE INDEX IF NOT EXISTS idx_shadow_economics_stage ON shadow_economics_observations(stage);
