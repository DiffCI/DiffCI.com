/**
 * Acceptance tests for the M2 recompute/backfill (src/usage/shadow-economics-recompute.ts). The load-
 * bearing guarantees here are that raw telemetry is immutable, that known-bad v1 estimates are corrected
 * rather than left in place, and that re-running changes nothing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runShadowEconomicsRecompute } from "../../src/usage/shadow-economics-recompute.js";
import { ESTIMATOR_VERSION } from "../../src/usage/economics-estimator.js";
import type { ShadowEconomicsStore, RecomputeUpdate } from "../../src/usage/shadow-economics-store.js";
import type { ShadowEconomicsObservation } from "../../src/usage/shadow-economics.js";

function row(overrides: Partial<ShadowEconomicsObservation> = {}): ShadowEconomicsObservation {
  return {
    logicalDeltaKey: "k1",
    stage: "test",
    repository: "unjs/h3",
    headSha: "a".repeat(40),
    workflowRunIds: [111, 222],
    jobIds: [333],
    fullWorkloadMs: 35_000,
    testsTotalFull: 70,
    testsSelectedDiffci: 1,
    testsSelectedPath: 70,
    diffciAnalysisOverheadMs: 200,
    planMode: "SELECTIVE",
    selectedWorkloadMs: undefined,
    selectedWorkloadConfidence: undefined,
    avoidableMs: undefined,
    avoidableTier: "UNKNOWN",
    estimationMethod: undefined,
    estimatorVersion: undefined,
    estimatedAt: undefined,
    schemaVersion: 1,
    observedAt: "2026-08-25T15:20:00Z",
    ...overrides,
  };
}

/** In-memory store that applies recomputes the same way the real D1 statement does - derived columns only. */
function fakeStore(rows: ShadowEconomicsObservation[]) {
  const audit: RecomputeUpdate[] = [];
  const store: ShadowEconomicsStore = {
    async recordIfNew() {
      return true;
    },
    async listForReport() {
      return rows;
    },
    async listRecordedDeltaKeys() {
      return rows.map((r) => r.logicalDeltaKey);
    },
    async listRowsNeedingRecompute(current, limit) {
      return rows.filter((r) => r.estimatorVersion === undefined || r.estimatorVersion < current).slice(0, limit);
    },
    async applyRecompute(input) {
      audit.push(input);
      const target = rows.find((r) => r.logicalDeltaKey === input.logicalDeltaKey && r.stage === input.stage);
      if (!target) throw new Error("no such row");
      // Mirrors the real UPDATE: ONLY derived columns are assignable here.
      target.selectedWorkloadMs = input.after.selectedWorkloadMs;
      target.selectedWorkloadConfidence = input.after.selectedWorkloadConfidence;
      target.avoidableMs = input.after.avoidableMs;
      target.avoidableTier = input.after.avoidableTier;
      target.estimationMethod = input.after.estimationMethod;
      target.estimatorVersion = input.toEstimatorVersion;
      target.estimatedAt = input.recomputedAt;
    },
  };
  return { store, audit, rows };
}

