/**
 * Metered invoicing: pricing a month of measured savings (Phase 05, 2026-08-26).
 *
 * DiffCI's stated price is a share of what it saved. That sentence contains the whole difficulty: a
 * share of a number DiffCI itself produced, about work that was never done, measured against a
 * counterfactual. Every safeguard in this file exists because that is an unusually easy thing to get
 * quietly wrong in the seller's favour.
 *
 * THE RULES, in the order they bind:
 *
 *   1. ONLY MEASURED MONEY IS CHARGEABLE. A line prices at zero unless its money basis is MEASURED.
 *      ESTIMATED is not "nearly measured" - it is a model, and a model is not an invoice. Today no
 *      client-observed repository can reach MEASURED (the selected side is never executed, so its
 *      duration is never measured), so today every invoice this module produces totals zero and says
 *      why. That is the correct output, not a placeholder for one.
 *   2. A NEGATIVE MONTH BILLS ZERO, NEVER A CREDIT. Where DiffCI would have run more than the simple
 *      path-rule comparator, the line still appears, still carries its negative quantity, and prices at
 *      zero. Hiding it would make the invoice a summary of the good months only.
 *   3. THE RULE TRAVELS WITH THE INVOICE. The share percentage is stored on the invoice, not read from
 *      configuration when it is displayed - an issued invoice must still explain itself after the price
 *      changes.
 *   4. EVERY LINE CAN BE RECOMPUTED. `reconcileInvoice` rebuilds each line from the ledger and reports
 *      every difference. An invoice that cannot be re-derived from its evidence is a number someone is
 *      asked to take on trust, which is the opposite of what this product sells.
 *
 * Money is integer cents everywhere. Floats do not appear in this file.
 */
import type { EvidenceTier } from "../usage/economics-classification.js";
import type { LedgerRow, MonthlyLedger } from "../ledger/ledger.js";

/** DiffCI's stated share of measured savings. A default, overridable per invoice, stored on each one. */
export const DEFAULT_SAVINGS_SHARE_PERCENT = 15;

export type InvoiceStatus = "draft" | "issued" | "paid" | "void";

export interface InvoiceLineDraft {
  repositoryId: string;
  description: string;
  /** Net test runs avoided against the comparator. May be negative. */
  quantity: number;
  unit: "net_tests_avoided";
  /** What that net was worth, in cents, when the evidence supported saying. Zero otherwise. */
  netSavingsUsdCents: number;
  /** The share of the above. Zero unless `chargeable`. */
  amountUsdCents: number;
  evidenceTier: EvidenceTier;
  chargeable: boolean;
  notChargeableReason?: string;
  sourceReference: { repositoryId: string; month: string; comparableObservations: number };
}

export interface InvoiceDraft {
  organizationId: string;
  periodMonth: string;
  currency: "USD";
  savingsSharePercent: number;
  netTestsAvoided: number;
  netSavingsUsdCents: number;
  totalUsdCents: number;
  evidenceTier: EvidenceTier;
  chargeable: boolean;
  notChargeableReason?: string;
  ledgerDigest: string;
  lines: InvoiceLineDraft[];
}

export interface BuildInvoiceOptions {
  savingsSharePercent?: number;
  /** Injected so the digest is deterministic in tests; defaults to SHA-256 over the canonical ledger. */
  digest?: (canonical: string) => Promise<string>;
}

const NOT_MEASURED_REASON =
  "the money basis for this month is not MEASURED. DiffCI is observation-only: the selected subset is never executed, so the time it would have taken is never measured, and a share of an estimate is not an invoice.";

const NEGATIVE_REASON =
  "DiffCI would have run more than the simple path-rule comparator this month, so there is nothing to take a share of. This line prices at zero and is never a credit.";

const ZERO_REASON = "there were no net savings to take a share of this month.";

/** Cents, from a dollar amount, with half-up rounding at the cent. Never a float result. */
export function toCents(usd: number): number {
  return Math.round(usd * 100);
}

