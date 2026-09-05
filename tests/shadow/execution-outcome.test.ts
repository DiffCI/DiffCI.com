/**
 * execution-outcome.ts (2026-09-05, measurement-integrity repair step 2): workflow identity and the
 * repository-outcome vs execution-infrastructure-outcome split, pinned on the real incident shapes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyExecutionOutcome, isRepositoryOutcome, normaliseEvidenceWorkflowPaths, selectEvidenceRun } from "../../src/shadow/execution-outcome.js";
import type { BaselineJobInfo, BaselineRunInfo } from "../../src/shadow/types.js";

function run(overrides: Partial<BaselineRunInfo>): BaselineRunInfo {
  return { workflowPath: ".github/workflows/ci.yml", workflowRunId: 1, runNumber: 1, status: "completed", conclusion: "success", htmlUrl: "", ...overrides };
}
function job(overrides: Partial<BaselineJobInfo>): BaselineJobInfo {
  return { jobId: 1, jobName: "check", status: "completed", ...overrides };
}

describe("selectEvidenceRun", () => {
  it("ignores every run that is not of an identified evidence workflow, however it concluded", () => {
    // DentalPresence.in f13d7502: CodeQL skipped instantly, deploy still running - CodeQL must not win.
    const runs = [
      run({ workflowPath: ".github/workflows/codeql.yml", workflowRunId: 33901025906, conclusion: "skipped" }),
      run({ workflowPath: ".github/workflows/cloudflare-staging-deploy.yml", workflowRunId: 33901025954, status: "in_progress", conclusion: null }),
    ];
    const chosen = selectEvidenceRun(runs, [".github/workflows/cloudflare-staging-deploy.yml"]);
    assert.equal(chosen?.workflowRunId, 33901025954);
    assert.equal(selectEvidenceRun(runs, [".github/workflows/nothing.yml"]), undefined);
  });

  it("picks the latest run (highest id) of the evidence workflow when several exist for the SHA", () => {
    const runs = [run({ workflowRunId: 10, conclusion: "failure" }), run({ workflowRunId: 12, event: "workflow_dispatch" }), run({ workflowRunId: 11 })];
    assert.equal(selectEvidenceRun(runs, [".github/workflows/ci.yml"])?.workflowRunId, 12);
  });
});

describe("classifyExecutionOutcome", () => {
  it("success and failure are the only repository outcomes", () => {
    assert.equal(classifyExecutionOutcome(run({ conclusion: "success" }), [job({ runnerName: "cf-job-1" })]), "EXECUTED");
    assert.equal(classifyExecutionOutcome(run({ conclusion: "failure" }), [job({ runnerName: "cf-job-1", conclusion: "failure" })]), "EXECUTED");
    assert.equal(isRepositoryOutcome("EXECUTED"), true);
    for (const o of ["NOT_EXECUTED_INFRASTRUCTURE", "CANCELLED_DURING_EXECUTION", "SKIPPED", "TIMED_OUT", "NOT_EXECUTED_OTHER"] as const) {
      assert.equal(isRepositoryOutcome(o), false, o);
    }
  });

  it("DiffCI.com Sep 3-4 shape: cancelled after 24 h waiting, no runner ever assigned, zero steps -> infrastructure, not repository", () => {
    const jobs = [job({ jobName: "check", conclusion: "cancelled", runnerName: undefined, steps: [] })];
    assert.equal(classifyExecutionOutcome(run({ conclusion: "cancelled" }), jobs), "NOT_EXECUTED_INFRASTRUCTURE");
  });

  it("cancelled after a job had started is a different, unevaluable population", () => {
    const jobs = [job({ conclusion: "cancelled", runnerName: "cf-job-9", steps: [{ name: "Set up job", status: "completed" }] })];
    assert.equal(classifyExecutionOutcome(run({ conclusion: "cancelled" }), jobs), "CANCELLED_DURING_EXECUTION");
  });

  it("cancelled with no job information at all is classified conservatively, never as infrastructure", () => {
    assert.equal(classifyExecutionOutcome(run({ conclusion: "cancelled" }), []), "CANCELLED_DURING_EXECUTION");
  });

  it("skipped, timed_out and the long tail each keep their own label", () => {
    assert.equal(classifyExecutionOutcome(run({ conclusion: "skipped" }), [job({ conclusion: "skipped" })]), "SKIPPED");
    assert.equal(classifyExecutionOutcome(run({ conclusion: "timed_out" }), [job({ runnerName: "r" })]), "TIMED_OUT");
    for (const c of ["startup_failure", "action_required", "stale", "neutral", null, "something-new"]) {
      assert.equal(classifyExecutionOutcome(run({ conclusion: c }), [job({})]), "NOT_EXECUTED_OTHER", String(c));
    }
  });
});

describe("normaliseEvidenceWorkflowPaths", () => {
  it("accepts only '.github/workflows/<file>.yml|yaml' strings, de-duplicated", () => {
    assert.deepEqual(normaliseEvidenceWorkflowPaths([".github/workflows/ci.yml", ".github/workflows/ci.yml", ".github/workflows/e2e.yaml"]), [".github/workflows/ci.yml", ".github/workflows/e2e.yaml"]);
    assert.equal(normaliseEvidenceWorkflowPaths([]), undefined);
    assert.equal(normaliseEvidenceWorkflowPaths(["ci.yml"]), undefined);
    assert.equal(normaliseEvidenceWorkflowPaths([".github/workflows/../x.yml"]), undefined);
    assert.equal(normaliseEvidenceWorkflowPaths("not-an-array"), undefined);
    assert.equal(normaliseEvidenceWorkflowPaths([".github/workflows/ok.yml", 42]), undefined);
  });
});
