-- 2026-09-05: seamless installation - automatic, mechanical evidence-workflow identification, explicit
-- report states for every non-observing condition, per-repository report access, budget fairness.
--
-- Founder requirement: an install must need no intervention from the founder. The evidence standard
-- does not move (a workflow is evidence only when proven to be the work the prediction is about);
-- the proof is now produced by src/shadow/workflow-identification.ts from the repository's own
-- workflow files and package.json scripts, persisted here as the derivation, and checked against the
-- first executed run before any economics row is written. A founder-set configuration
-- (source 'explicit') is never overwritten by the automatic path.
--
-- Apply:
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-05-shadow-auto-identification.sql

-- 'explicit' (POST /v1/shadow/evidence-workflow or /stage-classification) | 'auto' (identification job).
ALTER TABLE shadow_repositories ADD COLUMN evidence_workflow_source TEXT;
-- JSON IdentificationDerivation - the evidence for the identification (every candidate workflow, why
-- it was chosen or excluded, the resolved commands). Persisted verbatim, never summarised.
ALTER TABLE shadow_repositories ADD COLUMN evidence_workflow_derivation TEXT;
-- 'identified' | 'verified' (a real executed run matched the derived shape) | 'none_found' |
-- 'shape_mismatch' | 'ineligible'. NULL = never attempted.
ALTER TABLE shadow_repositories ADD COLUMN identification_status TEXT;
ALTER TABLE shadow_repositories ADD COLUMN identification_checked_at TEXT;
-- Human-readable reason for none_found / shape_mismatch / ineligible - rendered on the report.
ALTER TABLE shadow_repositories ADD COLUMN identification_note TEXT;
-- Git tree SHA of .github/workflows at the last identification, so a workflow change re-derives.
ALTER TABLE shadow_repositories ADD COLUMN workflows_tree_sha TEXT;
-- Report access: a private repository's report is reachable only with its token (surfaced in the
-- signed-in dashboard); a public repository's report stays public by URL.
ALTER TABLE shadow_repositories ADD COLUMN is_private INTEGER;
ALTER TABLE shadow_repositories ADD COLUMN report_token TEXT;

-- The two hand-configured repositories keep their configuration and are labelled as such.
UPDATE shadow_repositories SET evidence_workflow_source = 'explicit' WHERE evidence_workflow_paths IS NOT NULL AND evidence_workflow_source IS NULL;
