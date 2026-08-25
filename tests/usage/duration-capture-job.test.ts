/**
 * Unit tests for src/usage/duration-capture-job.ts, using fakes for ShadowReadBoundary,
 * DurationObservationStore, and fetchBaselineEvidence - proves the orchestration logic in isolation
 * without hitting a real database or the real GitHub API. See duration-observation-store.test.ts and
 * duration-capture.test.ts for the real-storage and real-derivation pieces respectively.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDurationCaptureSweep } from "../../src/usage/duration-capture-job.js";
import type { ShadowReadBoundary, ShadowPredictionSummary } from "../../src/product/shadow-read-boundary.js";
import type { DurationObservation, DurationObservationStore } from "../../src/usage/duration-observation-store.js";
import type { BaselineEvidence } from "../../src/shadow/types.js";

function prediction(overrides: Partial<ShadowPredictionSummary> = {}): ShadowPredictionSummary {
  return {
    logicalDeltaKey: "k1",
    repository: "acme/web",
    headSha: "a".repeat(40),
    planMode: "SELECTIVE",
    opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY",
    testsSelectedDiffci: 9,
    testsTotalFull: 46,
    createdAt: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

function fakeShadowBoundary(predictions: ShadowPredictionSummary[]): ShadowReadBoundary {
  return {
    async listPredictions() {
      return predictions;
    },
    async getGroundTruthForDelta() {
      return null;
    },
    async getSafetySnapshot() {
      return { evaluableFailures: 0, failuresPreserved: 0, falseNegatives: 0 };
    },
    async listEnrolledRepositories() {
      return [];
    },
  };
}

function fakeStore(): DurationObservationStore & { recorded: DurationObservation[] } {
  const recorded: DurationObservation[] = [];
  return {
    recorded,
    async recordIfNew(observation) {
      if (recorded.some((o) => o.logicalDeltaKey === observation.logicalDeltaKey)) return false;
      recorded.push(observation);
      return true;
    },
    async listRecent(repository, limit) {
      return recorded.filter((o) => !repository || o.repository === repository).slice(0, limit);
    },
  };
}

function completeEvidence(baselineDurationMs: number): BaselineEvidence {
  return {
    repository: "acme/web",
    headSha: "a".repeat(40),
    status: "COMPLETE",
    fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 999, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" }],
    jobs: [{ jobId: 111, jobName: "test", status: "completed", conclusion: "success", durationMs: baselineDurationMs }],
    failedJobNames: [],
    failedTaskIds: [],
    apiCallsMade: 2,
    baselineDurationMs,
  };
}

describe("runDurationCaptureSweep", () => {
  it("captures a real observation for a prediction with complete CI evidence", async () => {
    const store = fakeStore();
    const result = await runDurationCaptureSweep(
      { shadowBoundary: fakeShadowBoundary([prediction()]), store, fetchBaseline: async () => completeEvidence(92_000), nowIso: () => "2026-08-23T00:00:00Z" },
      ["acme/web"],
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.captured, 1);
    assert.equal(store.recorded.length, 1);
    assert.equal(store.recorded[0]?.secondsPerTest, 2);
    assert.deepEqual(store.recorded[0]?.workflowRunIds, [999], "real workflow run identity threads through end-to-end (Part A.4)");
    assert.deepEqual(store.recorded[0]?.jobIds, [111]);
  });

  it("skips a prediction whose CI evidence is not yet COMPLETE - never records a partial/guessed duration", async () => {
    const store = fakeStore();
    const result = await runDurationCaptureSweep(
      { shadowBoundary: fakeShadowBoundary([prediction()]), store, fetchBaseline: async () => ({ repository: "acme/web", headSha: "a".repeat(40), status: "UNAVAILABLE", fullRunsObserved: [], jobs: [], failedJobNames: [], failedTaskIds: [], apiCallsMade: 1 }) },
      ["acme/web"],
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.captured, 0);
    assert.equal(result.skippedIncomplete, 1);
    assert.equal(store.recorded.length, 0);
  });

  it("a fetch failure for one commit is counted and skipped, never thrown - the rest of the sweep continues", async () => {
    const store = fakeStore();
    const predictions = [prediction({ logicalDeltaKey: "k1", headSha: "1".repeat(40) }), prediction({ logicalDeltaKey: "k2", headSha: "2".repeat(40) })];
    let call = 0;
    const result = await runDurationCaptureSweep(
      {
        shadowBoundary: fakeShadowBoundary(predictions),
        store,
        fetchBaseline: async () => {
          call++;
          if (call === 1) throw new Error("GitHub API 500");
          return completeEvidence(46_000);
        },
      },
      ["acme/web"],
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.errors, 1);
    assert.equal(result.captured, 1);
    assert.equal(store.recorded.length, 1);
    assert.equal(store.recorded[0]?.logicalDeltaKey, "k2");
  });

  it("a duplicate (already-recorded) observation is counted separately from newly captured ones", async () => {
    const store = fakeStore();
    await store.recordIfNew({ logicalDeltaKey: "k1", repository: "acme/web", headSha: "a".repeat(40), workflowRunIds: [1], jobIds: [1], testsTotalFull: 46, realJobDurationMs: 92_000, secondsPerTest: 2, observedAt: "2026-08-22T00:00:00Z" });
    const result = await runDurationCaptureSweep({ shadowBoundary: fakeShadowBoundary([prediction()]), store, fetchBaseline: async () => completeEvidence(92_000) }, ["acme/web"], "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(result.captured, 0);
    assert.equal(result.alreadyRecorded, 1);
  });

  it("R2.1 Part A.5: the SAME real GitHub evidence captured via TWO separate sweeps produces exactly one logical observation, never a duplicate", async () => {
    const store = fakeStore();
    const deps = { shadowBoundary: fakeShadowBoundary([prediction()]), store, fetchBaseline: async () => completeEvidence(92_000) };
    const first = await runDurationCaptureSweep(deps, ["acme/web"], "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    const second = await runDurationCaptureSweep(deps, ["acme/web"], "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(first.captured, 1);
    assert.equal(second.captured, 0);
    assert.equal(second.alreadyRecorded, 1);
    assert.equal(store.recorded.length, 1, "exactly one logical observation exists after two sweeps over the same evidence");
  });

  it("stops making real GitHub calls once maxPerSweep is reached - a real rate-limit backstop", async () => {
    const store = fakeStore();
    const predictions = Array.from({ length: 5 }, (_, i) => prediction({ logicalDeltaKey: `k${i}`, headSha: `${i}`.repeat(40) }));
    let calls = 0;
    const result = await runDurationCaptureSweep(
      { shadowBoundary: fakeShadowBoundary(predictions), store, fetchBaseline: async () => { calls++; return completeEvidence(46_000); } },
      ["acme/web"],
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      2,
    );
    assert.equal(calls, 2, "never exceeds the batch cap, even though 5 predictions were available");
    assert.equal(result.attempted, 2);
  });
});
