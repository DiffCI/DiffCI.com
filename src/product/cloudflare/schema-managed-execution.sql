-- Append-only, explicit consent for managed repository verification. Reporting policy cannot enable
-- execution; only an owner/admin revision in this table can move a repository out of observation-only.
CREATE TABLE IF NOT EXISTS repository_execution_consents (
  repository_id TEXT NOT NULL REFERENCES repositories(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  mode TEXT NOT NULL CHECK (mode IN ('observation_only', 'verification')),
  max_duration_seconds INTEGER NOT NULL CHECK (max_duration_seconds BETWEEN 60 AND 3600),
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (repository_id, revision)
);
CREATE INDEX IF NOT EXISTS idx_execution_consents_org_repo
  ON repository_execution_consents(organization_id, repository_id, revision DESC);
