/**
 * shadow-stage-economics.ts (2026-09-05, repair step 3): rows carry provenance, inseparable work is
 * measured but never estimated, and a stage with both separable and inseparable buckets keeps the
 * separable one (the other is folded into 'other', never double-counted).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveStageEconomics, type StageEconomicsCandidate } from "../../src/usage/shadow-stage-economics.js";
import { parseStageClassificationConfig } from "../../src/shadow/stage-classification-config.js";
import type { BaselineJobInfo } from "../../src/shadow/types.js";

const candidate: StageEconomicsCandidate = {
  logicalDeltaKey: "acme/web:base:head:v:v",
  repository: "acme/web",
  headSha: "head",
  testsSelectedDiffci: 3,
  testsTotalFull: 200,
  testsSelectedPath: 150,
  planMode: "SELECTIVE",
  diffciAnalysisOverheadMs: 2_500,
};
const run = { workflowRunId: 33710000000, workflowPath: ".github/workflows/ci.yml" };
const NOW = "2026-09-05T07:00:00.000Z";

describe("deriveStageEconomics", () => {
  it("a separable test step under a SELECTIVE plan yields an ESTIMATED row with full provenance", () => {
    const config = parseStageClassificationConfig({ version: 1, jobs: [{ job: "check", stage: "test", inseparable: true }], steps: [{ job: "check", step: "Test", stage: "test" }, { job: "check", step: "Typecheck", stage: "typecheck" }] }).config!;
    const jobs: BaselineJobInfo[] = [{ jobId: 7, jobName: "check", status: "completed", durationMs: 150_000, steps: [{ name: "Typecheck", status: "completed", durationMs: 25_000 }, { name: "Test", status: "completed", durationMs: 100_000 }] }];
    const rows = deriveStageEconomics(candidate, run, jobs, config, NOW);
    const test = rows.find((r) => r.stage === "test")!;
    assert.equal(test.classificationBasis, "explicit_step");
    assert.equal(test.fullWorkloadMs, 100_000);
    assert.equal(test.avoidableTier, "ESTIMATED");
    assert.ok(typeof test.avoidableMs === "number" && test.avoidableMs > 0);
    assert.equal(test.evidenceRunId, "33710000000");
    assert.equal(test.evidenceWorkflowPath, ".github/workflows/ci.yml");
    assert.equal(test.evidenceValidity, "VERIFIED");
    assert.deepEqual(test.stepRefs, ["check :: Test"]);
    assert.equal(test.testsSelectedDiffci, 3);
    assert.equal(test.testsSelectedPath, 150);
    assert.equal(test.diffciAnalysisOverheadMs, 2_500);
    const typecheck = rows.find((r) => r.stage === "typecheck")!;
    assert.equal(typecheck.avoidableTier, "UNKNOWN", "no selection concept for typecheck - never estimated");
    assert.equal(typecheck.testsSelectedDiffci, undefined);
    // The inseparable job remainder (25 s of checkout/npm ci) lost the 'test' slot to the separable step
    // and lands in 'other', never added to the test figure.
    const other = rows.find((r) => r.stage === "other")!;
    assert.equal(other.fullWorkloadMs, 25_000);
    assert.equal(other.classificationBasis, "unclassified");
  });

  it("an inseparable test measurement is recorded with its real duration but NO avoidable estimate", () => {
    const config = parseStageClassificationConfig({ version: 1, jobs: [{ job: "check", stage: "test", inseparable: true }] }).config!;
    const jobs: BaselineJobInfo[] = [{ jobId: 7, jobName: "check", status: "completed", durationMs: 150_000, steps: [{ name: "Run npm run check", status: "completed", durationMs: 140_000 }] }];
    const [row] = deriveStageEconomics(candidate, run, jobs, config, NOW);
    assert.equal(row!.stage, "test");
    assert.equal(row!.classificationBasis, "explicit_job_inseparable");
    assert.equal(row!.fullWorkloadMs, 150_000);
    assert.equal(row!.avoidableTier, "UNKNOWN");
    assert.equal(row!.avoidableMs, undefined);
    assert.equal(row!.estimationMethod, "inseparable_workload");
  });

  it("a FULL plan never reports avoidable work even on a separable test step", () => {
    const config = parseStageClassificationConfig({ version: 1, steps: [{ job: "check", step: "Test", stage: "test" }] }).config!;
    const jobs: BaselineJobInfo[] = [{ jobId: 7, jobName: "check", status: "completed", durationMs: 100_000, steps: [{ name: "Test", status: "completed", durationMs: 100_000 }] }];
    const [row] = deriveStageEconomics({ ...candidate, planMode: "FULL", testsSelectedDiffci: 200 }, run, jobs, config, NOW);
    assert.equal(row!.stage, "test");
    assert.equal(row!.avoidableMs, 0);
  });

  it("no jobs, no rows - never a zero row that reads as 'nothing to save'", () => {
    assert.deepEqual(deriveStageEconomics(candidate, run, [], undefined, NOW), []);
  });
});
