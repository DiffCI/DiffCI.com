/**
 * Unit tests for src/usage/shadow-economics-job.ts, using fakes for ShadowReadBoundary,
 * ShadowEconomicsStore, and fetchBaselineEvidence - proves the orchestration logic in isolation without
 * hitting a real database or the real GitHub API, mirroring duration-capture-job.test.ts's own approach.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runShadowEconomicsCaptureSweep } from "../../src/usage/shadow-economics-job.js";
import type { ShadowReadBoundary, ShadowPredictionSummary } from "../../src/product/shadow-read-boundary.js";
import type { ShadowEconomicsStore } from "../../src/usage/shadow-economics-store.js";
import type { ShadowEconomicsObservation } from "../../src/usage/shadow-economics.js";
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
    testsSelectedPath: 46,
    diffciAnalysisOverheadMs: 250,
    createdAt: "2026-08-22T00:00:00Z",
    ...overrides,
  };
}

function fakeShadowBoundary(repositories: string[], predictions: ShadowPredictionSummary[]): ShadowReadBoundary {
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
    async listVerifiedGroundTruth() { return []; },
    async listEnrolledRepositories() {
      return repositories;
    },
  };
}

function fakeStore(): ShadowEconomicsStore & { recorded: ShadowEconomicsObservation[] } {
  const recorded: ShadowEconomicsObservation[] = [];
  return {
    recorded,
    async recordIfNew(observation) {
      if (recorded.some((o) => o.logicalDeltaKey === observation.logicalDeltaKey && o.stage === observation.stage)) return false;
      recorded.push(observation);
      return true;
    },
    async listForReport(repository) {
      return recorded.filter((o) => o.repository === repository);
    },
    async listRowsNeedingRecompute() {
      return [];
    },
    async applyRecompute() {
      // not exercised by the capture-sweep tests
    },
    async listRecordedDeltaKeys(repository) {
      return [...new Set(recorded.filter((o) => o.repository === repository).map((o) => o.logicalDeltaKey))];
    },
  };
}

function completeEvidence(): BaselineEvidence {
  return {
    repository: "acme/web",
    headSha: "a".repeat(40),
    status: "COMPLETE",
    fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 999, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" }],
    jobs: [
      { jobId: 111, jobName: "unit tests", status: "completed", conclusion: "success", durationMs: 92_000 },
      { jobId: 112, jobName: "build", status: "completed", conclusion: "success", durationMs: 45_000 },
    ],
    failedJobNames: [],
    failedTaskIds: [],
    apiCallsMade: 2,
    baselineDurationMs: 137_000,
  };
}

describe("runShadowEconomicsCaptureSweep", () => {
  it("captures one row per real stage for a prediction with complete CI evidence", async () => {
    const store = fakeStore();
    const result = await runShadowEconomicsCaptureSweep(
      { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction()]), store, fetchBaseline: async () => completeEvidence(), nowIso: () => "2026-08-25T00:00:00Z" },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.repositoriesConsidered, 1);
    assert.equal(result.stageRowsCaptured, 2); // test + build
    assert.deepEqual(store.recorded.map((r) => r.stage).sort(), ["build", "test"]);
    const testRow = store.recorded.find((r) => r.stage === "test")!;
    assert.equal(testRow.fullWorkloadMs, 92_000);
    // Estimator v2: the FIRST capture is already estimable, because the counterfactual is anchored to
    // this commit's own measured workload rather than to other commits' history. Under v1 this was
    // UNKNOWN until some other commit had been captured, which is exactly what left the most valuable
    // unjs/h3 row permanently blank.
    assert.equal(testRow.avoidableTier, "ESTIMATED");
    assert.equal(testRow.selectedWorkloadMs, (92_000 * 9) / 46);
    const buildRow = store.recorded.find((r) => r.stage === "build")!;
    assert.equal(buildRow.fullWorkloadMs, 45_000);
    assert.equal(buildRow.selectedWorkloadMs, undefined); // v1 cannot classify build economics
  });

  it("every capture is independently estimable - a later commit does not depend on an earlier one having been captured", async () => {
    const store = fakeStore();
    const deps = { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction({ logicalDeltaKey: "k1", headSha: "1".repeat(40) })]), store, fetchBaseline: async () => completeEvidence(), nowIso: () => "2026-08-25T00:00:00Z" };
    await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);

    const deps2 = { ...deps, shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction({ logicalDeltaKey: "k2", headSha: "2".repeat(40) })]) };
    await runShadowEconomicsCaptureSweep(deps2, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);

    const firstTestRow = store.recorded.find((r) => r.logicalDeltaKey === "k1" && r.stage === "test")!;
    const secondTestRow = store.recorded.find((r) => r.logicalDeltaKey === "k2" && r.stage === "test")!;
    // Both ESTIMATED, and identical - same measured workload and same counts must give the same answer
    // regardless of capture order. v1 could not manage this: the first row was UNKNOWN and the second
    // inherited the first's timings as its baseline.
    assert.equal(firstTestRow.avoidableTier, "ESTIMATED");
    assert.equal(secondTestRow.avoidableTier, "ESTIMATED");
    assert.equal(secondTestRow.avoidableMs, firstTestRow.avoidableMs, "capture order must not change the estimate");
  });

  it("skips a prediction whose CI evidence is not yet COMPLETE - never records a partial/guessed row", async () => {
    const store = fakeStore();
    const result = await runShadowEconomicsCaptureSweep(
      { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction()]), store, fetchBaseline: async () => ({ repository: "acme/web", headSha: "a".repeat(40), status: "UNAVAILABLE", fullRunsObserved: [], jobs: [], failedJobNames: [], failedTaskIds: [], apiCallsMade: 1 }) },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.stageRowsCaptured, 0);
    assert.equal(result.skippedIncomplete, 1);
    assert.equal(store.recorded.length, 0);
  });

  it("a fetch failure for one commit is counted and skipped, never thrown - the rest of the sweep continues", async () => {
    const store = fakeStore();
    const predictions = [prediction({ logicalDeltaKey: "k1", headSha: "1".repeat(40) }), prediction({ logicalDeltaKey: "k2", headSha: "2".repeat(40) })];
    let call = 0;
    const result = await runShadowEconomicsCaptureSweep(
      {
        shadowBoundary: fakeShadowBoundary(["acme/web"], predictions),
        store,
        fetchBaseline: async () => {
          call++;
          if (call === 1) throw new Error("GitHub API 500");
          return completeEvidence();
        },
      },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.errors, 1);
    assert.equal(result.stageRowsCaptured, 2); // the second prediction still succeeds
  });

  it("respects maxPerSweep as a hard cap on real GitHub API calls, across repositories", async () => {
    const store = fakeStore();
    let calls = 0;
    const result = await runShadowEconomicsCaptureSweep(
      {
        shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction({ logicalDeltaKey: "k1" }), prediction({ logicalDeltaKey: "k2", headSha: "2".repeat(40) }), prediction({ logicalDeltaKey: "k3", headSha: "3".repeat(40) })]),
        store,
        fetchBaseline: async () => {
          calls++;
          return completeEvidence();
        },
      },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      2,
    );
    assert.equal(result.predictionsAttempted, 2);
    assert.equal(calls, 2);
  });

  it("round-robins across repos so one high-volume repo cannot starve another repo's budget - real bug found live 2026-08-25", async () => {
    const store = fakeStore();
    // 20 predictions for the alphabetically-first repo, only 1 for the alphabetically-last one - mirrors
    // the real production shape (adityankale190895/DentalPresence.in: 20 in-window vs unjs/h3: 3).
    const busyRepoPredictions = Array.from({ length: 20 }, (_, i) => prediction({ repository: "a/busy", logicalDeltaKey: `busy-${i}`, headSha: String(i % 10).repeat(40) }));
    const quietRepoPredictions = [prediction({ repository: "z/quiet", logicalDeltaKey: "quiet-1", headSha: "9".repeat(40) })];
    const boundary: ShadowReadBoundary = {
      async listPredictions(repository) {
        return repository === "a/busy" ? busyRepoPredictions : quietRepoPredictions;
      },
      async getGroundTruthForDelta() {
        return null;
      },
      async getSafetySnapshot() {
        return { evaluableFailures: 0, failuresPreserved: 0, falseNegatives: 0 };
      },
      async listVerifiedGroundTruth() { return []; },
      async listEnrolledRepositories() {
        return ["a/busy", "z/quiet"];
      },
    };
    const result = await runShadowEconomicsCaptureSweep({ shadowBoundary: boundary, store, fetchBaseline: async () => completeEvidence() }, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 5);
    assert.equal(result.predictionsAttempted, 5);
    assert.ok(store.recorded.some((r) => r.repository === "z/quiet"), "the quiet repo must get at least one attempt within the shared budget, not be starved by the busy repo's list order");
    assert.deepEqual(result.repositoriesAttempted.sort(), ["a/busy", "z/quiet"], "repositoriesAttempted is the only field that makes the fairness fix observable in a live log");
  });

  it("distinguishes a GitHub fetch error from genuinely-pending CI from a barren derive - skippedIncomplete alone is undiagnosable", async () => {
    const store = fakeStore();
    const predictions = [
      prediction({ logicalDeltaKey: "k-apierror", headSha: "1".repeat(40) }),
      prediction({ logicalDeltaKey: "k-pending", headSha: "2".repeat(40) }),
    ];
    const result = await runShadowEconomicsCaptureSweep(
      {
        shadowBoundary: fakeShadowBoundary(["acme/web"], predictions),
        store,
        fetchBaseline: async ({ headSha }) => {
          const base = { repository: "acme/web", headSha, fullRunsObserved: [], jobs: [], failedJobNames: [], failedTaskIds: [], apiCallsMade: 1 };
          // GitHub itself failed (rate limit / 403) - fetchBaselineEvidence reports this as UNAVAILABLE
          // WITH a fetchError, which is a completely different problem from CI simply not being done.
          if (headSha.startsWith("1")) return { ...base, status: "UNAVAILABLE" as const, fetchError: "GitHub API 403: rate limit exceeded" };
          return { ...base, status: "UNAVAILABLE" as const, pendingReason: "ci_in_progress" as const };
        },
      },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.equal(result.skippedFetchError, 1, "the rate-limited commit must be attributable to GitHub, not to the repo's CI");
    assert.equal(result.skippedCiPending, 1);
    assert.equal(result.skippedNoDerivableRows, 0);
    assert.equal(result.skippedIncomplete, result.skippedFetchError + result.skippedCiPending + result.skippedNoDerivableRows, "the headline number must always reconcile against its own breakdown");
  });

  it("resolves a GitHub token ONCE per repository and passes it into every fetch for that repository", async () => {
    const store = fakeStore();
    const tokenCalls: string[] = [];
    const seenTokens: (string | undefined)[] = [];
    const predictions = [
      prediction({ logicalDeltaKey: "k1", headSha: "1".repeat(40) }),
      prediction({ logicalDeltaKey: "k2", headSha: "2".repeat(40) }),
      prediction({ logicalDeltaKey: "k3", headSha: "3".repeat(40) }),
    ];
    await runShadowEconomicsCaptureSweep(
      {
        shadowBoundary: fakeShadowBoundary(["acme/web"], predictions),
        store,
        resolveToken: async (repository) => {
          tokenCalls.push(repository);
          return "ghs_installation_token";
        },
        fetchBaseline: async ({ token }) => {
          seenTokens.push(token);
          return completeEvidence();
        },
      },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.deepEqual(tokenCalls, ["acme/web"], "an installation-token exchange is itself an API call - resolve once per repo, never once per prediction");
    assert.equal(seenTokens.length, 3);
    assert.ok(seenTokens.every((t) => t === "ghs_installation_token"), "every GitHub read must carry the credential - an unauthenticated read is capped at 60/hour/IP and fails permanently from a Worker");
  });

  it("never spends a token exchange on a repository that has no predictions to read", async () => {
    const store = fakeStore();
    const tokenCalls: string[] = [];
    const boundary: ShadowReadBoundary = {
      async listPredictions(repository) {
        return repository === "a/has-work" ? [prediction({ repository: "a/has-work" })] : [];
      },
      async getGroundTruthForDelta() {
        return null;
      },
      async getSafetySnapshot() {
        return { evaluableFailures: 0, failuresPreserved: 0, falseNegatives: 0 };
      },
      async listVerifiedGroundTruth() { return []; },
      async listEnrolledRepositories() {
        return ["a/has-work", "b/idle"];
      },
    };
    await runShadowEconomicsCaptureSweep(
      { shadowBoundary: boundary, store, resolveToken: async (r) => { tokenCalls.push(r); return "t"; }, fetchBaseline: async () => completeEvidence() },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      10,
    );
    assert.deepEqual(tokenCalls, ["a/has-work"], "b/idle has nothing to fetch, so it must not cost a token exchange");
  });

  it("reaches the BACKLOG: with the newest 5 of 8 predictions already recorded, the sweep processes 6-8 instead of re-treading the head", async () => {
    const store = fakeStore();
    // 8 predictions, newest first (listPredictions orders created_at DESC).
    const all = Array.from({ length: 8 }, (_, i) =>
      prediction({ repository: "acme/web", logicalDeltaKey: `k${i + 1}`, headSha: String(i + 1).repeat(40) }),
    );
    // Pre-record the newest five (k1..k5) exactly as a previous sweep would have left them.
    for (const p of all.slice(0, 5)) {
      await store.recordIfNew({
        logicalDeltaKey: p.logicalDeltaKey,
        stage: "test",
        repository: p.repository,
        headSha: p.headSha,
        workflowRunIds: [1],
        jobIds: [1],
        fullWorkloadMs: 92_000,
        testsTotalFull: 46,
        selectedWorkloadMs: undefined,
        selectedWorkloadConfidence: undefined,
        avoidableMs: undefined,
        avoidableTier: "UNKNOWN",
        estimationMethod: undefined,
        testsSelectedDiffci: undefined,
        testsSelectedPath: undefined,
        diffciAnalysisOverheadMs: undefined,
        planMode: undefined,
        estimatorVersion: undefined,
        estimatedAt: undefined,
        schemaVersion: 1,
        observedAt: "2026-08-24T00:00:00Z",
      });
    }
    const before = store.recorded.length;

    const fetched: string[] = [];
    const result = await runShadowEconomicsCaptureSweep(
      {
        shadowBoundary: fakeShadowBoundary(["acme/web"], all),
        store,
        fetchBaseline: async ({ headSha }) => {
          fetched.push(headSha);
          return completeEvidence();
        },
      },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      5,
    );

    assert.equal(result.skippedAlreadyRecorded, 5, "the 5 already-measured predictions must be skipped for free");
    assert.equal(result.predictionsAttempted, 3, "only k6/k7/k8 remain eligible - the backlog is exhausted before the budget is");
    assert.equal(fetched.length, 3, "an already-recorded prediction must never cost a GitHub API call");
    const newKeys = store.recorded.slice(before).map((o) => o.logicalDeltaKey);
    assert.deepEqual([...new Set(newKeys)].sort(), ["k6", "k7", "k8"], "the sweep must reach the backlog, not re-tread the newest 5");
  });

  it("re-running the sweep after the backlog is fully captured does nothing at all - no API calls, no duplicate rows", async () => {
    const store = fakeStore();
    const all = Array.from({ length: 3 }, (_, i) => prediction({ repository: "acme/web", logicalDeltaKey: `k${i + 1}`, headSha: String(i + 1).repeat(40) }));
    let calls = 0;
    const deps = {
      shadowBoundary: fakeShadowBoundary(["acme/web"], all),
      store,
      fetchBaseline: async () => {
        calls++;
        return completeEvidence();
      },
    };
    const first = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 5);
    const callsAfterFirst = calls;
    const rowsAfterFirst = store.recorded.length;

    const second = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 5);

    assert.equal(first.predictionsAttempted, 3);
    assert.equal(second.predictionsAttempted, 0, "nothing left to measure");
    assert.equal(second.skippedAlreadyRecorded, 3);
    assert.equal(calls, callsAfterFirst, "a settled sweep must make ZERO GitHub calls - this is the wasted-API-call half of the bug");
    assert.equal(store.recorded.length, rowsAfterFirst, "idempotent: re-running can never duplicate a measurement");
  });

  it("never spends a token exchange on a repository whose whole window is already measured", async () => {
    const store = fakeStore();
    const p1 = prediction({ repository: "acme/web", logicalDeltaKey: "done-1" });
    await store.recordIfNew({
      logicalDeltaKey: "done-1", stage: "test", repository: "acme/web", headSha: p1.headSha,
      workflowRunIds: [], jobIds: [], fullWorkloadMs: 1000, testsTotalFull: 5,
      selectedWorkloadMs: undefined, selectedWorkloadConfidence: undefined, avoidableMs: undefined,
      avoidableTier: "UNKNOWN", estimationMethod: undefined, testsSelectedDiffci: undefined, testsSelectedPath: undefined, diffciAnalysisOverheadMs: undefined, planMode: undefined, estimatorVersion: undefined, estimatedAt: undefined, schemaVersion: 1, observedAt: "2026-08-24T00:00:00Z",
    });
    const tokenCalls: string[] = [];
    await runShadowEconomicsCaptureSweep(
      { shadowBoundary: fakeShadowBoundary(["acme/web"], [p1]), store, resolveToken: async (r) => { tokenCalls.push(r); return "t"; }, fetchBaseline: async () => completeEvidence() },
      "2026-08-01T00:00:00Z",
      "2026-09-01T00:00:00Z",
      5,
    );
    assert.deepEqual(tokenCalls, [], "no eligible prediction means no credential is needed at all");
  });

  it("a repository with zero enrolled repos produces a clean, zero-activity result, not an error", async () => {
    const store = fakeStore();
    const result = await runShadowEconomicsCaptureSweep({ shadowBoundary: fakeShadowBoundary([], []), store, fetchBaseline: async () => completeEvidence() }, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(result.repositoriesConsidered, 0);
    assert.equal(result.predictionsAttempted, 0);
  });

  it("a repeated sweep of the SAME commit does not double-count captured rows", async () => {
    const store = fakeStore();
    const deps = { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction()]), store, fetchBaseline: async () => completeEvidence() };
    const r1 = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    const r2 = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(r1.stageRowsCaptured, 2);
    assert.equal(r2.stageRowsCaptured, 0);
    // Updated 2026-08-25 with the backlog fix: the second sweep now skips this prediction BEFORE fetching
    // it, so the write-level dedup is never even reached (stageRowsAlreadyRecorded stays 0 and the skip is
    // counted as skippedAlreadyRecorded instead). The guarantee this test exists for - a re-run can never
    // duplicate a measurement - is unchanged and still asserted below; only the layer enforcing it moved
    // earlier, which is the point of the fix. The write-level dedup is still covered as a race safety net
    // by the test immediately following this one.
    assert.equal(r2.stageRowsAlreadyRecorded, 0);
    assert.equal(r2.skippedAlreadyRecorded, 1);
    assert.equal(store.recorded.length, 2); // never duplicated
  });

  it("recordIfNew still dedups when two sweeps race - the pre-scan set can be stale, so the write must stay idempotent", async () => {
    const store = fakeStore();
    // Simulates two sweeps overlapping: both read listRecordedDeltaKeys BEFORE either wrote, so both see
    // an empty set and both proceed to fetch and write the same commit. Only the write-level INSERT OR
    // IGNORE can catch this, which is why the pre-scan does not replace it.
    const racyStore = { ...store, async listRecordedDeltaKeys() { return []; } };
    const deps = { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction()]), store: racyStore, fetchBaseline: async () => completeEvidence() };
    const r1 = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    const r2 = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(r1.stageRowsCaptured, 2);
    assert.equal(r2.stageRowsCaptured, 0, "the racing sweep must write nothing new");
    assert.equal(r2.stageRowsAlreadyRecorded, 2, "it reached the write and INSERT OR IGNORE caught it");
    assert.equal(store.recorded.length, 2, "still exactly one row per (commit, stage)");
  });
});
