/**
 * Phase 04 (2026-08-26): a month of net savings.
 *
 * The exit criterion is "one month of MEASURED net savings + one honest zero", so the honest zero has a
 * test of its own, as does the case nobody wants to build a report for: a repository where DiffCI would
 * have run MORE than the simple comparator. A ledger that can only express good news is not a ledger.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { buildMonthlyLedger, monthBounds } from "../../src/ledger/ledger.js";
import { createDefaultComputeCostModel } from "../../src/usage/cost-model.js";
import type { ObservationRecord } from "../../src/ingest/types.js";

let sequence = 0;

function observation(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  sequence++;
  return {
    id: `obs-${sequence}`,
    organizationId: "org-1",
    repositoryId: "repo-1",
    idempotencyKey: `k-${sequence}`,
    schemaVersion: "diffci.observation.v1",
    status: "OBSERVED",
    stage: "complete",
    mode: "SELECTIVE",
    selectedTestCount: 2,
    totalTestCount: 20,
    baselineMode: "FULL",
    blindSpot: false,
    worktreeUnchanged: true,
    blockingWorkflowFindings: 0,
    pathsRedacted: false,
    identityVerified: true,
    producedAt: "2026-08-10T10:00:00.000Z",
    receivedAt: "2026-08-10T10:00:01.000Z",
    reportBytes: 900,
    report: {},
    ...overrides,
  };
}

describe("month boundaries", () => {
  it("is UTC, inclusive of the first instant and exclusive of the next month's", () => {
    assert.deepEqual(monthBounds("2026-08"), { from: "2026-08-01T00:00:00.000Z", to: "2026-09-01T00:00:00.000Z" });
    assert.deepEqual(monthBounds("2026-12"), { from: "2026-12-01T00:00:00.000Z", to: "2027-01-01T00:00:00.000Z" });
  });

  it("refuses a month it cannot parse rather than picking a range", () => {
    for (const bad of ["2026", "2026-13", "august", "2026-8"]) {
      assert.throws(() => monthBounds(bad), /month must be/);
    }
  });
});

describe("the monthly ledger", () => {
  it("reports a measured net saving against the comparator, with the flattering figure beside it", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      repositoryNames: new Map([["repo-1", "acme/checkout"]]),
      observations: [
        observation({ baselineMode: "SELECTIVE", baselineSelectedTestCount: 12, selectedTestCount: 2, totalTestCount: 20 }),
        observation({ baselineMode: "SELECTIVE", baselineSelectedTestCount: 8, selectedTestCount: 3, totalTestCount: 20 }),
      ],
    });

    assert.equal(ledger.rows.length, 1);
    const row = ledger.rows[0]!;
    assert.equal(row.ownerName, "acme/checkout");
    assert.equal(row.verdict, "NET_POSITIVE");
    assert.equal(row.netTestsAvoided, 15, "(12-2) + (8-3)");
    assert.equal(row.grossTestsAvoidedVsFullSuite, 35, "(20-2) + (20-3)");
    assert.equal(row.countTier, "MEASURED");
    assert.equal(ledger.totals.netTestsAvoided, 15);
  });

  it("says the honest zero out loud when there was nothing to skip", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [
        observation({ mode: "FULL", baselineMode: "FULL", totalTestCount: 20 }),
        observation({ mode: "FULL", baselineMode: "FULL", totalTestCount: 20 }),
      ],
    });

    const row = ledger.rows[0]!;
    assert.equal(row.verdict, "NO_OPPORTUNITY");
    assert.equal(row.netTestsAvoided, 0);
    assert.equal(row.comparable, 2, "the month had data - it just had no opportunity in it");
    assert.equal(row.countTier, "MEASURED", "zero is a measured result, not an absence of one");
  });

  it("reports a repository where DiffCI would have run more than the comparator", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [observation({ mode: "FULL", totalTestCount: 20, baselineMode: "SELECTIVE", baselineSelectedTestCount: 4 })],
    });

    const row = ledger.rows[0]!;
    assert.equal(row.verdict, "NET_NEGATIVE");
    assert.equal(row.netTestsAvoided, -16);
    assert.equal(row.netNegativeObservations, 1);
  });

  it("sorts bad news to the top, where it cannot be missed", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [
        observation({ repositoryId: "good", baselineMode: "SELECTIVE", baselineSelectedTestCount: 18, selectedTestCount: 1, totalTestCount: 20 }),
        observation({ repositoryId: "bad", mode: "FULL", totalTestCount: 20, baselineMode: "SELECTIVE", baselineSelectedTestCount: 2 }),
      ],
    });

    assert.deepEqual(ledger.rows.map((row) => row.repositoryId), ["bad", "good"]);
  });

  it("counts what could not be compared, and why, instead of dropping it silently", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [
        observation({ status: "REFUSED", stage: "context", mode: undefined }),
        observation({ status: "ERROR", stage: "graph", mode: undefined }),
        observation({ baselineMode: "SELECTIVE", baselineSelectedTestCount: 10, selectedTestCount: 2, totalTestCount: 20 }),
      ],
    });

    const row = ledger.rows[0]!;
    assert.equal(row.observations, 3);
    assert.equal(row.comparable, 1);
    assert.equal(row.notComparable, 2);
    assert.equal(row.notComparableReasons.length, 2);
    assert.ok(row.notComparableReasons.some((reason) => reason.includes("REFUSED")));
  });

  it("is NO_DATA when nothing arrived that could be compared", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [observation({ status: "REFUSED", stage: "eligibility", mode: undefined })],
    });

    const row = ledger.rows[0]!;
    assert.equal(row.verdict, "NO_DATA");
    assert.equal(row.countTier, "UNKNOWN");
    assert.equal(row.netComputeSecondsAvoided.value, "unknown");
  });

  it("ignores observations outside the month rather than stretching the month around them", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [
        observation({ receivedAt: "2026-07-31T23:59:59.999Z" }),
        observation({ receivedAt: "2026-08-01T00:00:00.000Z" }),
        observation({ receivedAt: "2026-08-31T23:59:59.999Z" }),
        observation({ receivedAt: "2026-09-01T00:00:00.000Z" }),
      ],
    });

    assert.equal(ledger.totals.observations, 2);
    assert.equal(ledger.from, "2026-08-01T00:00:00.000Z");
  });

  it("is empty, not zero, for a month with nothing in it", () => {
    const ledger = buildMonthlyLedger({ organizationId: "org-1", month: "2026-08", observations: [] });
    assert.deepEqual(ledger.rows, []);
    assert.equal(ledger.totals.observations, 0);
    assert.equal(ledger.totals.countTier, "UNKNOWN");
    assert.equal(ledger.totals.netCostAvoidedUsd.value, "unknown");
  });

  it("never marks a month billable, and says why on every row and on the total", () => {
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [observation({ baselineMode: "SELECTIVE", baselineSelectedTestCount: 15, selectedTestCount: 1, totalTestCount: 20 })],
      savingsInput: () => ({ secondsPerTest: { seconds: 3, confidence: "historical_estimate" }, costModel: createDefaultComputeCostModel() }),
    });

    assert.equal(ledger.rows[0]!.billable, false);
    assert.equal(ledger.totals.billable, false);
    assert.match(ledger.totals.notBillableReason, /never executed/);
    // Even with a cost model and a real duration assumption, money stays an estimate.
    assert.equal(ledger.totals.timeTier, "ESTIMATED");
    assert.equal(ledger.totals.countTier, "MEASURED");
  });

  it("keeps a total no more certain than its least certain repository", () => {
    const withDuration = new Set(["repo-with-history"]);
    const ledger = buildMonthlyLedger({
      organizationId: "org-1",
      month: "2026-08",
      observations: [
        observation({ repositoryId: "repo-with-history", baselineMode: "SELECTIVE", baselineSelectedTestCount: 10, selectedTestCount: 2, totalTestCount: 20 }),
        observation({ repositoryId: "repo-without-history", baselineMode: "SELECTIVE", baselineSelectedTestCount: 10, selectedTestCount: 2, totalTestCount: 20 }),
      ],
      savingsInput: (repositoryId) =>
        withDuration.has(repositoryId) ? { secondsPerTest: { seconds: 3, confidence: "historical_estimate" } } : {},
    });

    assert.equal(ledger.rows.find((row) => row.repositoryId === "repo-with-history")!.timeTier, "ESTIMATED");
    assert.equal(ledger.rows.find((row) => row.repositoryId === "repo-without-history")!.timeTier, "UNKNOWN");
    assert.equal(ledger.totals.timeTier, "UNKNOWN", "one repository without duration data makes the total's time unknown");
    assert.equal(ledger.totals.netComputeSecondsAvoided.value, "unknown");
    assert.equal(ledger.totals.netTestsAvoided, 16, "counts are unaffected - they were never estimates");
  });
});
