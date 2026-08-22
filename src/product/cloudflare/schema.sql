-- DiffCI product control-plane schema. Deliberately a SEPARATE D1 database (diffci-product) from the
-- research/shadow database (diffci-research, src/research/cloudflare/schema*.sql) - Stage 2F's frozen
-- observation window must not share write surface with product/billing code under active development.
-- See docs/research/2026-08-22-stage2f-*.md and docs/product/2026-08-22-product-foundation-architecture.md.
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/product/cloudflare/schema.sql

-- One row per human. Deliberately minimal - do not store more identity than necessary (Part 2).
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID()), generated at signup
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- One row per billing/tenant boundary. `current_plan` is an internal plan id (see src/billing/plans.ts),
-- never a raw Lemon Squeezy variant id - variant<->plan mapping lives server-side only (Part 9).
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID())
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  billing_status TEXT NOT NULL DEFAULT 'none' CHECK (billing_status IN (
    'none', 'trialing', 'active', 'past_due', 'cancelled', 'expired'
  )),
  billing_customer_reference TEXT, -- billing_customers.id, nullable until a checkout completes
  current_plan TEXT NOT NULL DEFAULT 'free', -- internal plan id, see src/billing/plans.ts PLAN_IDS
  subscription_status TEXT        -- raw provider-reported status, kept alongside billing_status
                                    -- (the internal mapping) for debugging - see src/billing/types.ts
);

-- Deliberately no separate roles table yet (Part 2: "avoid designing a huge RBAC system yet") - role is a
-- plain CHECK'd column on the membership row itself.
CREATE TABLE IF NOT EXISTS organization_members (
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_org_members_user ON organization_members(user_id);

-- Product-level repository record - an internal DiffCI model, deliberately NOT a mirror of GitHub's
-- repository payload (Part 2) and deliberately a DIFFERENT table from shadow_repositories (which is
-- research/Stage-2-owned, keyed globally by "owner/name" with no org concept - see the architecture
-- audit). `provider_repository_id` is GitHub's own numeric id (stable across renames); `owner_name` is
-- "owner/name" purely for display/lookup and MAY become stale on a GitHub-side rename.
CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL DEFAULT 'github' CHECK (provider IN ('github')),
  provider_repository_id TEXT NOT NULL,
  owner_name TEXT NOT NULL,        -- "owner/name", display/lookup convenience, not the identity key
  default_branch TEXT NOT NULL DEFAULT 'main',
  installation_id TEXT,            -- GitHub App installation id (nullable until the App is installed)
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'paused', 'removed')),
  shadow_enabled INTEGER NOT NULL DEFAULT 0, -- 0/1 - whether this repo is also enrolled in the SEPARATE
                                              -- shadow_repositories table; this column is a pointer/flag
                                              -- only, never a copy of shadow state
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_repository_id)
);
CREATE INDEX IF NOT EXISTS idx_repositories_org ON repositories(organization_id);

-- Every important account/billing side effect, append-only. Part 19. Never logs secrets/tokens/raw
-- authorization headers - only structured, already-redacted metadata.
CREATE TABLE IF NOT EXISTS audit_log (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID())
  organization_id TEXT REFERENCES organizations(id), -- nullable: some events (e.g. user signup) precede org membership
  actor_user_id TEXT REFERENCES users(id),
  action TEXT NOT NULL,            -- e.g. 'organization.created', 'repository.enrolled', 'subscription.changed'
  target_type TEXT,                -- e.g. 'repository', 'subscription', 'member'
  target_id TEXT,
  metadata TEXT,                   -- JSON, already scrubbed of secrets before insertion
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_log_org ON audit_log(organization_id, created_at);
