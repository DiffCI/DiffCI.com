-- Metered invoices (Phase 05, 2026-08-26). Same diffci-product D1 database; applied after
-- src/product/cloudflare/schema.sql (references organizations(id), repositories(id)) and alongside the
-- subscription tables in this directory's schema.sql.
--
-- Apply with: wrangler d1 execute diffci-product --remote --file=src/billing/cloudflare/schema-metered-invoices.sql
--
-- WHY A SEPARATE FILE AND A SEPARATE MODEL. The tables in schema.sql describe a SUBSCRIPTION: a plan, a
-- variant, a recurring status machine driven by a provider's webhooks. DiffCI's stated pricing is not
-- that - it is a share of measured savings, which is metered after the fact from evidence DiffCI itself
-- produced. The two can coexist (a plan can gate features while metering prices outcomes), but merging
-- them would mean an invoice amount could come from a provider's idea of a period rather than from a
-- month of this product's own measurements.
--
-- MONEY IS INTEGER CENTS. Never a float, anywhere, at any layer. A rounding difference that would be
-- invisible in a chart is a reconciliation failure on an invoice.

CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY,                  -- UUID (crypto.randomUUID())
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  period_month TEXT NOT NULL,           -- "YYYY-MM", UTC, the ledger month this prices

  status TEXT NOT NULL CHECK (status IN ('draft', 'issued', 'paid', 'void')),
  currency TEXT NOT NULL DEFAULT 'USD',

  -- The pricing rule, stored ON the invoice rather than read from configuration at display time: an
  -- invoice must still explain itself after the price changes.
  savings_share_percent REAL NOT NULL,

  -- The basis. `net_tests_avoided` is the MEASURED count the month actually produced; the money columns
  -- are what that count was worth, and are only non-zero when the evidence supported a money figure.
  net_tests_avoided INTEGER NOT NULL,
  net_savings_usd_cents INTEGER NOT NULL DEFAULT 0,
  total_usd_cents INTEGER NOT NULL DEFAULT 0,

  -- MEASURED / ESTIMATED / UNKNOWN for the MONEY basis, not for the counts. An invoice may only carry a
  -- non-zero total when this is MEASURED - enforced in code (src/billing/metered.ts) and re-checked by
  -- reconciliation, because this is the one column whose meaning a future change could quietly erode.
  evidence_tier TEXT NOT NULL CHECK (evidence_tier IN ('MEASURED', 'ESTIMATED', 'UNKNOWN')),
  chargeable INTEGER NOT NULL DEFAULT 0, -- 0/1
  not_chargeable_reason TEXT,

  -- SHA-256 of the canonical ledger the invoice was computed from. Reconciliation recomputes the ledger
  -- and compares: a mismatch means the underlying observations changed after issuing (a deletion, a
  -- retention sweep, a late arrival), which must be visible rather than silently re-priced.
  ledger_digest TEXT NOT NULL,

  created_at TEXT NOT NULL,
  issued_at TEXT,
  paid_at TEXT,
  voided_at TEXT,

  -- Set only when a real payment provider is involved. Absent means DiffCI collected nothing.
  provider TEXT,
  provider_invoice_id TEXT,
  payment_reference TEXT,               -- free-form: what proves this was paid

  -- One invoice per organization per month. A second attempt returns the first.
  UNIQUE (organization_id, period_month)
);
CREATE INDEX IF NOT EXISTS idx_invoices_org_period ON invoices(organization_id, period_month);

-- One line per repository in the month. `organization_id` is denormalised for the same reason it is on
-- observations: tenant scoping is a predicate on the row being read, not a join a caller has to remember.
CREATE TABLE IF NOT EXISTS invoice_lines (
  id TEXT PRIMARY KEY,                  -- UUID (crypto.randomUUID())
  invoice_id TEXT NOT NULL REFERENCES invoices(id),
  organization_id TEXT NOT NULL REFERENCES organizations(id),
  repository_id TEXT NOT NULL REFERENCES repositories(id),

  description TEXT NOT NULL,
  -- The measured quantity this line prices: net test runs avoided against the path-rule comparator.
  -- May be NEGATIVE (DiffCI would have run more than the comparator); a negative line prices at zero and
  -- says so, rather than becoming a credit.
  quantity INTEGER NOT NULL,
  unit TEXT NOT NULL DEFAULT 'net_tests_avoided',

  net_savings_usd_cents INTEGER NOT NULL DEFAULT 0,
  amount_usd_cents INTEGER NOT NULL DEFAULT 0,

  evidence_tier TEXT NOT NULL CHECK (evidence_tier IN ('MEASURED', 'ESTIMATED', 'UNKNOWN')),
  chargeable INTEGER NOT NULL DEFAULT 0,
  not_chargeable_reason TEXT,

  -- Everything needed to recompute this one line from source: which observations, and how many.
  source_reference TEXT NOT NULL,       -- JSON: { repositoryId, month, comparableObservations }
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_invoice ON invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_invoice_lines_org ON invoice_lines(organization_id);
