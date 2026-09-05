/**
 * fetchBaselineEvidence in workflow identity mode (2026-09-05, measurement-integrity repair step 2).
 * The two real incident shapes from docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md
 * are pinned here: DiffCI.com's 24 h-queued-then-cancelled CI runs (F2) and DentalPresence.in's
 * instantly-skipped CodeQL run finalising a commit before the deploy/test run finished (F3).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchBaselineEvidence } from "../../src/shadow/github-baseline.js";

interface CapturedRequest {
  url: string;
}

function installFakeFetch(responder: (url: string) => { status: number; body: unknown }): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  (globalThis as any).fetch = async (url: string) => {
    captured.push({ url });
    const { status, body } = responder(url);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
  };
  return captured;
}

const REAL_FETCH = globalThis.fetch;
const CI = ".github/workflows/ci.yml";
const OBSERVE = ".github/workflows/diffci-observe.yml";

describe("fetchBaselineEvidence - workflow identity mode", () => {
  afterEach(() => {
    (globalThis as any).fetch = REAL_FETCH;
  });

  it("DiffCI.com Sep 3-4 shape: CI cancelled after 24 h with no runner, self-observation succeeded -> evidence_run_not_executed / NOT_EXECUTED_INFRASTRUCTURE, never ground truth", async () => {
    const captured = installFakeFetch((url) => {
      if (url.includes("/runs/33757508013/jobs")) return { status: 200, body: { jobs: [{ id: 100655379633, name: "check", status: "completed", conclusion: "cancelled", runner_name: "", steps: [] }] } };
      if (url.includes("/jobs")) throw new Error("must not fetch jobs for a non-evidence run");
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 33757508010, path: OBSERVE, status: "completed", conclusion: "success", run_number: 5, run_attempt: 1, event: "push" },
            { id: 33757508013, path: CI, status: "completed", conclusion: "cancelled", run_number: 7, run_attempt: 1, event: "push", html_url: "https://github.com/o/r/actions/runs/33757508013" },
          ],
        },
      };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "bb78c115", evidenceWorkflowPaths: [CI] });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.pendingReason, "evidence_run_not_executed");
    assert.equal(result.executionOutcome, "NOT_EXECUTED_INFRASTRUCTURE");
    assert.equal(result.evidenceRun?.workflowRunId, 33757508013);
    assert.equal(result.evidenceRun?.runAttempt, 1);
    assert.deepEqual(result.fullRunsObserved.map((r) => r.workflowRunId), [33757508013]);
    assert.deepEqual(result.otherRunsObserved?.map((r) => r.workflowPath), [OBSERVE], "the observation run is audit, not evidence");
    assert.equal(result.jobs.length, 1, "the never-started job stays attached as the audit trail");
    assert.equal(result.failedJobNames.length, 0);
    assert.ok(captured[0]!.url.includes("per_page=30") && !captured[0]!.url.includes("status=completed"), "identity mode lists every status in one call");
    assert.equal(result.apiCallsMade, 2);
  });

  it("DentalPresence.in shape: CodeQL skipped instantly, deploy in progress -> ci_in_progress; the skipped run cannot finalise the commit", async () => {
    installFakeFetch(() => ({
      status: 200,
      body: {
        workflow_runs: [
          { id: 33901025906, path: ".github/workflows/codeql.yml", status: "completed", conclusion: "skipped", run_number: 383 },
          { id: 33901025954, path: ".github/workflows/cloudflare-staging-deploy.yml", status: "in_progress", conclusion: null, run_number: 200 },
        ],
      },
    }));
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "f13d7502", evidenceWorkflowPaths: [".github/workflows/cloudflare-staging-deploy.yml"] });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.pendingReason, "ci_in_progress");
    assert.equal(result.evidenceRun?.workflowRunId, 33901025954);
    assert.equal(result.apiCallsMade, 1);
  });

  it("an executed evidence run yields COMPLETE evidence built from that run's jobs only", async () => {
    installFakeFetch((url) => {
      if (url.includes("/runs/2/jobs")) {
        return { status: 200, body: { jobs: [{ id: 21, name: "check", status: "completed", conclusion: "failure", runner_name: "cf-job-1", started_at: "2026-09-02T10:00:00Z", completed_at: "2026-09-02T10:02:00Z", steps: [{ name: "run", status: "completed", conclusion: "failure" }] }] } };
      }
      if (url.includes("/jobs")) throw new Error("must not fetch jobs for a non-evidence run");
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 1, path: OBSERVE, status: "completed", conclusion: "success", run_number: 1 },
            { id: 2, path: CI, status: "completed", conclusion: "failure", run_number: 2, run_attempt: 2 },
          ],
        },
      };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha", evidenceWorkflowPaths: [CI] });
    assert.equal(result.status, "COMPLETE");
    assert.equal(result.executionOutcome, "EXECUTED");
    assert.deepEqual(result.failedJobNames, ["check"]);
    assert.equal(result.evidenceRun?.runAttempt, 2);
    assert.equal(result.baselineDurationMs, 120_000);
    assert.equal(result.jobs.every((j) => j.jobName === "check"), true, "no job from the observation run leaks into the evidence");
  });

  it("other workflows ran but the evidence workflow did not -> evidence_workflow_run_missing, distinct from no_matching_workflow", async () => {
    installFakeFetch(() => ({ status: 200, body: { workflow_runs: [{ id: 9, path: ".github/workflows/codeql.yml", status: "completed", conclusion: "success", run_number: 1 }] } }));
    const missing = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha", evidenceWorkflowPaths: [CI] });
    assert.equal(missing.pendingReason, "evidence_workflow_run_missing");
    installFakeFetch(() => ({ status: 200, body: { workflow_runs: [] } }));
    const none = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha", evidenceWorkflowPaths: [CI] });
    assert.equal(none.pendingReason, "no_matching_workflow");
  });

  it("legacy mode (no evidenceWorkflowPaths) keeps the old behaviour: completed-only listing, every non-shadow run", async () => {
    const captured = installFakeFetch((url) => {
      if (url.includes("/jobs")) return { status: 200, body: { jobs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } };
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 1, path: OBSERVE, status: "completed", conclusion: "success", run_number: 1, jobs_url: "https://api.github.com/repos/o/r/actions/runs/1/jobs" },
            { id: 2, path: CI, status: "completed", conclusion: "success", run_number: 2, jobs_url: "https://api.github.com/repos/o/r/actions/runs/2/jobs" },
          ],
        },
      };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha" });
    assert.ok(captured[0]!.url.includes("status=completed"));
    assert.equal(result.fullRunsObserved.length, 2);
    assert.equal(result.evidenceRun, undefined);
    assert.equal(result.executionOutcome, undefined);
  });
});
