-- Installation claiming and webhook delivery de-duplication (B3 + replay dedup, 2026-08-27).
-- Applied to the diffci-product D1 database, after src/product/cloudflare/schema.sql (organizations,
-- users) and src/ingest/cloudflare/schema.sql. Idempotent, like every other file in the migration list.

-- ---------------------------------------------------------------------------------------------------
-- pending_installations
--
-- WHY THIS EXISTS. Before this table, the ONLY way an App installation reached DiffCI was the console
-- flow: sign in -> /app/install -> GitHub -> /app/install/callback carrying a server-generated,
-- single-use state. Anyone who instead installed from GitHub's own App page - which is what the App's
-- public URL offers, and what most people click first - produced an `installation.created` webhook that
-- was silently ignored, and then landed on a setup URL with no state to consume. They were stranded
-- with no error and no route forward.
--
-- The fix is NOT to attribute the installation from the webhook. The webhook does not say which DiffCI
-- organization it belongs to, and the sender is a GitHub identity, not an authenticated session with a
-- chosen tenant. Guessing would be exactly the cross-tenant mistake the rest of Phase 03 is built to
-- prevent. So the delivery is PARKED here, unattributed, and claimed later by a signed-in user who
-- proves two things the webhook cannot: that they are the GitHub account that performed the install,
-- and that they are a member of the organization they want it attached to.
CREATE TABLE IF NOT EXISTS pending_installations (
  installation_id       TEXT PRIMARY KEY,
  -- The GitHub account the App was installed ON (org or user login). Display only.
  account_login         TEXT,
  -- GitHub's numeric user id of whoever performed the install, as a string. This is the authorization
  -- anchor: a claim is only permitted by a signed-in user whose linked GitHub identity equals this.
  -- Nullable because a delivery without a sender is recorded rather than dropped, but such a row can
  -- never be claimed (a NULL never equals a provider id), which is the correct fail-closed outcome.
  sender_provider_user_id TEXT,
  -- How many repositories the installation reported at creation time. Display only; the authoritative
  -- list is re-fetched from GitHub at claim time with an installation token.
  repository_count      INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL,
  -- Set when a user successfully claims it. Retained rather than deleted so a second callback for the
  -- same installation is answered "already claimed" instead of "unknown installation".
  claimed_at            TEXT,
  claimed_by_user_id    TEXT,
  claimed_organization_id TEXT,
  FOREIGN KEY (claimed_by_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (claimed_organization_id) REFERENCES organizations(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_installations_sender
  ON pending_installations (sender_provider_user_id, claimed_at);

-- ---------------------------------------------------------------------------------------------------
-- webhook_deliveries
--
-- Replay/duplicate de-duplication. GitHub retries a delivery that did not get a timely 2xx, and the
-- same delivery can also be redelivered manually from the App's settings page at any time, months
-- later. One handler here ERASES DATA (`installation.deleted` drops every observation and revokes every
-- ingest credential for that installation), so "process it twice" is not a cosmetic concern.
--
-- The row is claimed BEFORE the work runs, not after. That ordering is what makes it safe against two
-- concurrent deliveries of the same id: the second one loses the INSERT race and is refused rather than
-- racing the first into a double erase.
--
-- `status` exists so that ordering does not silently swallow real failures. A delivery that crashed
-- mid-processing is left `processing`; a delivery whose handler returned an error is marked `failed`
-- and IS eligible to be retried by GitHub. Only `completed` and `processing` suppress reprocessing -
-- the latter deliberately, because for a destructive handler the safe answer to "is the first attempt
-- still running or did it die?" is to refuse, not to guess and erase again.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  -- GitHub's X-GitHub-Delivery header: a UUID, unique per delivery attempt-group.
  delivery_id   TEXT PRIMARY KEY,
  event         TEXT NOT NULL,
  action        TEXT,
  status        TEXT NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
  received_at   TEXT NOT NULL,
  completed_at  TEXT,
  -- Short, non-sensitive outcome summary for operators. Never contains payload bodies or credentials.
  result        TEXT
);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received
  ON webhook_deliveries (received_at);
