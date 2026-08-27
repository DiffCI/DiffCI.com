/**
 * Phase 04 (2026-08-26): one observation's net savings.
 *
 * Every test here is really the same test asked five ways: is this number measured against what the
 * customer would otherwise have run, or against a strawman? Phase 01 found the codebase had been
 * measuring against "run the whole suite" everywhere, and that a stronger comparator makes DiffCI look
 * worse on real repositories. The negative case below is that finding, in the ledger.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { computeNetSavings } from "../../src/ledger/net-savings.js";
import { createDefaultComputeCostModel } from "../../src/usage/cost-model.js";
import type { ObservationRecord } from "../../src/ingest/types.js";

function observation(overrides: Partial<ObservationRecord> = {}): ObservationRecord {
  return {
    id: "obs-1",
    organizationId: "org-1",
    repositoryId: "repo-1",
    idempotencyKey: "k",
    schemaVersion: "diffci.observation.v1",
    status: "OBSERVED",
    stage: "complete",
    mode: "SELECTIVE",
    selectedTestCount: 3,
    totalTestCount: 40,
    baselineMode: "FULL",
    blindSpot: false,
    worktreeUnchanged: true,
    blockingWorkflowFindings: 0,
    pathsRedacted: false,
    identityVerified: true,
    producedAt: "2026-08-26T10:00:00.000Z",
    receivedAt: "2026-08-26T10:00:01.000Z",
    reportBytes: 900,
    report: {},
    ...overrides,
  };
}

describe("net savings for one observation", () => {
  it("measures against the comparator, and keeps the vs-full-suite figure visible beside it", () => {
    const result = computeNetSavings(observation({ baselineMode: "SELECTIVE", baselineSelectedTestCount: 26, selectedTestCount: 3, totalTestCount: 40 }));

    assert.equal(result.comparable, true);
    assert.equal(result.netTestsAvoided, 23, "26 the comparator would run, minus 3 DiffCI would run");
    assert.equal(result.grossTestsAvoidedVsFullSuite, 37, "the flattering number, kept only so the gap is visible");
    assert.equal(result.countTier, "MEASURED");
  });

  it("reports a negative net when the simple path rule would have run less - Phase 01's own finding", () => {
    const result = computeNetSavings(observation({ mode: "FULL", totalTestCount: 40, baselineMode: "SELECTIVE", baselineSelectedTestCount: 5 }));

    assert.equal(result.diffciSelected, 40, "a FULL verdict means DiffCI would have run everything");
    assert.equal(result.netTestsAvoided, -35);
    assert.equal(result.countTier, "MEASURED", "bad news is measured just as well as good news");
  });

  it("is zero, not unknown, when both sides would run the same thing", () => {
    const result = computeNetSavings(observation({ mode: "FULL", totalTestCount: 40, baselineMode: "FULL" }));
    assert.equal(result.comparable, true);
    assert.equal(result.netTestsAvoided, 0);
  });

  it("never treats an empty test universe as everything avoided", () => {
    const result = computeNetSavings(observation({ totalTestCount: 0, selectedTestCount: 0 }));
    assert.equal(result.comparable, false);
    assert.match(result.notComparableReason ?? "", /no tests/);
    assert.equal(result.netTestsAvoided, undefined);
  });

  it("excludes observations that never produced a verdict", () => {
    for (const record of [
      observation({ status: "REFUSED", stage: "context", mode: undefined }),
      observation({ status: "ERROR", stage: "graph", mode: undefined }),
      observation({ mode: undefined }),
    ]) {
      const result = computeNetSavings(record);
      assert.equal(result.comparable, false, `${record.status}/${record.stage} should not be comparable`);
    }
  });

  it("refuses to produce a net figure when there is no comparator at all", () => {
    const result = computeNetSavings(observation({ baselineMode: undefined, baselineSelectedTestCount: undefined }));
    assert.equal(result.comparable, false);
    assert.match(result.notComparableReason ?? "", /no comparator/);
  });

  it("leaves time and money UNKNOWN with no duration observation, rather than inventing a rate", () => {
    const result = computeNetSavings(observation());
    assert.equal(result.timeTier, "UNKNOWN");
    assert.equal(result.netComputeSecondsAvoided.value, "unknown");
    assert.equal(result.netCostAvoidedUsd.value, "unknown");
  });

  it("can reach ESTIMATED with a duration assumption, and can never reach MEASURED", () => {
    const result = computeNetSavings(observation(), {
      secondsPerTest: { seconds: 4, confidence: "historical_estimate" },
      costModel: createDefaultComputeCostModel(),
    });

    assert.equal(result.netTestsAvoided, 37);
    assert.equal(result.netComputeSecondsAvoided.value, 148);
    assert.equal(result.timeTier, "ESTIMATED", "the selected side is never executed, so time is never measured");
    assert.equal(typeof result.netCostAvoidedUsd.value, "number");
    assert.notEqual(result.timeTier, "MEASURED");
  });

  it("prices a negative net as a negative amount, not as a saving", () => {
    const result = computeNetSavings(observation({ mode: "FULL", totalTestCount: 40, baselineMode: "SELECTIVE", baselineSelectedTestCount: 5 }), {
      secondsPerTest: { seconds: 4, confidence: "historical_estimate" },
      costModel: createDefaultComputeCostModel(),
    });

    assert.equal(result.netComputeSecondsAvoided.value, -140);
    assert.ok((result.netCostAvoidedUsd.value as number) < 0, "DiffCI costing more must not read as money saved");
  });
});