describe("runShadowEconomicsRecompute - M2 acceptance", () => {
  // (6) The known-bad v1 row must be corrected, not left alone.
  it("recomputes the incorrect v1 ESTIMATED row - 28s avoidable on a FULL 70/70 plan becomes 0", async () => {
    const bad = row({
      logicalDeltaKey: "h3-full",
      fullWorkloadMs: 63_000,
      testsSelectedDiffci: 70,
      testsTotalFull: 70,
      planMode: "FULL",
      selectedWorkloadMs: 35_000,
      avoidableMs: 28_000,
      avoidableTier: "ESTIMATED",
      estimatorVersion: 1,
    });
    const { store, audit, rows } = fakeStore([bad]);
    const result = await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T04:00:00Z" }, 50);

    assert.equal(result.recomputed, 1);
    assert.equal(rows[0]!.avoidableMs, 0, "the fabricated 28s must be gone");
    assert.equal(rows[0]!.selectedWorkloadMs, 63_000);
    assert.equal(rows[0]!.estimatorVersion, ESTIMATOR_VERSION);
    assert.equal(audit[0]!.reason, "estimator_version_upgrade");
    assert.equal(audit[0]!.before.avoidableMs, 28_000, "the audit must preserve what was previously reportable");
    assert.equal(audit[0]!.after.avoidableMs, 0);
    assert.equal(result.avoidableMsDelta, -28_000);
  });

  // (7) The UNKNOWN row whose inputs are now sufficient.
  it("upgrades a historical UNKNOWN row to ESTIMATED once its inputs are available", async () => {
    const { store, audit, rows } = fakeStore([row({ logicalDeltaKey: "h3-selective" })]);
    const result = await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T04:00:00Z" }, 50);

    assert.equal(result.recomputed, 1);
    assert.equal(rows[0]!.avoidableTier, "ESTIMATED");
    assert.equal(rows[0]!.selectedWorkloadMs, 500);
    assert.equal(rows[0]!.avoidableMs, 34_500);
    assert.equal(audit[0]!.reason, "unknown_now_estimable");
    assert.deepEqual(result.tierTransitions, { "UNKNOWN->ESTIMATED": 1 });
  });

  // (8) Raw telemetry immutability.
  it("leaves every raw measured field byte-for-byte unchanged", async () => {
    const original = row({ logicalDeltaKey: "h3-raw" });
    const snapshot = {
      fullWorkloadMs: original.fullWorkloadMs,
      testsTotalFull: original.testsTotalFull,
      testsSelectedDiffci: original.testsSelectedDiffci,
      planMode: original.planMode,
      headSha: original.headSha,
      workflowRunIds: [...original.workflowRunIds],
      jobIds: [...original.jobIds],
      observedAt: original.observedAt,
      schemaVersion: original.schemaVersion,
      repository: original.repository,
      stage: original.stage,
    };
    const { store, rows } = fakeStore([original]);
    await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T04:00:00Z" }, 50);

    const after = rows[0]!;
    assert.equal(after.fullWorkloadMs, snapshot.fullWorkloadMs);
    assert.equal(after.testsTotalFull, snapshot.testsTotalFull);
    assert.equal(after.testsSelectedDiffci, snapshot.testsSelectedDiffci);
    assert.equal(after.planMode, snapshot.planMode);
    assert.equal(after.headSha, snapshot.headSha);
    assert.deepEqual(after.workflowRunIds, snapshot.workflowRunIds);
    assert.deepEqual(after.jobIds, snapshot.jobIds);
    assert.equal(after.observedAt, snapshot.observedAt, "observedAt is when it was MEASURED - estimatedAt is the recompute time");
    assert.equal(after.schemaVersion, snapshot.schemaVersion);
    assert.equal(after.repository, snapshot.repository);
    assert.equal(after.stage, snapshot.stage);
  });

  // (9) Idempotency.
  it("re-running the backfill mutates nothing and writes no further audit rows", async () => {
    const { store, audit, rows } = fakeStore([row({ logicalDeltaKey: "a" }), row({ logicalDeltaKey: "b", estimatorVersion: 1, avoidableTier: "ESTIMATED", avoidableMs: 999 })]);
    const first = await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T04:00:00Z" }, 50);
    const auditAfterFirst = audit.length;
    const snapshot = JSON.stringify(rows);

    const second = await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T05:00:00Z" }, 50);

    assert.equal(first.recomputed, 2);
    assert.equal(second.examined, 0, "nothing is stale any more");
    assert.equal(second.recomputed, 0);
    assert.equal(audit.length, auditAfterFirst, "no duplicate audit rows");
    assert.equal(JSON.stringify(rows), snapshot, "no additional mutation");
  });

  it("is bounded by maxRows so one sweep can never run away", async () => {
    const many = Array.from({ length: 25 }, (_, i) => row({ logicalDeltaKey: `k${i}` }));
    const { store } = fakeStore(many);
    const result = await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T04:00:00Z" }, 10);
    assert.equal(result.examined, 10);
    assert.equal(result.recomputed, 10);
  });

  it("a non-test row stays UNKNOWN through recompute but is still stamped, so it is not re-examined forever", async () => {
    const { store, rows } = fakeStore([row({ stage: "other", testsTotalFull: undefined, testsSelectedDiffci: undefined })]);
    const result = await runShadowEconomicsRecompute({ store, nowIso: () => "2026-08-26T04:00:00Z" }, 50);
    assert.equal(rows[0]!.avoidableTier, "UNKNOWN");
    assert.equal(rows[0]!.estimatorVersion, ESTIMATOR_VERSION, "stamped even though the verdict did not change");
    assert.deepEqual(result.tierTransitions, { "UNKNOWN->UNKNOWN": 1 });
  });
});
