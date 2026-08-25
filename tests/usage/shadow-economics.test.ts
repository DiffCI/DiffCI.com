import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveShadowEconomicsObservations, computeHistoricalTestSecondsPerTest, SHADOW_ECONOMICS_SCHEMA_VERSION } from "../../src/usage/shadow-economics.js";
import type { BaselineJobInfo, BaselineRunInfo } from "../../src/shadow/types.js";

function job(jobName: string, jobId: number, durationMs?: number): BaselineJobInfo {
  return { jobId, jobName, status: "completed", conclusion: "success", startedAt: undefined, completedAt: undefined, durationMs, steps: undefined };
}
function run(workflowRunId: number): BaselineRunInfo {
  return { workflowPath: ".github/workflows/ci.yml", workflowRunId, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "" };
}

const CANDIDATE = { logicalDeltaKey: "owner/repo:base:head:v1:v1", repository: "owner/repo", headSha: "head", testsSelectedDiffci: 5, testsTotalFull: 70 };
const UNKNOWN_HISTORY = { value: "unknown" as const, confidence: "unavailable" as const };
const REAL_HISTORY = { value: 0.5, confidence: "historical_estimate" as const }; // 0.5s/test

describe("deriveShadowEconomicsObservations", () => {
  it("produces one row per real stage present in the job list", () => {
    const rows = deriveShadowEconomicsObservations(
      CANDIDATE,
      [run(1)],
      [job("unit tests", 1, 30_000), job("build", 2, 45_000), job("eslint", 3, 8_000)],
      UNKNOWN_HISTORY,
      "2026-08-25T00:00:00Z",
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.stage).sort(), ["build", "lint", "test"]);
  });

  it("non-test stages always get fullWorkloadMs (real) but selected/avoidable stay undefined/UNKNOWN - never guessed", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("build", 2, 45_000)], REAL_HISTORY, "2026-08-25T00:00:00Z");
    const buildRow = rows[0]!;
    assert.equal(buildRow.fullWorkloadMs, 45_000);
    assert.equal(buildRow.selectedWorkloadMs, undefined);
    assert.equal(buildRow.avoidableMs, undefined);
    assert.equal(buildRow.avoidableTier, "UNKNOWN");
  });

  it("test stage with NO historical data yet -> real fullWorkloadMs, but selected/avoidable stay UNKNOWN, not guessed", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("unit tests", 1, 30_000)], UNKNOWN_HISTORY, "2026-08-25T00:00:00Z");
    const testRow = rows.find((r) => r.stage === "test")!;
    assert.equal(testRow.fullWorkloadMs, 30_000);
    assert.equal(testRow.selectedWorkloadMs, undefined);
    assert.equal(testRow.avoidableTier, "UNKNOWN");
  });

  it("test stage WITH historical data -> real fullWorkloadMs (measured) + estimated selectedWorkloadMs -> ESTIMATED avoidable (never MEASURED)", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("unit tests", 1, 30_000)], REAL_HISTORY, "2026-08-25T00:00:00Z");
    const testRow = rows.find((r) => r.stage === "test")!;
    assert.equal(testRow.fullWorkloadMs, 30_000);
    assert.equal(testRow.selectedWorkloadMs, 5 * 0.5 * 1000); // testsSelectedDiffci(5) * secondsPerTest(0.5) * 1000
    assert.equal(testRow.selectedWorkloadConfidence, "historical_estimate");
    assert.equal(testRow.avoidableTier, "ESTIMATED");
    assert.ok(testRow.estimationMethod);
  });

  it("a stage with zero real total duration (unmeasurable jobs) is omitted, never a fabricated 0ms row", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("test", 1, undefined)], UNKNOWN_HISTORY, "2026-08-25T00:00:00Z");
    assert.equal(rows.length, 0);
  });

  it("carries real workflow_run_id/job_id provenance through per stage", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(42)], [job("build", 7, 1000)], UNKNOWN_HISTORY, "2026-08-25T00:00:00Z");
    assert.deepEqual(rows[0]!.workflowRunIds, [42]);
    assert.deepEqual(rows[0]!.jobIds, [7]);
  });

  it("stamps every row with the current schema version", () => {
    const rows = deriveShadowEconomicsObservations(CANDIDATE, [run(1)], [job("build", 2, 1000)], UNKNOWN_HISTORY, "2026-08-25T00:00:00Z");
    assert.equal(rows[0]!.schemaVersion, SHADOW_ECONOMICS_SCHEMA_VERSION);
  });

  it("testsTotalFull <= 0 makes even the test stage fall back to the non-test-stage shape (no selection to estimate against)", () => {
    const rows = deriveShadowEconomicsObservations({ ...CANDIDATE, testsTotalFull: 0 }, [run(1)], [job("test", 1, 5000)], REAL_HISTORY, "2026-08-25T00:00:00Z");
    const testRow = rows.find((r) => r.stage === "test")!;
    assert.equal(testRow.testsTotalFull, undefined);
    assert.equal(testRow.avoidableTier, "UNKNOWN");
  });
});

describe("computeHistoricalTestSecondsPerTest", () => {
  it("unavailable with no observations", () => {
    assert.deepEqual(computeHistoricalTestSecondsPerTest([]), { value: "unknown", confidence: "unavailable" });
  });

  it("a real average across this repository's OWN test-stage observations only", () => {
    const r = computeHistoricalTestSecondsPerTest([
      { fullWorkloadMs: 35_000, testsTotalFull: 70 }, // 0.5s/test
      { fullWorkloadMs: 70_000, testsTotalFull: 70 }, // 1.0s/test
    ]);
    assert.equal(r.confidence, "historical_estimate");
    assert.equal(r.value, 0.75); // average of 0.5 and 1.0
  });

  it("ignores rows with no known testsTotalFull rather than dividing by an assumed count", () => {
    const r = computeHistoricalTestSecondsPerTest([{ fullWorkloadMs: 35_000, testsTotalFull: undefined }]);
    assert.deepEqual(r, { value: "unknown", confidence: "unavailable" });
  });
});
