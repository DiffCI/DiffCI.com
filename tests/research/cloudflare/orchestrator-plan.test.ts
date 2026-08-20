import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeExperimentProgress, planOrchestratorDispatch, type CorpusEntry, type RepositoryState } from "../../../src/research/cloudflare/orchestrator-plan.js";

// Built for the 2026-08-21 full Stage 0 orchestrator, whose spec required: bounded concurrency, a safe
// STOP mechanism, RESERVE-mode throttling, giving up on persistently-failing repositories rather than
// retrying forever, and never depending on process-local state (every test here constructs the
// "current state" fresh, exactly as a real orchestrator invocation would after querying D1).

function corpus(n: number): CorpusEntry[] {
  return Array.from({ length: n }, (_, i) => ({ owner: "org", name: `repo${i}`, language: "typescript", targetCommits: 100 }));
}

function state(status: RepositoryState["status"], attempts = 0): RepositoryState {
  return { owner: "org", name: "x", status, orchestratorAttempts: attempts };
}

describe("planOrchestratorDispatch", () => {
  it("dispatches up to `concurrency` repositories from an empty (never-touched) corpus", () => {
    const plan = planOrchestratorDispatch(corpus(20), new Map(), "OK", false, 3);
    assert.equal(plan.toDispatch.length, 3);
    assert.equal(plan.giveUpOn.length, 0);
  });

  it("skips repositories already COMPLETE or EXCLUDED", () => {
    const c = corpus(5);
    const states = new Map([
      ["org/repo0", state("COMPLETE")],
      ["org/repo1", state("EXCLUDED")],
    ]);
    const plan = planOrchestratorDispatch(c, states, "OK", false, 5);
    assert.equal(plan.toDispatch.length, 3);
    assert.ok(!plan.toDispatch.some((r) => r.name === "repo0" || r.name === "repo1"));
  });

  it("never dispatches when stop_requested is set, even with budget remaining and pending work", () => {
    const plan = planOrchestratorDispatch(corpus(20), new Map(), "OK", true, 5);
    assert.equal(plan.toDispatch.length, 0);
    assert.match(plan.reason, /stop_requested/);
  });

  it("never dispatches when budget is BUDGET_STOPPED, even with pending work and no stop request", () => {
    const plan = planOrchestratorDispatch(corpus(20), new Map(), "BUDGET_STOPPED", false, 5);
    assert.equal(plan.toDispatch.length, 0);
    assert.match(plan.reason, /budget/);
  });

  it("stop_requested takes priority over budget status in the reported reason", () => {
    const plan = planOrchestratorDispatch(corpus(20), new Map(), "BUDGET_STOPPED", true, 5);
    assert.match(plan.reason, /stop_requested/);
  });

  it("RESERVE mode caps concurrency at 1 and prioritizes already-RUNNING repositories over PENDING ones", () => {
    const c = corpus(5);
    const states = new Map([
      ["org/repo2", state("RUNNING", 1)], // already has progress
    ]);
    const plan = planOrchestratorDispatch(c, states, "RESERVE", false, 5);
    assert.equal(plan.toDispatch.length, 1, "RESERVE must not start more than one repository at a time");
    assert.equal(plan.toDispatch[0]!.name, "repo2", "the already-started repository should be prioritized over untouched ones");
  });

  it("gives up on a repository once it exhausts its top-level attempt budget, and does not dispatch it again", () => {
    const c = corpus(3);
    const states = new Map([["org/repo0", state("RUNNING", 3)]]); // 3 == maxAttemptsPerRepo default
    const plan = planOrchestratorDispatch(c, states, "OK", false, 5, 3);
    assert.ok(!plan.toDispatch.some((r) => r.name === "repo0"));
    assert.equal(plan.giveUpOn.length, 1);
    assert.equal(plan.giveUpOn[0]!.name, "repo0");
  });

  it("does not re-dispatch a repository already marked FAILED (already given up in a prior invocation)", () => {
    const c = corpus(3);
    const states = new Map([["org/repo0", state("FAILED", 3)]]);
    const plan = planOrchestratorDispatch(c, states, "OK", false, 5);
    assert.ok(!plan.toDispatch.some((r) => r.name === "repo0"));
    assert.equal(plan.giveUpOn.length, 0, "already-FAILED repos should not be reported as newly given up on every call");
  });

  it("reports 'all complete' distinctly from 'nothing to dispatch because of budget/stop'", () => {
    const c = corpus(2);
    const states = new Map([
      ["org/repo0", state("COMPLETE")],
      ["org/repo1", state("EXCLUDED")],
    ]);
    const plan = planOrchestratorDispatch(c, states, "OK", false, 5);
    assert.equal(plan.toDispatch.length, 0);
    assert.match(plan.reason, /complete or excluded/);
  });

  it("is a pure function of its inputs - identical inputs (as if two separate invocations queried the same D1 state) produce identical output", () => {
    const c = corpus(10);
    const states = new Map([["org/repo3", state("RUNNING", 1)]]);
    const planA = planOrchestratorDispatch(c, states, "OK", false, 4);
    const planB = planOrchestratorDispatch(c, new Map(states), "OK", false, 4);
    assert.deepEqual(planA.toDispatch, planB.toDispatch);
  });
});

describe("computeExperimentProgress", () => {
  it("counts every corpus entry into exactly one bucket", () => {
    const c = corpus(6);
    const states = new Map([
      ["org/repo0", state("COMPLETE")],
      ["org/repo1", state("EXCLUDED")],
      ["org/repo2", state("FAILED")],
      ["org/repo3", state("RUNNING")],
      // repo4, repo5 have no state at all - never touched.
    ]);
    const progress = computeExperimentProgress(c, states);
    assert.equal(progress.totalRepositories, 6);
    assert.equal(progress.complete, 1);
    assert.equal(progress.excluded, 1);
    assert.equal(progress.failed, 1);
    assert.equal(progress.running, 1);
    assert.equal(progress.pending, 2);
    assert.equal(progress.complete + progress.excluded + progress.failed + progress.running + progress.pending, 6);
  });

  it("isComplete means 'nothing left to dispatch' (terminal states only) - distinct from 'the experiment succeeded'", () => {
    const c = corpus(3);
    const allSucceeded = new Map([
      ["org/repo0", state("COMPLETE")],
      ["org/repo1", state("EXCLUDED")],
      ["org/repo2", state("COMPLETE")],
    ]);
    const succeeded = computeExperimentProgress(c, allSucceeded);
    assert.equal(succeeded.isComplete, true);
    assert.equal(succeeded.hasFailures, false);

    const oneFailed = new Map([
      ["org/repo0", state("COMPLETE")],
      ["org/repo1", state("EXCLUDED")],
      ["org/repo2", state("FAILED")],
    ]);
    const withFailure = computeExperimentProgress(c, oneFailed);
    assert.equal(withFailure.isComplete, true, "FAILED is a terminal state - the orchestrator has nothing left to dispatch");
    assert.equal(withFailure.hasFailures, true, "but callers must be able to see the experiment did NOT fully succeed");

    const stillRunning = new Map([
      ["org/repo0", state("COMPLETE")],
      ["org/repo1", state("RUNNING")],
    ]);
    assert.equal(computeExperimentProgress(c, stillRunning).isComplete, false, "a RUNNING or PENDING repository means there IS still work to dispatch");
  });
});
