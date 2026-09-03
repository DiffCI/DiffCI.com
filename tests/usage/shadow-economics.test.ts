import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveShadowEconomicsObservations, SHADOW_ECONOMICS_SCHEMA_VERSION } from "../../src/usage/shadow-economics.js";
import { ESTIMATOR_VERSION } from "../../src/usage/economics-estimator.js";
import type { BaselineJobInfo, BaselineRunInfo } from "../../src/shadow/types.js";

function job(jobName: string, jobId: number, durationMs?: number): BaselineJobInfo {
  return { jobId, jobName, status: "completed", conclusion: "success", startedAt: undefined, completedAt: undefined, durationMs, steps: undefined };
}
function run(workflowRunId: number): BaselineRunInfo {
  return { workflowPath: ".github/workflows/ci.yml", workflowRunId, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" };
}

const CANDIDATE = {
  logicalDeltaKey: "owner/repo:base:head:v1:v1",
  repository: "owner/repo",
  headSha: "head",
  testsSelectedDiffci: 5,
  testsTotalFull: 70,
  testsSelectedPath: 70,
  diffciAnalysisOverheadMs: 200,
  planMode: "SELECTIVE" as const,
};

describe("deriveShadowEconomicsObservations", () => {
  it("produces one row per real stage present in the job list", () => {
    const rows = deriveShadowEconomicsObservations(
      CANDIDATE,
      [run(1)],
      [job("unit tests", 1, 30_000), job("build", 2, 45_000), job("eslint", 3, 8_000)],
      "2026-08-25T00:00:00Z",
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.stage).sort(), ["build", "lint", "test"]);
  });

  it("non-test stages always get fullWorkloadMs (real) but selected/avoidable stay undefined/UNKNOWN - never guessed", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("build", 2, 45_000)], "2026-08-25T00:00:00Z");
    const buildRow = rows[0]!;
    assert.equal(buildRow.fullWorkloadMs, 45_000);
    assert.equal(buildRow.selectedWorkloadMs, undefined);
    assert.equal(buildRow.avoidableMs, undefined);
    assert.equal(buildRow.avoidableTier, "UNKNOWN");
  });

  // Estimator v2: no history is needed at all - the counterfactual is anchored to THIS commit's own
  // measured workload, so the very first capture of a repository is immediately estimable. Under v1 this
  // row would have been UNKNOWN until some other commit had been captured first.
  it("test stage is estimable on the FIRST capture, with no prior history - 5/70 of a 30s suite", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("unit tests", 1, 30_000)], "2026-08-25T00:00:00Z");
    const testRow = rows.find((r) => r.stage === "test")!;
    assert.equal(testRow.fullWorkloadMs, 30_000);
    assert.equal(testRow.selectedWorkloadMs, (30_000 * 5) / 70);
    assert.equal(testRow.selectedWorkloadConfidence, "count_based_estimate");
    assert.equal(testRow.avoidableTier, "ESTIMATED", "a counterfactual is never MEASURED in shadow mode");
    assert.ok(testRow.estimationMethod);
  });

  it("a FULL plan gets a test row with exactly zero avoidable, never a variance-derived number", () => {
    const rows = deriveShadowEconomicsObservations(
      { ...CANDIDATE, planMode: "FULL", testsSelectedDiffci: 70 },
      [run(1)],
      [job("unit tests", 1, 63_000)],
      "2026-08-25T00:00:00Z",
    );
    const testRow = rows.find((r) => r.stage === "test")!;
    assert.equal(testRow.selectedWorkloadMs, 63_000);
    assert.equal(testRow.avoidableMs, 0);
  });

  it("a stage with zero real total duration (unmeasurable jobs) is omitted, never a fabricated 0ms row", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("test", 1, undefined)], "2026-08-25T00:00:00Z");
    assert.equal(rows.length, 0);
  });

  it("carries real workflow_run_id/job_id provenance through per stage", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(42)], [job("build", 7, 1000)], "2026-08-25T00:00:00Z");
    assert.deepEqual(rows[0]!.workflowRunIds, [42]);
    assert.deepEqual(rows[0]!.jobIds, [7]);
  });

  it("stamps every row with the current schema and estimator versions", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("build", 2, 1000)], "2026-08-25T00:00:00Z");
    assert.equal(rows[0]!.schemaVersion, SHADOW_ECONOMICS_SCHEMA_VERSION);
    assert.equal(rows[0]!.estimatorVersion, ESTIMATOR_VERSION, "provenance is what lets the recompute sweep find stale rows");
    assert.equal(rows[0]!.estimatedAt, "2026-08-25T00:00:00Z");
  });

  it("persists the raw estimate inputs on test rows so a later recompute is self-contained", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("unit tests", 1, 30_000)], "2026-08-25T00:00:00Z");
    const testRow = rows.find((r) => r.stage === "test")!;
    assert.equal(testRow.testsSelectedDiffci, 5);
    assert.equal(testRow.testsTotalFull, 70);
    assert.equal(testRow.planMode, "SELECTIVE");
  });

  it("testsTotalFull <= 0 refuses the estimate but PRESERVES the degenerate raw count rather than nulling it", () => {
    const rows = deriveShadowEconomicsObservations({ ...CANDIDATE, testsTotalFull: 0 }, [run(1)], [job("test", 1, 5000)], "2026-08-25T00:00:00Z");
    const testRow = rows.find((r) => r.stage === "test")!;
    // 0 is a real fact about the prediction ("it reported zero total tests") and is diagnostically
    // useful; NULL would say "not applicable" and lose that. The estimator refuses either way.
    assert.equal(testRow.testsTotalFull, 0);
    assert.equal(testRow.avoidableTier, "UNKNOWN");
    assert.equal(testRow.avoidableMs, undefined);
    assert.equal(testRow.selectedWorkloadMs, undefined);
  });
});
