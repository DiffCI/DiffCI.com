-- Billing schema, same diffci-product D1 database as src/product/cloudflare/schema.sql (applied second -
-- references organizations(id)). Kept in a separate file/directory from the account schema because the
-- billing module (src/billing/) is designed to be provider-swappable (Part 4/5) while the account model
-- (src/product/) is not billing-provider-specific.
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/billing/cloudflare/schema.sql

-- One row per (organization, billing provider) pair - `provider` is included from day one even though
-- Lemon Squeezy is the only implementation today, so a future second provider never needs a schema
-- migration to be representable (Part 5/Objective: "additional billing providers later without
-- rewriting entitlement logic").
CREATE TABLE IF NOT EXISTS billing_customers (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('lemonsqueezy')),
  provider_customer_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_customer_id),
  UNIQUE (organization_id, provider)
);

-- Local, authoritative-for-entitlements copy of subscription state - getEntitlements(organizationId)
-- (src/billing/entitlements.ts) reads ONLY this table, never calls the provider synchronously (Part 3).
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  provider TEXT NOT NULL CHECK (provider IN ('lemonsqueezy')),
  provider_subscription_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (
    'trialing', 'active', 'past_due', 'cancelled', 'expired', 'unpaid', 'paused'
  )),                             -- DiffCI's internal state machine (Part 8) - see src/billing/types.ts
                                    -- SubscriptionStatus for the provider-status -> internal-status mapping
  raw_provider_status TEXT NOT NULL, -- the provider's own status string, unmapped, for debugging/audit
  plan_id TEXT NOT NULL,           -- internal plan id (src/billing/plans.ts), never a raw variant id
  provider_variant_id TEXT NOT NULL,
  current_period_start TEXT,
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0, -- 0/1
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (provider, provider_subscription_id)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_org ON subscriptions(organization_id);

-- Durable webhook receipt log - the idempotency + audit + troubleshooting backbone for Part 7.
-- provider_event_id is Lemon Squeezy's own webhook delivery id when available (LS does not guarantee a
-- stable per-delivery id in the payload body the way GitHub does, so INSERT uses INSERT OR IGNORE keyed
-- on a computed idempotency key - see src/billing/webhooks.ts computeIdempotencyKey() - rather than
-- relying solely on provider_event_id being present and unique).
CREATE TABLE IF NOT EXISTS billing_events (
  id TEXT PRIMARY KEY,             -- UUID (crypto.randomUUID()), DiffCI's own row id
  idempotency_key TEXT NOT NULL UNIQUE, -- see src/billing/webhooks.ts computeIdempotencyKey()
  provider TEXT NOT NULL CHECK (provider IN ('lemonsqueezy')),
  provider_event_id TEXT,          -- best-effort, may be null - see comment above
  event_type TEXT NOT NULL,        -- e.g. 'subscription_created' - the provider's raw event name,
                                    -- deliberately not re-mapped, so an unrecognized future event type is
                                    -- still stored and visible rather than silently dropped
  organization_id TEXT REFERENCES organizations(id), -- resolved from meta.custom_data when possible
  received_at TEXT NOT NULL,
  processed_at TEXT,
  processing_status TEXT NOT NULL DEFAULT 'received' CHECK (processing_status IN (
    'received', 'processed', 'ignored_unrecognized_event', 'failed'
  )),
  error TEXT,
  payload_hash TEXT NOT NULL       -- SHA-256 of the raw body, NOT the raw payload itself - see Part 6
                                    -- ("Do not retain sensitive payload data unnecessarily"); enough to
                                    -- detect a byte-for-byte-identical redelivery for troubleshooting
                                    -- without storing customer PII/payment metadata at rest
);
CREATE INDEX IF NOT EXISTS idx_billing_events_org ON billing_events(organization_id, received_at);
CREATE INDEX IF NOT EXISTS idx_billing_events_status ON billing_events(processing_status);
