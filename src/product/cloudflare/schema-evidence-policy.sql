-- Append-only organization reporting policy and its revision audit trail.
-- Apply before deploying the fleet dashboard. No research database writes.
CREATE TABLE IF NOT EXISTS organization_evidence_policies (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  revision INTEGER NOT NULL CHECK (revision > 0),
  policy_json TEXT NOT NULL,
  actor_user_id TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, revision)
);
