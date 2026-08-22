import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildPreflightDashboard, type DashboardReconciliationEntry } from "../../src/preflight/dashboard.js";

const unknown = { value: "unknown" as const, confidence: "unknown" as const };

function entry(outcome: DashboardReconciliationEntry["outcome"], overrides: Partial<DashboardReconciliationEntry> = {}): DashboardReconciliationEntry {
  return { outcome, avoidedDownstreamWorkMs: unknown, preflightOverheadMs: unknown, timeToSignalImprovementMs: unknown, ...overrides };
}

describe("buildPreflightDashboard - Part N, explicit denominators throughout", () => {
  it("counts outcomes and tracks reconciled vs. unreconciled against totalPredictions", () => {
    const dashboard = buildPreflightDashboard(10, [entry("TP"), entry("TN"), entry("FN")]);
    assert.equal(dashboard.totalPredictions, 10);
    assert.equal(dashboard.reconciledCount, 3);
    assert.equal(dashboard.unreconciledCount, 7);
    assert.deepEqual(dashboard.outcomeCounts, { TP: 1, TN: 1, FP: 0, FN: 1, NOT_EVALUABLE: 0 });
  });

  it("deterministicRecall carries its own tp/fn denominator alongside the value", () => {
    const dashboard = buildPreflightDashboard(4, [entry("TP"), entry("TP"), entry("TP"), entry("FN")]);
    assert.equal(dashboard.deterministicRecall.value, 0.75);
    assert.equal(dashboard.deterministicRecall.tp, 3);
    assert.equal(dashboard.deterministicRecall.fn, 1);
  });

  it("deterministicRecall is 'unknown', never 0, when TP+FN is zero", () => {
    const dashboard = buildPreflightDashboard(2, [entry("TN"), entry("FP")]);
    assert.equal(dashboard.deterministicRecall.value, "unknown");
  });

  it("precision carries its own tp/fp denominator", () => {
    const dashboard = buildPreflightDashboard(3, [entry("TP"), entry("TP"), entry("FP")]);
    assert.equal(dashboard.precision.value, 2 / 3);
    assert.equal(dashboard.precision.tp, 2);
    assert.equal(dashboard.precision.fp, 1);
  });

  it("median overhead is computed only across TN/FP (successful-commit) outcomes, per Part F's scope", () => {
    const dashboard = buildPreflightDashboard(3, [
      entry("TN", { preflightOverheadMs: { value: 100, confidence: "measured" } }),
      entry("FP", { preflightOverheadMs: { value: 300, confidence: "measured" } }),
      entry("TP", { preflightOverheadMs: { value: 999_999, confidence: "measured" } }), // must be excluded
    ]);
    assert.equal(dashboard.medianSuccessfulCommitOverheadMs.value, 200);
  });

  it("aggregate confidence is never stronger than its weakest real contributor", () => {
    const dashboard = buildPreflightDashboard(2, [
      entry("TN", { preflightOverheadMs: { value: 100, confidence: "measured" } }),
      entry("FP", { preflightOverheadMs: { value: 300, confidence: "estimated" } }),
    ]);
    assert.equal(dashboard.medianSuccessfulCommitOverheadMs.confidence, "estimated");
  });

  it("totalEstimatedDownstreamWorkAvoidedMs sums only real numeric contributions, never fabricates for unknown ones", () => {
    const dashboard = buildPreflightDashboard(2, [
      entry("TP", { avoidedDownstreamWorkMs: { value: 60_000, confidence: "estimated" } }),
      entry("FN", { avoidedDownstreamWorkMs: unknown }),
    ]);
    assert.equal(dashboard.totalEstimatedDownstreamWorkAvoidedMs.value, 60_000);
  });

  it("an aggregate over zero reconciliations is 'unknown', not a fabricated zero", () => {
    const dashboard = buildPreflightDashboard(0, []);
    assert.equal(dashboard.medianTimeToSignalImprovementMs.value, "unknown");
    assert.equal(dashboard.totalEstimatedDownstreamWorkAvoidedMs.value, "unknown");
    assert.equal(dashboard.deterministicRecall.value, "unknown");
    assert.equal(dashboard.precision.value, "unknown");
  });

  it("real regression scenario: 16 TP / 7 FN / 1 NOT_EVALUABLE (Part G's actual replay result) yields deterministicRecall 16/23", () => {
    const entries: DashboardReconciliationEntry[] = [
      ...Array.from({ length: 16 }, () => entry("TP")),
      ...Array.from({ length: 7 }, () => entry("FN")),
      entry("NOT_EVALUABLE"),
    ];
    const dashboard = buildPreflightDashboard(24, entries);
    assert.equal(dashboard.deterministicRecall.tp, 16);
    assert.equal(dashboard.deterministicRecall.fn, 7);
    assert.ok(Math.abs((dashboard.deterministicRecall.value as number) - 16 / 23) < 1e-9);
  });
});
