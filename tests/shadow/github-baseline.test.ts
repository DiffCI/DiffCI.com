/**
 * Regression coverage for the 2026-08-21 root-cause fix (Task 2): every real Stage 2 reconciliation
 * attempt was silently 403'd by GitHub's API firewall because fetchBaselineEvidence's outbound requests
 * never set a User-Agent header - Cloudflare Workers' fetch() doesn't add a default one (confirmed live
 * against the deployed Worker), so this was invisible to `npm test` running under Node, which tolerates
 * its absence against this same endpoint. These tests mock global fetch and assert the header is
 * present on every call this module makes - the one thing a purely-logic-level test could never catch,
 * and exactly the class of bug that recurred (see flakiness-check.ts, fixed alongside this).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { fetchBaselineEvidence } from "../../src/shadow/github-baseline.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function installFakeFetch(responder: (url: string) => { status: number; body: unknown }): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  (globalThis as any).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    captured.push({ url, headers: { ...(init?.headers ?? {}) } });
    const { status, body } = responder(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => JSON.stringify(body),
      json: async () => body,
    };
  };
  return captured;
}

const REAL_FETCH = globalThis.fetch;

describe("fetchBaselineEvidence - User-Agent regression (2026-08-21)", () => {
  afterEach(() => {
    (globalThis as any).fetch = REAL_FETCH;
  });

  it("sets a User-Agent header on the runs-list call and every jobs call", async () => {
    const captured = installFakeFetch((url) => {
      if (url.includes("/jobs")) return { status: 200, body: { jobs: [] } };
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 1, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", run_number: 1, html_url: "h", jobs_url: "https://api.github.com/repos/o/r/actions/runs/1/jobs" },
          ],
        },
      };
    });

    await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });

    assert.equal(captured.length, 2, "one runs-list call + one jobs call");
    for (const req of captured) {
      assert.ok(req.headers["User-Agent"], `request to ${req.url} must carry a User-Agent header - GitHub's API firewall 403s requests without one`);
    }
  });

  it("also sets User-Agent on the pending-reason classification call (fired when zero completed runs are found)", async () => {
    const captured = installFakeFetch(() => ({ status: 200, body: { workflow_runs: [] } }));
    await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(captured.length, 2, "runs-list call + the pending-reason classification call");
    for (const req of captured) assert.ok(req.headers["User-Agent"]);
  });
});

describe("fetchBaselineEvidence - pending-reason classification (Task 2 observability)", () => {
  afterEach(() => {
    (globalThis as any).fetch = REAL_FETCH;
  });

  it("classifies no_matching_workflow when GitHub has no record of any run for this SHA at all", async () => {
    installFakeFetch(() => ({ status: 200, body: { workflow_runs: [] } }));
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.pendingReason, "no_matching_workflow");
  });

  it("classifies ci_queued when a non-shadow run exists but hasn't started", async () => {
    let call = 0;
    installFakeFetch((url) => {
      call++;
      if (url.includes("status=completed")) return { status: 200, body: { workflow_runs: [] } };
      return { status: 200, body: { workflow_runs: [{ id: 2, path: ".github/workflows/ci.yml", status: "queued" }] } };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.pendingReason, "ci_queued");
    assert.equal(call, 2);
  });

  it("classifies ci_in_progress when a non-shadow run is currently running", async () => {
    installFakeFetch((url) => {
      if (url.includes("status=completed")) return { status: 200, body: { workflow_runs: [] } };
      return { status: 200, body: { workflow_runs: [{ id: 3, path: ".github/workflows/ci.yml", status: "in_progress" }] } };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.pendingReason, "ci_in_progress");
  });

  it("ignores the shadow workflow itself when classifying - it running/queued must not count as 'CI in progress'", async () => {
    installFakeFetch((url) => {
      if (url.includes("status=completed")) return { status: 200, body: { workflow_runs: [] } };
      return { status: 200, body: { workflow_runs: [{ id: 4, path: ".github/workflows/diffci-shadow.yml", status: "in_progress" }] } };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.pendingReason, "no_matching_workflow", "the only in-flight run is the shadow workflow itself, which must be excluded");
  });

  it("never throws when the classification call itself fails - degrades to no_matching_workflow", async () => {
    installFakeFetch((url) => {
      if (url.includes("status=completed")) return { status: 200, body: { workflow_runs: [] } };
      return { status: 500, body: { message: "internal error" } };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.status, "UNAVAILABLE");
    assert.equal(result.pendingReason, "no_matching_workflow");
    assert.equal(result.fetchError, undefined, "a classification-only failure must not be reported as the whole fetch failing");
  });
});

describe("fetchBaselineEvidence - apiCallsMade (rate-budget accounting)", () => {
  afterEach(() => {
    (globalThis as any).fetch = REAL_FETCH;
  });

  it("counts exactly 1 runs-list call + 1 per observed run's jobs call", async () => {
    installFakeFetch((url) => {
      if (url.includes("/jobs")) return { status: 200, body: { jobs: [] } };
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 1, path: "a.yml", status: "completed", conclusion: "success", run_number: 1, jobs_url: "https://api.github.com/repos/o/r/actions/runs/1/jobs" },
            { id: 2, path: "b.yml", status: "completed", conclusion: "success", run_number: 1, jobs_url: "https://api.github.com/repos/o/r/actions/runs/2/jobs" },
          ],
        },
      };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.apiCallsMade, 3);
  });

  it("counts exactly 2 (runs-list + classification call) when nothing is found", async () => {
    installFakeFetch(() => ({ status: 200, body: { workflow_runs: [] } }));
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.apiCallsMade, 2);
  });

  it("counts exactly 1 when the runs-list call itself throws", async () => {
    installFakeFetch(() => ({ status: 403, body: { message: "forbidden" } }));
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.apiCallsMade, 1);
    assert.ok(result.fetchError);
  });
});

describe("fetchBaselineEvidence - workflow selection", () => {
  afterEach(() => {
    (globalThis as any).fetch = REAL_FETCH;
  });

  it("excludes the shadow workflow's own completed run from fullRunsObserved", async () => {
    installFakeFetch((url) => {
      if (url.includes("/jobs")) return { status: 200, body: { jobs: [{ id: 1, name: "test", status: "completed", conclusion: "success" }] } };
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 1, path: ".github/workflows/diffci-shadow.yml", status: "completed", conclusion: "success", run_number: 1, jobs_url: "https://api.github.com/repos/o/r/actions/runs/1/jobs" },
            { id: 2, path: ".github/workflows/ci.yml", status: "completed", conclusion: "success", run_number: 1, jobs_url: "https://api.github.com/repos/o/r/actions/runs/2/jobs" },
          ],
        },
      };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.status, "COMPLETE");
    assert.deepEqual(result.fullRunsObserved.map((r) => r.workflowPath), [".github/workflows/ci.yml"]);
  });

  it("PARTIAL when a run's jobs fetch fails, rather than silently dropping that run's evidence", async () => {
    installFakeFetch((url) => {
      if (url.includes("/jobs")) return { status: 500, body: { message: "boom" } };
      return {
        status: 200,
        body: {
          workflow_runs: [
            { id: 1, path: "ci.yml", status: "completed", conclusion: "success", run_number: 1, jobs_url: "https://api.github.com/repos/o/r/actions/runs/1/jobs" },
          ],
        },
      };
    });
    const result = await fetchBaselineEvidence({ repository: "o/r", headSha: "sha1" });
    assert.equal(result.status, "PARTIAL");
    assert.ok(result.completenessNotes?.includes("failed to fetch jobs"));
  });
});
