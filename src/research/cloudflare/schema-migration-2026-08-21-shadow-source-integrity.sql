-- Shadow source-version integrity (2026-08-21 fix). Additive only - nothing here alters existing rows
-- or any Stage 0/1/2 table beyond adding these two nullable columns. See
-- src/research/cloudflare/shadow-source-integrity.ts for the invariant this supports and
-- docs/research/2026-08-21-shadow-source-integrity-fix.md for the full incident/fix writeup.
--
-- Apply with: wrangler d1 execute diffci-research --remote --file=src/research/cloudflare/schema-migration-2026-08-21-shadow-source-integrity.sql

-- Which exact DiffCI git commit produced this prediction, if known. NULL for every row inserted before
-- this fix (and for any future row whose caller genuinely doesn't know its source version, e.g. an
-- ad-hoc POST /v1/shadow/poll upload that didn't supply one) - NULL is preserved uncertainty, not
-- backfilled with a guess. See RecordPredictionInput.engineSourceSha / cloudflare-shadow-poll.ts's
-- --engine-source-sha argument for how a value gets here.
ALTER TABLE shadow_predictions ADD COLUMN engine_source_sha TEXT;

-- What computeSourceIntegrity() found before this cron run attempted to poll (CURRENT/STALE/MISSING/
-- UNKNOWN), or NULL when the run never reached a poll attempt at all (every candidate repository's head
-- was unchanged, so the source archive was never even consulted - see shadow-cron.ts). This is the
-- per-run audit trail; GET /v1/shadow/cron-status's `sourceIntegrity` field is the live, always-current
-- answer computed fresh on every call - the two are expected to usually agree, and a persistent
-- disagreement (e.g. cron runs recording STALE while the live status somehow reports CURRENT) would
-- itself be a bug worth investigating.
ALTER TABLE shadow_cron_runs ADD COLUMN source_integrity_status TEXT;
