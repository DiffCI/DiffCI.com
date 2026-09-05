-- 2026-09-05: workflow identity for ground truth (measurement-integrity repair step 2, F2/F3 in
-- docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md).
--
-- Invariant: a GitHub workflow run is not ground truth merely because it is associated with the
-- predicted commit. It must first be proven to be the workflow the prediction is about. Until this
-- migration the reconciler took "any completed non-shadow run" - on DentalPresence.in that was the
-- instantly-skipped CodeQL run, finalised before the deploy/test run had finished, on every commit;
-- on DiffCI.com it merged the self-observation workflow's jobs into the CI evidence.
--
-- Apply (same shape as every earlier migration):
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-05-shadow-evidence-workflow.sql

-- JSON array of workflow file paths (".github/workflows/ci.yml"), EXPLICITLY configured per repository
-- (POST /v1/shadow/evidence-workflow, founder-operated). NULL = unconfigured: the reconciler records
-- every pending prediction as `evidence_workflow_unconfigured` and makes no GitHub call - nothing may
-- become ground truth for a repository whose evidence workflow nobody has identified.
ALTER TABLE shadow_repositories ADD COLUMN evidence_workflow_paths TEXT;

-- Which workflow file the ground-truth row's run belongs to - written by the identity-mode reconciler,
-- NULL on every row written before it existed.
ALTER TABLE shadow_ground_truth ADD COLUMN evidence_workflow_path TEXT;
-- 'VERIFIED'   - written under identity mode against the repository's configured evidence workflow.
-- 'UNVERIFIED' - written before identity mode; the run may or may not be the right workflow. Not
--                counted as evidence until re-checked (scripts/backfill-ground-truth-validity.ts).
-- 'CONTAMINATED_WORKFLOW_IDENTITY' - re-checked and found to be the wrong workflow, or a run that did
--                not execute (skipped/cancelled). Kept, never deleted, never counted.
ALTER TABLE shadow_ground_truth ADD COLUMN evidence_validity TEXT;
UPDATE shadow_ground_truth SET evidence_validity = 'UNVERIFIED' WHERE evidence_validity IS NULL;
