import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reconcilePrediction, type PendingPrediction } from "../../src/shadow/reconcile.js";
import { createRateBudget } from "../../src/research/historical/rate-budget.js";
import type { ExecutionPlan } from "../../src/planner/types.js";
import type { BaselineEvidence } from "../../src/shadow/types.js";

const PLAN: ExecutionPlan = {
  version: "1",
  mode: "SELECTIVE",
  tasks: [
    { id: "test:unit", command: "npm test", category: "test", status: "RUN", reason: "matched", alwaysRun: false, triggeredBy: [] },
    { id: "test:e2e", command: "npm run e2e", category: "test", status: "SKIP_CANDIDATE", reason: "no match", alwaysRun: false, triggeredBy: [] },
  ],
  selectedTests: ["unit.test.ts"],
  skippedTests: ["e2e.test.ts"],
  alwaysRunTasks: [],
  fallbackReasons: [],
  evidence: [],
  safety: { graphConfidence: "COMPLETE", impactStatus: "SAFE_TO_PROPOSE", fallbackRequired: false },
  commandSpecs: [],
};

function baseline(overrides: Partial<BaselineEvidence>): BaselineEvidence {
  return {
    repository: "unjs/defu",
    headSha: "head123",
    status: "UNAVAILABLE",
    fullRunsObserved: [],
    jobs: [],
    failedJobNames: [],
    failedTaskIds: [],
    ...overrides,
  };
}

function makePrediction(overrides: Partial<PendingPrediction> = {}): PendingPrediction {
  return {
    logicalDeltaKey: "unjs/defu:base:head123:v1:g1",
    repository: "unjs/defu",
    headSha: "head123",
    plan: PLAN,
    pathSelectedTaskIds: ["test:unit", "test:e2e"], // PATH runs everything (coarse baseline)
    diffciAnalysisOverheadMs: 500,
    predictionCreatedAt: "2026-08-21T10:00:00.000Z",
    ...overrides,
  };
}

describe("reconcilePrediction", () => {
  it("returns STILL_PENDING (not an error, not a miss) when no completed CI run exists yet", async () => {
    const result = await reconcilePrediction(makePrediction(), {
      budget: createRateBudget(50, 0),
      fetchFn: async () => baseline({ status: "UNAVAILABLE", completenessNotes: "no completed non-shadow CI runs found for this commit" }),
    });
    assert.equal(result.status, "STILL_PENDING");
    assert.equal(result.relevantFailuresObserved, undefined, "must never report a recall number from an empty/unavailable denominator");
  });

  it("computes DiffCI's real unsafe miss when a SKIP_CANDIDATE test-category task really failed", async () => {
    const result = await reconcilePrediction(makePrediction(), {
      budget: createRateBudget(50, 0),
      checkFlakiness: false,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 42, runNumber: 1, status: "completed", conclusion: "failure", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:e2e", status: "completed", conclusion: "failure", completedAt: "2026-08-21T10:05:00.000Z" }],
          failedJobNames: ["test:e2e"],
        }),
    });

    assert.equal(result.status, "RECONCILED");
    assert.equal(result.groundTruthStatus, "COMPLETE");
    assert.equal(result.relevantFailuresObserved, 1);
    assert.equal(result.relevantFailuresEvaluable, 1);
    assert.equal(result.failuresPreservedByDiffci, 0, "test:e2e was SKIP_CANDIDATE - DiffCI would have missed this real failure");
    assert.equal(result.failuresPreservedByPath, 1, "PATH selected everything, so it preserved this failure");
    assert.deepEqual(result.diffciHypotheticalUnsafeMisses, ["test:e2e"]);
    assert.deepEqual(result.pathHypotheticalUnsafeMisses, []);
    assert.equal(result.diffciProspectiveRecallPercent, 0);
    assert.equal(result.pathProspectiveRecallPercent, 100);
  });

  it("reports the prospectiveness proof as true when the prediction genuinely preceded the real completion", async () => {
    const result = await reconcilePrediction(makePrediction({ predictionCreatedAt: "2026-08-21T09:00:00.000Z" }), {
      budget: createRateBudget(50, 0),
      checkFlakiness: false,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 42, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:unit", status: "completed", conclusion: "success", completedAt: "2026-08-21T10:05:00.000Z" }],
        }),
    });
    assert.equal(result.predictionPrecededGroundTruth, true);
  });

  it("reports the prospectiveness proof as FALSE when the prediction was recorded after the real outcome - a red flag, never hidden", async () => {
    const result = await reconcilePrediction(makePrediction({ predictionCreatedAt: "2026-08-21T11:00:00.000Z" }), {
      budget: createRateBudget(50, 0),
      checkFlakiness: false,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 42, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:unit", status: "completed", conclusion: "success", completedAt: "2026-08-21T10:05:00.000Z" }],
        }),
    });
    assert.equal(result.predictionPrecededGroundTruth, false);
  });

  it("excludes a likely-flaky failure from the real-failure denominator via the injected flakiness checker", async () => {
    const result = await reconcilePrediction(makePrediction(), {
      budget: createRateBudget(50, 0),
      checkFlakiness: true,
      fetchFn: async () =>
        baseline({
          status: "COMPLETE",
          fullRunsObserved: [{ workflowPath: ".github/workflows/ci.yml", workflowRunId: 42, runNumber: 1, status: "completed", conclusion: "failure", htmlUrl: "" }],
          jobs: [{ jobId: 1, jobName: "test:e2e", status: "completed", conclusion: "failure", completedAt: "2026-08-21T10:05:00.000Z" }],
          failedJobNames: ["test:e2e"],
        }),
      flakinessCheckFn: async () => ({ checked: true, nearbyCommitsChecked: 5, nearbySuccesses: 4, likelyFlaky: true, reason: "4/5 nearby succeeded" }),
    });

    assert.equal(result.relevantFailuresObserved, 1, "the raw observation is still counted");
    assert.equal(result.relevantFailuresEvaluable, 0, "excluded from the real-failure denominator once flagged flaky");
    assert.deepEqual(result.likelyFlakyExcludedTargets, ["test:e2e"]);
    assert.deepEqual(result.diffciHypotheticalUnsafeMisses, [], "a flaky failure must not count as a genuine unsafe miss");
  });
});
