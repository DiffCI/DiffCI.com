-- 2026-09-05: stage classification on admitted evidence only (measurement-integrity repair step 3,
-- F4 in docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md).
--
-- The legacy economics sweep re-fetched "any completed run" for every prediction, merged every
-- workflow's jobs, and bucketed them by a substring match on the job name. Three faults: no identity
-- (DiffCI.com's self-observation job was merged into its CI evidence), no admission (predictions with
-- contaminated or no ground truth were measured anyway), and a classifier that put DiffCI.com's
-- "check" job and DentalPresence.in's "Build and deploy ..." job in the wrong stage, so no row could
-- ever carry a test-stage figure.
--
-- Step 3 keeps the legacy table untouched (labelled, never rewritten) and writes admitted, classified
-- rows to a NEW table. Admission = the prediction's ground-truth row is evidence_validity 'VERIFIED';
-- the jobs come from THAT row's evidence run; classification = the repository's explicit
-- stage_classification config (job and step rules), with conservative inference only where no config
-- exists at all. Reports read the new table only.
--
-- Apply (same shape as every earlier migration):
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-05-shadow-stage-economics.sql

-- JSON, see src/shadow/stage-classification-config.ts StageClassificationConfig. NULL = no explicit
-- configuration (conservative inference only; a configured repository's unmatched jobs are 'other').
ALTER TABLE shadow_repositories ADD COLUMN stage_classification TEXT;

-- Legacy rows: labelled, kept, excluded from every report from now on.
ALTER TABLE shadow_economics_observations ADD COLUMN evidence_validity TEXT;
UPDATE shadow_economics_observations SET evidence_validity = 'LEGACY_UNVERIFIED' WHERE evidence_validity IS NULL;

CREATE TABLE IF NOT EXISTS shadow_stage_economics (
  logical_delta_key TEXT NOT NULL,
  stage TEXT NOT NULL CHECK (stage IN ('test', 'build', 'lint', 'typecheck', 'e2e', 'other')),
  -- How this stage's workload was attributed - src/shadow/stage-classification-config.ts ClassificationBasis:
  -- 'explicit_step' | 'explicit_step_inseparable' | 'explicit_job' | 'explicit_job_inseparable' |
  -- 'inferred_job' | 'unclassified'. An *_inseparable basis means the measured workload contains
  -- non-stage work that cannot be separated (e.g. `npm ci && npm test` in one step): the figure is real,
  -- but no avoidable-work estimate is derived from it (estimation_method 'inseparable_workload').
  classification_basis TEXT NOT NULL,
  classifier_version INTEGER NOT NULL,
  repository TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  -- Provenance: the VERIFIED ground-truth row's evidence run - the ONLY run whose jobs were read.
  evidence_run_id TEXT NOT NULL,
  evidence_workflow_path TEXT NOT NULL,
  evidence_validity TEXT NOT NULL CHECK (evidence_validity IN ('VERIFIED')),
  job_ids TEXT NOT NULL DEFAULT '[]',   -- JSON array of the run's job ids that fed this stage
  step_refs TEXT NOT NULL DEFAULT '[]', -- JSON array of "job name :: step name" for step-level attribution
  full_workload_ms INTEGER NOT NULL,    -- real, summed from GitHub's job/step timestamps, never estimated
  tests_total_full INTEGER,
  tests_selected_diffci INTEGER,
  tests_selected_path INTEGER,
  plan_mode TEXT,
  diffci_analysis_overhead_ms REAL,
  selected_workload_ms INTEGER,
  selected_workload_confidence TEXT,
  avoidable_ms INTEGER,
  avoidable_tier TEXT NOT NULL CHECK (avoidable_tier IN ('MEASURED', 'ESTIMATED', 'UNKNOWN')),
  estimation_method TEXT,
  estimator_version INTEGER,
  observed_at TEXT NOT NULL,
  PRIMARY KEY (logical_delta_key, stage)
);
CREATE INDEX IF NOT EXISTS idx_shadow_stage_economics_repo ON shadow_stage_economics(repository, observed_at);
