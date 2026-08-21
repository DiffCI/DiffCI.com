/**
 * Regression coverage for the same 2026-08-21 missing-User-Agent bug fixed in github-baseline.ts -
 * flakiness-check.ts's own githubFetch had the identical gap, not yet triggered by real traffic (every
 * observed prediction's CI has passed so far, so checkJobFlakiness was never actually invoked in
 * production) but would hit the identical GitHub API firewall 403 the moment a real failure needed a
 * flakiness check.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { checkJobFlakiness } from "../../../src/research/historical/flakiness-check.js";
import { createRateBudget } from "../../../src/research/historical/rate-budget.js";

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

function installFakeFetch(responder: (url: string) => { status: number; body: unknown }): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  (globalThis as any).fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    captured.push({ url, headers: { ...(init?.headers ?? {}) } });
    const { status, body } = responder(url);
    return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body), json: async () => body };
  };
  return captured;
}

const REAL_FETCH = globalThis.fetch;

describe("checkJobFlakiness - User-Agent regression (2026-08-21)", () => {
  afterEach(() => {
    (globalThis as any).fetch = REAL_FETCH;
  });

  it("sets a User-Agent header on the nearby-commits call and every check-runs call", async () => {
    const captured = installFakeFetch((url) => {
      if (url.includes("/commits/")) return { status: 200, body: { check_runs: [{ name: "test", conclusion: "success" }] } };
      return { status: 200, body: [{ sha: "s1" }, { sha: "s2" }] };
    });
    await checkJobFlakiness({ repository: "o/r", jobName: "test", aroundSha: "head", budget: createRateBudget(50) });
    assert.ok(captured.length >= 2);
    for (const req of captured) assert.ok(req.headers["User-Agent"], `request to ${req.url} must carry a User-Agent header`);
  });

  it("degrades to checked:false rather than throwing when the API call fails (still true after the header fix)", async () => {
    installFakeFetch(() => ({ status: 403, body: { message: "forbidden" } }));
    const result = await checkJobFlakiness({ repository: "o/r", jobName: "test", aroundSha: "head", budget: createRateBudget(50) });
    assert.equal(result.checked, false);
    assert.match(result.reason ?? "", /fetch_error/);
  });

  it("reports likelyFlaky when the same job succeeds on most nearby commits", async () => {
    installFakeFetch((url) => {
      if (url.includes("/commits/")) return { status: 200, body: { check_runs: [{ name: "flaky-job", conclusion: "success" }] } };
      return { status: 200, body: [{ sha: "s1" }, { sha: "s2" }, { sha: "s3" }] };
    });
    const result = await checkJobFlakiness({ repository: "o/r", jobName: "flaky-job", aroundSha: "head", budget: createRateBudget(50) });
    assert.equal(result.checked, true);
    assert.equal(result.likelyFlaky, true);
  });
});
