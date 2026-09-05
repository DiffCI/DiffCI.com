-- 2026-09-05: explicit terminal state for predictions whose ground truth can never exist.
--
-- Incident this closes (docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md, F1):
-- findPendingPredictions ordered pending rows `created_at ASC LIMIT 10`, and DiffCI.com accumulated
-- exactly ten predictions whose head commit never had a workflow run (intermediate commits of
-- multi-commit pushes - GitHub runs CI for the push head only). Every 10-minute sweep re-attempted
-- those same ten rows, recorded `no_matching_workflow` again, and never reached anything newer: 249
-- predictions created after 2026-08-26 were never attempted and no ground truth was recorded for the
-- repository after 2026-08-23. The reconcile-diagnostics endpoint reported it the whole time.
--
-- The fix has two halves. (1) The pending window is now ordered never-attempted first, then least
-- recently attempted, so no single reason can monopolise it again. (2) A prediction whose ground
-- truth provably cannot exist is TERMINALISED here with an explicit reason - never silently dropped,
-- never converted by age alone (the Task 2 §11 rule stands). "Prediction made" and "ground truth
-- unavailable" remain two distinct facts on the same row. Terminalisation is a data change and is
-- reversible by a data change (NULL the three columns) if a run ever does appear for the commit.
--
-- Apply (same shape as every earlier migration):
--   npx wrangler d1 execute diffci-research --remote --config wrangler.research-sandbox.jsonc \
--     --file=src/research/cloudflare/schema-migration-2026-09-05-shadow-reconcile-terminal.sql

-- NULL = not terminal (the normal state). Otherwise one of the ReconcileTerminalReason values in
-- src/research/cloudflare/shadow-reconcile-terminal.ts - today only 'NO_MATCHING_WORKFLOW'. A row with
-- a non-NULL value is excluded from findPendingPredictions and counted under reconcile-diagnostics'
-- `terminalUnevaluable` (the field reserved for exactly this on 2026-08-21), never under `pending`.
ALTER TABLE shadow_predictions ADD COLUMN reconcile_terminal_reason TEXT;
ALTER TABLE shadow_predictions ADD COLUMN reconcile_terminal_at TEXT;
-- JSON: the evidence the decision was made on (prior attempt time/reason, prediction age, the
-- repository head that superseded this commit, and the direct GitHub `/actions/runs?head_sha=` count
-- that confirmed zero runs) - so the decision can be audited without re-deriving it.
ALTER TABLE shadow_predictions ADD COLUMN reconcile_terminal_detail TEXT;
