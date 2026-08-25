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
    async listTestStageObservations(repository, limit) {
      return recorded.filter((o) => o.repository === repository && o.stage === "test").slice(0, limit);
    },
    async listForReport(repository) {
      return recorded.filter((o) => o.repository === repository);
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
    assert.equal(testRow.avoidableTier, "UNKNOWN"); // no history yet on the first-ever capture
    const buildRow = store.recorded.find((r) => r.stage === "build")!;
    assert.equal(buildRow.fullWorkloadMs, 45_000);
    assert.equal(buildRow.selectedWorkloadMs, undefined); // v1 cannot classify build economics
  });

  it("a repeated capture for the same commit benefits from the FIRST capture's own history - second call's test stage becomes ESTIMATED", async () => {
    const store = fakeStore();
    const deps = { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction({ logicalDeltaKey: "k1", headSha: "1".repeat(40) })]), store, fetchBaseline: async () => completeEvidence(), nowIso: () => "2026-08-25T00:00:00Z" };
    await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);

    const deps2 = { ...deps, shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction({ logicalDeltaKey: "k2", headSha: "2".repeat(40) })]) };
    await runShadowEconomicsCaptureSweep(deps2, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);

    const secondTestRow = store.recorded.find((r) => r.logicalDeltaKey === "k2" && r.stage === "test")!;
    assert.equal(secondTestRow.avoidableTier, "ESTIMATED"); // real history now exists from the first capture
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

  it("a repository with zero enrolled repos produces a clean, zero-activity result, not an error", async () => {
    const store = fakeStore();
    const result = await runShadowEconomicsCaptureSweep({ shadowBoundary: fakeShadowBoundary([], []), store, fetchBaseline: async () => completeEvidence() }, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(result.repositoriesConsidered, 0);
    assert.equal(result.predictionsAttempted, 0);
  });

  it("a repeated sweep of the SAME commit does not double-count captured rows - idempotent via the store's own dedup", async () => {
    const store = fakeStore();
    const deps = { shadowBoundary: fakeShadowBoundary(["acme/web"], [prediction()]), store, fetchBaseline: async () => completeEvidence() };
    const r1 = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    const r2 = await runShadowEconomicsCaptureSweep(deps, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z", 10);
    assert.equal(r1.stageRowsCaptured, 2);
    assert.equal(r2.stageRowsCaptured, 0);
    assert.equal(r2.stageRowsAlreadyRecorded, 2);
    assert.equal(store.recorded.length, 2); // never duplicated
  });
});
