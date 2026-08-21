-- Reconciliation observability (Task 2, 2026-08-21): lets GET /v1/shadow/reconcile-diagnostics answer
-- "why is this prediction still pending" and "how old is the oldest pending prediction" without
-- re-fetching from GitHub. Additive only.
--
-- Apply with: wrangler d1 execute diffci-research --remote --file=src/research/cloudflare/schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql

-- Updated on EVERY reconciliation attempt for a prediction that came back STILL_PENDING (never on
-- RECONCILED - once a shadow_ground_truth row exists, a prediction no longer appears in
-- findPendingPredictions at all, so these columns simply stop changing, which is fine: they only need
-- to answer "why is this STILL pending", a question that stops applying the moment it isn't). NULL means
-- "no reconcile attempt has happened yet" (a genuinely fresh prediction), distinct from a real attempt
-- that found nothing - never conflated.
ALTER TABLE shadow_predictions ADD COLUMN last_reconcile_attempted_at TEXT;
-- One of: no_matching_workflow | ci_queued | ci_in_progress | github_rate_limit | fetch_error
-- (src/shadow/reconcile.ts ReconcileResult.pendingReason) - the classification from the MOST RECENT
-- attempt only; older attempts' reasons are not retained (this is a live diagnostic, not an audit log -
-- shadow_cron_runs already provides the per-run audit trail).
ALTER TABLE shadow_predictions ADD COLUMN last_reconcile_reason TEXT;
