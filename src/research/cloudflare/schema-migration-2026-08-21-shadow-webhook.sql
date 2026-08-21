-- Stage 2 GitHub App webhook source (2026-08-21): the registered DiffCI Shadow App's installation id,
-- per repository. Additive only.
--
-- Apply with: wrangler d1 execute diffci-research --remote --file=src/research/cloudflare/schema-migration-2026-08-21-shadow-webhook.sql

-- The key for minting per-installation read tokens (github-app.ts exchangeInstallationToken):
-- recorded from installation/installation_repositories/push webhook payloads (shadow-webhook.ts).
-- NULL means "no App installation known" - reconciliation then falls back to GITHUB_TOKEN exactly as
-- before, so public-repo polling keeps working for repositories observed without an App install.
ALTER TABLE shadow_repositories ADD COLUMN installation_id TEXT;