/**
 * The canonical string a ledger digest is taken over. Deliberately explicit rather than
 * `JSON.stringify(ledger)`: an invoice's digest must not change because an unrelated presentational
 * field was added to the ledger type, and must change if any figure it prices does.
 */
export function canonicalLedger(ledger: MonthlyLedger): string {
  const rows = ledger.rows
    .map((row) =>
      [
        row.repositoryId,
        row.verdict,
        row.comparable,
        row.netTestsAvoided,
        row.grossTestsAvoidedVsFullSuite,
        row.timeTier,
        typeof row.netCostAvoidedUsd.value === "number" ? toCents(row.netCostAvoidedUsd.value) : "unknown",
      ].join(":"),
    )
    .sort();
  return [ledger.organizationId, ledger.month, ledger.totals.netTestsAvoided, ledger.totals.countTier, ledger.totals.timeTier, ...rows].join("|");
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Prices one ledger row. The only place a chargeable amount is ever produced. */
export function priceLine(row: LedgerRow, month: string, savingsSharePercent: number): InvoiceLineDraft {
  const base: Omit<InvoiceLineDraft, "netSavingsUsdCents" | "amountUsdCents" | "chargeable" | "notChargeableReason"> = {
    repositoryId: row.repositoryId,
    description: `${row.ownerName ?? row.repositoryId} — ${row.netTestsAvoided} net test runs avoided vs a path-rule CI, from ${row.comparable} comparable observation${row.comparable === 1 ? "" : "s"}`,
    quantity: row.netTestsAvoided,
    unit: "net_tests_avoided",
    evidenceTier: row.timeTier,
    sourceReference: { repositoryId: row.repositoryId, month, comparableObservations: row.comparable },
  };

  // Rule 2 before rule 1: a negative month is refused for its own, more specific reason, so an invoice
  // never explains "DiffCI cost you more" as "the evidence was weak".
  if (row.netTestsAvoided < 0) {
    return { ...base, netSavingsUsdCents: 0, amountUsdCents: 0, chargeable: false, notChargeableReason: NEGATIVE_REASON };
  }
  if (row.timeTier !== "MEASURED" || typeof row.netCostAvoidedUsd.value !== "number") {
    return { ...base, netSavingsUsdCents: 0, amountUsdCents: 0, chargeable: false, notChargeableReason: NOT_MEASURED_REASON };
  }

  const netSavingsUsdCents = toCents(row.netCostAvoidedUsd.value);
  if (netSavingsUsdCents <= 0) {
    return { ...base, netSavingsUsdCents, amountUsdCents: 0, chargeable: false, notChargeableReason: ZERO_REASON };
  }
  return {
    ...base,
    netSavingsUsdCents,
    amountUsdCents: Math.round((netSavingsUsdCents * savingsSharePercent) / 100),
    chargeable: true,
  };
}

export async function buildInvoiceFromLedger(ledger: MonthlyLedger, options: BuildInvoiceOptions = {}): Promise<InvoiceDraft> {
  const savingsSharePercent = options.savingsSharePercent ?? DEFAULT_SAVINGS_SHARE_PERCENT;
  const lines = ledger.rows.map((row) => priceLine(row, ledger.month, savingsSharePercent));

  const chargeableLines = lines.filter((line) => line.chargeable);
  const totalUsdCents = chargeableLines.reduce((sum, line) => sum + line.amountUsdCents, 0);
  const netSavingsUsdCents = chargeableLines.reduce((sum, line) => sum + line.netSavingsUsdCents, 0);
  const digest = await (options.digest ?? sha256Hex)(canonicalLedger(ledger));

  return {
    organizationId: ledger.organizationId,
    periodMonth: ledger.month,
    currency: "USD",
    savingsSharePercent,
    netTestsAvoided: ledger.totals.netTestsAvoided,
    netSavingsUsdCents,
    totalUsdCents,
    // The invoice's tier is the tier of what it CHARGES for. With nothing chargeable it is the month's
    // own money tier, which is the honest description of why the total is zero.
    evidenceTier: chargeableLines.length > 0 ? "MEASURED" : ledger.totals.timeTier,
    chargeable: chargeableLines.length > 0,
    notChargeableReason:
      chargeableLines.length > 0
        ? undefined
        : ledger.rows.length === 0
          ? "no observations were received in this month."
          : ledger.totals.netTestsAvoided < 0
            ? NEGATIVE_REASON
            : ledger.totals.timeTier === "MEASURED"
              ? ZERO_REASON
              : NOT_MEASURED_REASON,
    ledgerDigest: digest,
    lines,
  };
}

export interface ReconciliationDifference {
  /** The line's repository, or "invoice" for a total-level difference. */
  scope: string;
  field: string;
  invoiced: string | number;
  recomputed: string | number;
}

export interface ReconciliationResult {
  reconciled: boolean;
  differences: ReconciliationDifference[];
  /** True when the ledger no longer hashes to what the invoice was computed from. */
  ledgerChanged: boolean;
}

/**
 * Recomputes every line from the ledger and compares it with what was invoiced - "reconciled line by
 * line", as a function rather than as a spreadsheet.
 *
 * A ledger digest mismatch is reported separately from a value mismatch, because they mean different
 * things: values differing means the pricing changed, while the digest differing means the EVIDENCE
 * changed after the invoice was issued (a late-arriving observation, a customer deletion, a retention
 * sweep). Both must be visible; only one of them is a billing bug.
 */
export async function reconcileInvoice(
  invoice: InvoiceDraft,
  ledger: MonthlyLedger,
  options: { digest?: (canonical: string) => Promise<string> } = {},
): Promise<ReconciliationResult> {
  const differences: ReconciliationDifference[] = [];
  const recomputed = await buildInvoiceFromLedger(ledger, { savingsSharePercent: invoice.savingsSharePercent, digest: options.digest });

  const byRepository = new Map(recomputed.lines.map((line) => [line.repositoryId, line]));
  for (const line of invoice.lines) {
    const fresh = byRepository.get(line.repositoryId);
    if (!fresh) {
      differences.push({ scope: line.repositoryId, field: "line", invoiced: "present", recomputed: "absent" });
      continue;
    }
    byRepository.delete(line.repositoryId);
    for (const field of ["quantity", "netSavingsUsdCents", "amountUsdCents", "evidenceTier"] as const) {
      if (line[field] !== fresh[field]) {
        differences.push({ scope: line.repositoryId, field, invoiced: line[field], recomputed: fresh[field] });
      }
    }
    if (line.chargeable !== fresh.chargeable) {
      differences.push({ scope: line.repositoryId, field: "chargeable", invoiced: String(line.chargeable), recomputed: String(fresh.chargeable) });
    }
  }
  for (const missing of byRepository.values()) {
    differences.push({ scope: missing.repositoryId, field: "line", invoiced: "absent", recomputed: "present" });
  }

  for (const field of ["totalUsdCents", "netTestsAvoided", "netSavingsUsdCents", "evidenceTier"] as const) {
    if (invoice[field] !== recomputed[field]) {
      differences.push({ scope: "invoice", field, invoiced: invoice[field], recomputed: recomputed[field] });
    }
  }

  // The sum of the lines must equal the invoice total. Checked explicitly rather than assumed from the
  // way the total was built: this is the one arithmetic error a customer would find first.
  const lineSum = invoice.lines.filter((line) => line.chargeable).reduce((sum, line) => sum + line.amountUsdCents, 0);
  if (lineSum !== invoice.totalUsdCents) {
    differences.push({ scope: "invoice", field: "total_vs_lines", invoiced: invoice.totalUsdCents, recomputed: lineSum });
  }

  return { reconciled: differences.length === 0, differences, ledgerChanged: invoice.ledgerDigest !== recomputed.ledgerDigest };
}

/** Formats cents as a currency string. Presentation only - never used to compute anything. */
export function formatUsdCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const absolute = Math.abs(cents);
  return `${sign}$${Math.floor(absolute / 100)}.${String(absolute % 100).padStart(2, "0")}`;
}
