/**
 * Invoice persistence (Phase 05, 2026-08-26).
 *
 * Same tenancy discipline as src/ingest/store.ts, and for a stronger reason: this table holds money.
 * Every read, update and delete takes `organizationId` and puts it in the SQL, and
 * tests/ingest/tenancy.test.ts reads this file's own statements and fails any that does not.
 *
 * IMMUTABILITY. A draft can be recomputed as often as anyone likes. An ISSUED invoice cannot change:
 * `issue` is a conditional update that only fires while the row is still a draft, and there is no
 * method here that rewrites an issued invoice's amounts. To correct one, void it and issue another -
 * so the correction is visible rather than the original quietly becoming a different number.
 */
import type { EvidenceTier } from "../usage/economics-classification.js";
import type { InvoiceDraft, InvoiceLineDraft, InvoiceStatus } from "./metered.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface StoredInvoiceLine extends InvoiceLineDraft {
  id: string;
  invoiceId: string;
  organizationId: string;
  createdAt: string;
}

export interface StoredInvoice {
  id: string;
  organizationId: string;
  periodMonth: string;
  status: InvoiceStatus;
  currency: string;
  savingsSharePercent: number;
  netTestsAvoided: number;
  netSavingsUsdCents: number;
  totalUsdCents: number;
  evidenceTier: EvidenceTier;
  chargeable: boolean;
  notChargeableReason?: string;
  ledgerDigest: string;
  createdAt: string;
  issuedAt?: string;
  paidAt?: string;
  voidedAt?: string;
  provider?: string;
  providerInvoiceId?: string;
  paymentReference?: string;
  lines: StoredInvoiceLine[];
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToInvoice(row: Record<string, unknown>, lines: StoredInvoiceLine[]): StoredInvoice {
  const optional = (value: unknown): string | undefined => (value === null || value === undefined ? undefined : (value as string));
  return {
    id: row.id as string,
    organizationId: row.organization_id as string,
    periodMonth: row.period_month as string,
    status: row.status as InvoiceStatus,
    currency: row.currency as string,
    savingsSharePercent: Number(row.savings_share_percent),
    netTestsAvoided: Number(row.net_tests_avoided),
    netSavingsUsdCents: Number(row.net_savings_usd_cents),
    totalUsdCents: Number(row.total_usd_cents),
    evidenceTier: row.evidence_tier as EvidenceTier,
    chargeable: Boolean(row.chargeable),
    notChargeableReason: optional(row.not_chargeable_reason),
    ledgerDigest: row.ledger_digest as string,
    createdAt: row.created_at as string,
    issuedAt: optional(row.issued_at),
    paidAt: optional(row.paid_at),
    voidedAt: optional(row.voided_at),
    provider: optional(row.provider),
    providerInvoiceId: optional(row.provider_invoice_id),
    paymentReference: optional(row.payment_reference),
    lines,
  };
}

function rowToLine(row: Record<string, unknown>): StoredInvoiceLine {
  return {
    id: row.id as string,
    invoiceId: row.invoice_id as string,
    organizationId: row.organization_id as string,
    repositoryId: row.repository_id as string,
    description: row.description as string,
    quantity: Number(row.quantity),
    unit: row.unit as "net_tests_avoided",
    netSavingsUsdCents: Number(row.net_savings_usd_cents),
    amountUsdCents: Number(row.amount_usd_cents),
    evidenceTier: row.evidence_tier as EvidenceTier,
    chargeable: Boolean(row.chargeable),
    notChargeableReason: (row.not_chargeable_reason as string | null) ?? undefined,
    sourceReference: JSON.parse(row.source_reference as string) as InvoiceLineDraft["sourceReference"],
    createdAt: row.created_at as string,
  };
}

export interface InvoiceStore {
  /**
   * Saves a draft for a month, or returns the invoice that already exists for it. A month is invoiced
   * once: an already-issued or already-paid month is returned untouched, never re-priced.
   */
  createDraftIfAbsent(draft: InvoiceDraft): Promise<{ invoice: StoredInvoice; created: boolean }>;
  getForOrganization(organizationId: string, invoiceId: string): Promise<StoredInvoice | null>;
  getForPeriod(organizationId: string, periodMonth: string): Promise<StoredInvoice | null>;
  listForOrganization(organizationId: string, limit?: number): Promise<StoredInvoice[]>;
  /** Draft -> issued. Returns false if it was not a draft, so a double-issue is detectable, not silent. */
  issue(organizationId: string, invoiceId: string): Promise<boolean>;
  /** Issued -> paid. `reference` is whatever proves it: a provider id, a bank reference, a note. */
  markPaid(organizationId: string, invoiceId: string, reference: string): Promise<boolean>;
  /** Anything except paid -> void. The only way to retract an issued invoice. */
  voidInvoice(organizationId: string, invoiceId: string): Promise<boolean>;
  /** Erasure, for the same reasons observations have one. */
  deleteForOrganization(organizationId: string): Promise<number>;
}

export function makeD1InvoiceStore(db: D1Binding): InvoiceStore {
  async function linesFor(organizationId: string, invoiceId: string): Promise<StoredInvoiceLine[]> {
    const { results } = await db
      .prepare(`SELECT * FROM invoice_lines WHERE organization_id = ? AND invoice_id = ? ORDER BY created_at ASC, id ASC`)
      .bind(organizationId, invoiceId)
      .all<Record<string, unknown>>();
    return results.map(rowToLine);
  }

  async function loadByPeriod(organizationId: string, periodMonth: string): Promise<StoredInvoice | null> {
    const row = await db
      .prepare(`SELECT * FROM invoices WHERE organization_id = ? AND period_month = ?`)
      .bind(organizationId, periodMonth)
      .first<Record<string, unknown>>();
    return row ? rowToInvoice(row, await linesFor(organizationId, row.id as string)) : null;
  }

  return {
    async createDraftIfAbsent(draft) {
      const existing = await loadByPeriod(draft.organizationId, draft.periodMonth);
      if (existing) return { invoice: existing, created: false };

      const id = crypto.randomUUID();
      const createdAt = nowIso();
      const result = await db
        .prepare(
          `INSERT OR IGNORE INTO invoices (
             id, organization_id, period_month, status, currency, savings_share_percent, net_tests_avoided,
             net_savings_usd_cents, total_usd_cents, evidence_tier, chargeable, not_chargeable_reason,
             ledger_digest, created_at
           ) VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          draft.organizationId,
          draft.periodMonth,
          draft.currency,
          draft.savingsSharePercent,
          draft.netTestsAvoided,
          draft.netSavingsUsdCents,
          draft.totalUsdCents,
          draft.evidenceTier,
          draft.chargeable ? 1 : 0,
          draft.notChargeableReason ?? null,
          draft.ledgerDigest,
          createdAt,
        )
        .run();

      if ((result.meta?.changes ?? 0) === 0) {
        // Lost a race for the same month. The other writer's invoice is the one that exists.
        const raced = await loadByPeriod(draft.organizationId, draft.periodMonth);
        if (!raced) throw new Error("invoice insert was ignored but no invoice for that period is visible");
        return { invoice: raced, created: false };
      }

      for (const line of draft.lines) {
        await db
          .prepare(
            `INSERT INTO invoice_lines (
               id, invoice_id, organization_id, repository_id, description, quantity, unit,
               net_savings_usd_cents, amount_usd_cents, evidence_tier, chargeable, not_chargeable_reason,
               source_reference, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            crypto.randomUUID(),
            id,
            draft.organizationId,
            line.repositoryId,
            line.description,
            line.quantity,
            line.unit,
            line.netSavingsUsdCents,
            line.amountUsdCents,
            line.evidenceTier,
            line.chargeable ? 1 : 0,
            line.notChargeableReason ?? null,
            JSON.stringify(line.sourceReference),
            createdAt,
          )
          .run();
      }

      const stored = await loadByPeriod(draft.organizationId, draft.periodMonth);
      if (!stored) throw new Error("invoice was inserted but is not readable back");
      return { invoice: stored, created: true };
    },

    async getForOrganization(organizationId, invoiceId) {
      const row = await db
        .prepare(`SELECT * FROM invoices WHERE organization_id = ? AND id = ?`)
        .bind(organizationId, invoiceId)
        .first<Record<string, unknown>>();
      return row ? rowToInvoice(row, await linesFor(organizationId, invoiceId)) : null;
    },

    getForPeriod: loadByPeriod,

    async listForOrganization(organizationId, limit = 24) {
      const { results } = await db
        .prepare(`SELECT * FROM invoices WHERE organization_id = ? ORDER BY period_month DESC LIMIT ?`)
        .bind(organizationId, Math.max(1, Math.min(120, limit)))
        .all<Record<string, unknown>>();
      const invoices: StoredInvoice[] = [];
      for (const row of results) invoices.push(rowToInvoice(row, await linesFor(organizationId, row.id as string)));
      return invoices;
    },

    async issue(organizationId, invoiceId) {
      const result = await db
        .prepare(`UPDATE invoices SET issued_at = ?, status = 'issued' WHERE organization_id = ? AND id = ? AND status = 'draft'`)
        .bind(nowIso(), organizationId, invoiceId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async markPaid(organizationId, invoiceId, reference) {
      const result = await db
        .prepare(`UPDATE invoices SET paid_at = ?, payment_reference = ?, status = 'paid' WHERE organization_id = ? AND id = ? AND status = 'issued'`)
        .bind(nowIso(), reference, organizationId, invoiceId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async voidInvoice(organizationId, invoiceId) {
      const result = await db
        .prepare(`UPDATE invoices SET voided_at = ?, status = 'void' WHERE organization_id = ? AND id = ? AND status != 'paid'`)
        .bind(nowIso(), organizationId, invoiceId)
        .run();
      return (result.meta?.changes ?? 0) > 0;
    },

    async deleteForOrganization(organizationId) {
      await db.prepare(`DELETE FROM invoice_lines WHERE organization_id = ?`).bind(organizationId).run();
      const result = await db.prepare(`DELETE FROM invoices WHERE organization_id = ?`).bind(organizationId).run();
      return result.meta?.changes ?? 0;
    },
  };
}
