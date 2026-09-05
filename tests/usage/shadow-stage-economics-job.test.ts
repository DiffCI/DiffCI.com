/**
 * shadow-stage-economics-job.ts (2026-09-05, repair step 3): the sweep consumes VERIFIED ground truth
 * only, fetches the jobs of that row's evidence run by id, spends no call on already-measured rows,
 * and is fair across repositories.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runStageEconomicsCaptureSweep } from "../../src/usage/shadow-stage-economics-job.js";
import type { ShadowReadBoundary, ShadowVerifiedGroundTruth } from "../../src/product/shadow-read-boundary.js";
import type { ShadowStageEconomicsStore } from "../../src/usage/shadow-stage-economics-store.js";
import type { StageEconomicsObservation } from "../../src/usage/shadow-stage-economics.js";
import { parseStageClassificationConfig } from "../../src/shadow/stage-classification-config.js";
import type { BaselineJobInfo } from "../../src/shadow/types.js";

function verified(repository: string, key: string, runId: string): ShadowVerifiedGroundTruth {
  return { logicalDeltaKey: key, repository, headSha: key, evidenceRunId: runId, evidenceWorkflowPath: ".github/workflows/ci.yml", planMode: "SELECTIVE", testsSelectedDiffci: 2, testsTotalFull: 100, testsSelectedPath: 50, diffciAnalysisOverheadMs: 1000, predictionCreatedAt: "2026-09-04T00:00:00.000Z" };
}

function boundary(rowsByRepo: Record<string, ShadowVerifiedGroundTruth[]>): ShadowReadBoundary {
  return {
    listEnrolledRepositories: async () => Object.keys(rowsByRepo),
    listVerifiedGroundTruth: async (repo) => rowsByRepo[repo] ?? [],
    listPredictions: async () => { throw new Error("the stage sweep must never read unverified predictions"); },
    getGroundTruthForDelta: async () => null,
    getSafetySnapshot: async () => { throw new Error("not used"); },
    getEvidenceWorkflowState: async (ownerName) => ({ ownerName, state: "identified" as const, paths: [".github/workflows/ci.yml"] }),
    getReportAccess: async () => ({ isPrivate: false }),
  };
}

function store(existing: string[] = []): ShadowStageEconomicsStore & { written: StageEconomicsObservation[] } {
  const written: StageEconomicsObservation[] = [];
  return {
    written,
    recordIfNew: async (o) => { written.push(o); return true; },
    listRecordedDeltaKeys: async () => existing,
    listForPredictionWindow: async () => [],
  };
}

const CONFIG = parseStageClassificationConfig({ version: 1, steps: [{ job: "check", step: "Test", stage: "test" }], jobs: [{ job: "check", stage: "test", inseparable: true }] }).config!;
const JOBS: BaselineJobInfo[] = [{ jobId: 1, jobName: "check", status: "completed", durationMs: 100_000, steps: [{ name: "Test", status: "completed", durationMs: 80_000 }] }];

describe("runStageEconomicsCaptureSweep", () => {
  it("reads only verified ground truth, fetches the evidence run's jobs by id, and writes classified rows with provenance", async () => {
    const fetched: string[] = [];
    const s = store();
    const result = await runStageEconomicsCaptureSweep(
      {
        shadowBoundary: boundary({ "acme/web": [verified("acme/web", "k1", "111"), verified("acme/web", "k2", "222")] }),
        store: s,
        resolveClassification: async () => CONFIG,
        fetchJobs: async (_repo, runId) => { fetched.push(runId); return JOBS; },
        nowIso: () => "2026-09-05T07:00:00.000Z",
      },
      "2026-08-06T00:00:00.000Z", "2026-09-05T08:00:00.000Z", 10,
    );
    assert.deepEqual(fetched, ["111", "222"], "one jobs call per admitted prediction, by evidence run id");
    assert.equal(result.predictionsAttempted, 2);
    assert.equal(result.stageRowsCaptured, 4, "test (separable) + other (inseparable remainder) per prediction");
    assert.equal(s.written.every((o) => o.evidenceValidity === "VERIFIED" && o.evidenceRunId.length > 0), true);
    assert.deepEqual(result.unconfiguredRepositories, []);
  });

  it("skips already-measured rows for free and reports repositories without configuration", async () => {
    const fetched: string[] = [];
    const result = await runStageEconomicsCaptureSweep(
      {
        shadowBoundary: boundary({ "acme/web": [verified("acme/web", "k1", "111"), verified("acme/web", "k2", "222")] }),
        store: store(["k1"]),
        resolveClassification: async () => undefined,
        fetchJobs: async (_repo, runId) => { fetched.push(runId); return JOBS; },
      },
      "2026-08-06T00:00:00.000Z", "2026-09-05T08:00:00.000Z", 10,
    );
    assert.deepEqual(fetched, ["222"]);
    assert.equal(result.skippedAlreadyRecorded, 1);
    assert.deepEqual(result.unconfiguredRepositories, ["acme/web"]);
  });

  it("round-robins across repositories under the per-sweep budget", async () => {
    const fetched: string[] = [];
    const result = await runStageEconomicsCaptureSweep(
      {
        shadowBoundary: boundary({
          "acme/busy": [verified("acme/busy", "b1", "1"), verified("acme/busy", "b2", "2"), verified("acme/busy", "b3", "3")],
          "acme/quiet": [verified("acme/quiet", "q1", "9")],
        }),
        store: store(),
        resolveClassification: async () => CONFIG,
        fetchJobs: async (_repo, runId) => { fetched.push(runId); return JOBS; },
      },
      "2026-08-06T00:00:00.000Z", "2026-09-05T08:00:00.000Z", 2,
    );
    assert.deepEqual(fetched, ["1", "9"], "the quiet repository is reached before the busy one's second row");
    assert.equal(result.predictionsAttempted, 2);
  });

  it("a jobs fetch failure is counted and skipped, never thrown, never written", async () => {
    const s = store();
    const result = await runStageEconomicsCaptureSweep(
      {
        shadowBoundary: boundary({ "acme/web": [verified("acme/web", "k1", "111")] }),
        store: s,
        resolveClassification: async () => CONFIG,
        fetchJobs: async () => { throw new Error("GitHub API 502"); },
      },
      "2026-08-06T00:00:00.000Z", "2026-09-05T08:00:00.000Z", 10,
    );
    assert.equal(result.fetchErrors, 1);
    assert.equal(s.written.length, 0);
  });
});
