/**
 * Phase 05 (2026-08-26): pricing a month, and proving the price.
 *
 * DiffCI's price is a share of a number DiffCI itself produced, about work that was never done, measured
 * against a counterfactual. Every test here is a way that could go wrong in the seller's favour: charging
 * for an estimate, charging for a month where DiffCI made things worse, a total that does not equal its
 * lines, or an invoice that quietly re-prices when the evidence behind it changes.
 *
 * The MEASURED ledgers below are constructed by hand rather than through buildMonthlyLedger, because
 * buildMonthlyLedger cannot currently produce one - the observation-only pipeline can never reach
 * MEASURED money. That is the point being tested from the other side: when a measured figure DOES exist,
 * the pricing must be right, and until then it must charge nothing.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  DEFAULT_SAVINGS_SHARE_PERCENT,
  buildInvoiceFromLedger,
  canonicalLedger,
  formatUsdCents,
  reconcileInvoice,
  toCents,
} from "../../src/billing/metered.js";
import { buildMonthlyLedger, type LedgerRow, type MonthlyLedger } from "../../src/ledger/ledger.js";
import type { ObservationRecord } from "../../src/ingest/types.js";

function row(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return {
    repositoryId: "repo-1",
    ownerName: "acme/checkout",
    verdict: "NET_POSITIVE",
    observations: 10,
    comparable: 10,
    notComparable: 0,
    notComparableReasons: [],
    netTestsAvoided: 100,
    grossTestsAvoidedVsFullSuite: 200,
    netNegativeObservations: 0,
    countTier: "MEASURED",
    netComputeSecondsAvoided: { value: 1000, confidence: "measured" },
    netCostAvoidedUsd: { value: 40, confidence: "measured" },
    timeTier: "MEASURED",
    billable: false,
    notBillableReason: "n/a in this fixture",
    ...overrides,
  };
}

function ledgerOf(rows: LedgerRow[], overrides: Partial<MonthlyLedger["totals"]> = {}): MonthlyLedger {
  return {
    organizationId: "org-1",
    month: "2026-08",
    from: "2026-08-01T00:00:00.000Z",
    to: "2026-09-01T00:00:00.000Z",
    rows,
    totals: {
      repositories: rows.length,
      observations: rows.reduce((sum, r) => sum + r.observations, 0),
      comparable: rows.reduce((sum, r) => sum + r.comparable, 0),
      netTestsAvoided: rows.reduce((sum, r) => sum + r.netTestsAvoided, 0),
      grossTestsAvoidedVsFullSuite: rows.reduce((sum, r) => sum + r.grossTestsAvoidedVsFullSuite, 0),
      countTier: "MEASURED",
      netComputeSecondsAvoided: { value: 1000, confidence: "measured" },
      netCostAvoidedUsd: { value: rows.reduce((sum, r) => sum + (typeof r.netCostAvoidedUsd.value === "number" ? r.netCostAvoidedUsd.value : 0), 0), confidence: "measured" },
      timeTier: "MEASURED",
      billable: false,
      notBillableReason: "n/a in this fixture",
      ...overrides,
    },
  };
}

describe("pricing a month", () => {
  it("charges the stated share of measured net savings, in whole cents", async () => {
    const invoice = await buildInvoiceFromLedger(ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]));

    assert.equal(invoice.savingsSharePercent, DEFAULT_SAVINGS_SHARE_PERCENT);
    assert.equal(invoice.netSavingsUsdCents, 4000);
    assert.equal(invoice.totalUsdCents, 600, "15% of $40.00");
    assert.equal(invoice.chargeable, true);
    assert.equal(invoice.evidenceTier, "MEASURED");
    assert.equal(formatUsdCents(invoice.totalUsdCents), "$6.00");
  });

  it("charges nothing when the money basis is not MEASURED, and says exactly why", async () => {
    for (const tier of ["ESTIMATED", "UNKNOWN"] as const) {
      const invoice = await buildInvoiceFromLedger(
        ledgerOf([row({ timeTier: tier, netCostAvoidedUsd: { value: 40, confidence: "historical_estimate" } })], { timeTier: tier }),
      );
      assert.equal(invoice.totalUsdCents, 0, `${tier} must not be chargeable`);
      assert.equal(invoice.chargeable, false);
      assert.match(invoice.notChargeableReason ?? "", /not MEASURED/);
      assert.match(invoice.lines[0]!.notChargeableReason ?? "", /share of an estimate is not an invoice/);
    }
  });

  it("prices a month where DiffCI would have run more at zero, never as a credit", async () => {
    const invoice = await buildInvoiceFromLedger(
      ledgerOf([row({ verdict: "NET_NEGATIVE", netTestsAvoided: -150, netCostAvoidedUsd: { value: -60, confidence: "measured" } })]),
    );

    assert.equal(invoice.totalUsdCents, 0);
    assert.ok(invoice.totalUsdCents >= 0, "an invoice total is never negative");
    assert.equal(invoice.lines[0]!.quantity, -150, "the negative quantity is still shown");
    assert.match(invoice.lines[0]!.notChargeableReason ?? "", /never a credit/);
    assert.match(invoice.notChargeableReason ?? "", /nothing to take a share of/);
  });

  it("charges only the repositories that earned it, in a mixed month", async () => {
    const invoice = await buildInvoiceFromLedger(
      ledgerOf([
        row({ repositoryId: "good", ownerName: "acme/good", netCostAvoidedUsd: { value: 100, confidence: "measured" } }),
        row({ repositoryId: "bad", ownerName: "acme/bad", verdict: "NET_NEGATIVE", netTestsAvoided: -20, netCostAvoidedUsd: { value: -8, confidence: "measured" } }),
        row({ repositoryId: "quiet", ownerName: "acme/quiet", verdict: "NO_OPPORTUNITY", netTestsAvoided: 0, netCostAvoidedUsd: { value: 0, confidence: "measured" } }),
      ]),
    );

    assert.equal(invoice.totalUsdCents, 1500, "15% of the one repository that saved anything");
    assert.equal(invoice.lines.filter((line) => line.chargeable).length, 1);
    assert.equal(invoice.lines.length, 3, "every repository appears, including the ones that charge nothing");
    assert.match(invoice.lines.find((line) => line.repositoryId === "quiet")!.notChargeableReason ?? "", /no net savings/);
  });

  it("charges nothing for a month with no observations at all", async () => {
    const invoice = await buildInvoiceFromLedger(buildMonthlyLedger({ organizationId: "org-1", month: "2026-08", observations: [] }));
    assert.equal(invoice.totalUsdCents, 0);
    assert.deepEqual(invoice.lines, []);
    assert.match(invoice.notChargeableReason ?? "", /no observations/);
  });

  it("honours a different share without changing what it measures", async () => {
    const invoice = await buildInvoiceFromLedger(ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]), { savingsSharePercent: 10 });
    assert.equal(invoice.savingsSharePercent, 10);
    assert.equal(invoice.totalUsdCents, 400);
    assert.equal(invoice.netSavingsUsdCents, 4000, "the savings are the same; only the share changed");
  });

  it("rounds money at the cent, and keeps the total equal to the sum of its lines", async () => {
    const invoice = await buildInvoiceFromLedger(
      ledgerOf([
        row({ repositoryId: "a", netCostAvoidedUsd: { value: 0.11, confidence: "measured" } }),
        row({ repositoryId: "b", netCostAvoidedUsd: { value: 0.23, confidence: "measured" } }),
      ]),
    );

    // 11c * 15% = 1.65 -> 2c; 23c * 15% = 3.45 -> 3c.
    assert.equal(invoice.lines.find((line) => line.repositoryId === "a")!.amountUsdCents, 2);
    assert.equal(invoice.lines.find((line) => line.repositoryId === "b")!.amountUsdCents, 3);
    assert.equal(invoice.totalUsdCents, 5);
    assert.equal(toCents(0.115), 12, "half-up at the cent, not banker's rounding");
  });
});

describe("reconciliation", () => {
  it("reconciles an untouched invoice against its own ledger", async () => {
    const ledger = ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]);
    const invoice = await buildInvoiceFromLedger(ledger);

    const result = await reconcileInvoice(invoice, ledger);
    assert.equal(result.reconciled, true);
    assert.equal(result.ledgerChanged, false);
    assert.deepEqual(result.differences, []);
  });

  it("catches a line whose amount was altered after the fact", async () => {
    const ledger = ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]);
    const invoice = await buildInvoiceFromLedger(ledger);
    const tampered = { ...invoice, lines: [{ ...invoice.lines[0]!, amountUsdCents: 9999 }] };

    const result = await reconcileInvoice(tampered, ledger);
    assert.equal(result.reconciled, false);
    assert.ok(result.differences.some((difference) => difference.field === "amountUsdCents" && difference.invoiced === 9999));
    // And the total no longer equals its lines, which is the difference a customer would find first.
    assert.ok(result.differences.some((difference) => difference.field === "total_vs_lines"));
  });

  it("catches a total inflated without touching any line", async () => {
    const ledger = ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]);
    const invoice = await buildInvoiceFromLedger(ledger);

    const result = await reconcileInvoice({ ...invoice, totalUsdCents: 100_000 }, ledger);
    assert.equal(result.reconciled, false);
    assert.ok(result.differences.some((difference) => difference.scope === "invoice" && difference.field === "totalUsdCents"));
  });

  it("reports evidence changing after issue separately from pricing changing", async () => {
    const ledger = ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]);
    const invoice = await buildInvoiceFromLedger(ledger);

    // A repository's observations were deleted after the invoice was built - a real case: erasure on
    // uninstall, a retention sweep, or a customer asking.
    const changed = ledgerOf([]);
    const result = await reconcileInvoice(invoice, changed);

    assert.equal(result.ledgerChanged, true, "the evidence is not what it was");
    assert.ok(result.differences.some((difference) => difference.field === "line" && difference.recomputed === "absent"));
  });

  it("hashes what it prices, and only what it prices", async () => {
    const base = ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" } })]);
    const samePricing = ledgerOf([row({ netCostAvoidedUsd: { value: 40, confidence: "measured" }, notComparableReasons: ["a presentational field"] })]);
    const differentPricing = ledgerOf([row({ netCostAvoidedUsd: { value: 41, confidence: "measured" } })]);

    assert.equal(canonicalLedger(base), canonicalLedger(samePricing));
    assert.notEqual(canonicalLedger(base), canonicalLedger(differentPricing));
  });

  it("does not care what order the rows arrive in", async () => {
    const a = row({ repositoryId: "a", netCostAvoidedUsd: { value: 10, confidence: "measured" } });
    const b = row({ repositoryId: "b", netCostAvoidedUsd: { value: 20, confidence: "measured" } });
    assert.equal(canonicalLedger(ledgerOf([a, b])), canonicalLedger(ledgerOf([b, a])));
  });
});

describe("what today's real pipeline actually invoices", () => {
  it("charges nothing, because no client-observed month can reach MEASURED money", async () => {
    const observation: ObservationRecord = {
      id: "obs-1",
      organizationId: "org-1",
      repositoryId: "repo-1",
      idempotencyKey: "k",
      schemaVersion: "diffci.observation.v1",
      status: "OBSERVED",
      stage: "complete",
      mode: "SELECTIVE",
      selectedTestCount: 1,
      totalTestCount: 40,
      baselineMode: "SELECTIVE",
      baselineSelectedTestCount: 30,
      blindSpot: false,
      worktreeUnchanged: true,
      blockingWorkflowFindings: 0,
      pathsRedacted: false,
      identityVerified: true,
      producedAt: "2026-08-10T10:00:00.000Z",
      receivedAt: "2026-08-10T10:00:01.000Z",
      reportBytes: 900,
      report: {},
    };

    const ledger = buildMonthlyLedger({ organizationId: "org-1", month: "2026-08", observations: [observation] });
    const invoice = await buildInvoiceFromLedger(ledger);

    assert.equal(ledger.totals.netTestsAvoided, 29, "the saving is real and measured, as a count");
    assert.equal(invoice.netTestsAvoided, 29, "and the invoice states it");
    assert.equal(invoice.totalUsdCents, 0, "and charges nothing for it");
    assert.equal(invoice.evidenceTier, "UNKNOWN");
    assert.match(invoice.notChargeableReason ?? "", /never executed/);
  });
});
