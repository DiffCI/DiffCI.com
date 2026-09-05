/**
 * shadow-reconcile-terminal.ts (2026-09-05): a pending prediction may be terminalised as
 * NO_MATCHING_WORKFLOW only on positive evidence, never on age alone. Each rule has a case that blocks
 * it, plus the one path that succeeds, plus the GitHub confirmation's failure modes.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MIN_PREDICTION_AGE_MS,
  confirmNoWorkflowRuns,
  decideNoMatchingWorkflowTerminal,
  precheckNoMatchingWorkflowTerminal,
  type TerminalCandidateFacts,
} from "../../../src/research/cloudflare/shadow-reconcile-terminal.js";

const NOW = "2026-09-05T04:00:00.000Z";
const nowMs = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

function facts(overrides: Partial<TerminalCandidateFacts> = {}): TerminalCandidateFacts {
  return {
    pendingReason: "no_matching_workflow",
    predictionCreatedAt: "2026-08-22T06:14:16.162Z", // the real oldest stuck DiffCI.com row
    headSha: "066bba4caa660a145ae93fbb0d4d1ca0134bb297",
    previousReason: "no_matching_workflow",
    previousAttemptAt: iso(nowMs - 10 * 60 * 1000), // the previous cron tick
    repositoryHeadSha: "c83e30f0a85e8a248c21226e331b1b5a47d1a92b",
    nowIso: NOW,
    ...overrides,
  };
}

describe("precheckNoMatchingWorkflowTerminal", () => {
  it("accepts the incident shape: repeated no_matching_workflow, old, superseded", () => {
    assert.deepEqual(precheckNoMatchingWorkflowTerminal(facts()), { candidate: true });
  });

  it("rule 1: any other pending reason is never a candidate", () => {
    for (const reason of ["ci_queued", "ci_in_progress", "github_rate_limit", "fetch_error", undefined]) {
      assert.equal(precheckNoMatchingWorkflowTerminal(facts({ pendingReason: reason })).blockedBy, "reason", String(reason));
    }
  });

  it("rule 2: a single observation is not enough - the first no_matching_workflow classification could be a degraded transient error", () => {
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ previousReason: undefined, previousAttemptAt: undefined })).blockedBy, "no_prior_observation");
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ previousReason: "ci_queued" })).blockedBy, "no_prior_observation", "a prior attempt with a different reason does not count");
  });

  it("rule 2: no minimum spacing between the two observations - a small backlog is re-attempted every 10-minute tick and must still be able to terminalise", () => {
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ previousAttemptAt: iso(nowMs - 60 * 1000) })).candidate, true);
  });

  it("rule 3: a young prediction stays pending even with two observations - age is a floor, never the trigger", () => {
    const young = iso(nowMs - MIN_PREDICTION_AGE_MS + 1);
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ predictionCreatedAt: young })).blockedBy, "prediction_age");
  });

  it("rule 4: the repository's current head is never terminalised, and an unknown head blocks too", () => {
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ repositoryHeadSha: facts().headSha })).blockedBy, "current_head");
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ repositoryHeadSha: undefined })).blockedBy, "current_head");
  });

  it("garbage timestamps block rather than throw", () => {
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ previousAttemptAt: "not-a-date" })).blockedBy, "no_prior_observation");
    assert.equal(precheckNoMatchingWorkflowTerminal(facts({ predictionCreatedAt: "not-a-date" })).blockedBy, "prediction_age");
  });
});

describe("decideNoMatchingWorkflowTerminal", () => {
  it("rule 5: without a positive GitHub confirmation the row stays pending", () => {
    assert.deepEqual(decideNoMatchingWorkflowTerminal(facts(), undefined), { terminal: false, blockedBy: "confirmation" });
    assert.equal(decideNoMatchingWorkflowTerminal(facts(), { confirmedNoRuns: false, httpStatus: 502 }).blockedBy, "confirmation");
    assert.equal(decideNoMatchingWorkflowTerminal(facts(), { confirmedNoRuns: false, totalCount: 1, httpStatus: 200 }).blockedBy, "confirmation");
  });

  it("a precheck failure wins over a confirmation - confirmation alone never terminalises", () => {
    const d = decideNoMatchingWorkflowTerminal(facts({ previousReason: undefined }), { confirmedNoRuns: true, totalCount: 0, httpStatus: 200 });
    assert.equal(d.terminal, false);
    assert.equal(d.blockedBy, "no_prior_observation");
  });

  it("all five rules together terminalise with an auditable detail payload", () => {
    const d = decideNoMatchingWorkflowTerminal(facts(), { confirmedNoRuns: true, totalCount: 0, httpStatus: 200 });
    assert.equal(d.terminal, true);
    assert.equal(d.reason, "NO_MATCHING_WORKFLOW");
    assert.equal(d.detail?.workflowRunsForHeadSha, 0);
    assert.equal(d.detail?.supersededByHeadSha, facts().repositoryHeadSha);
    assert.equal(d.detail?.previousAttemptAt, facts().previousAttemptAt);
    assert.equal(d.detail?.decidedAt, NOW);
    assert.equal(d.detail?.predictionAgeMs, nowMs - Date.parse(facts().predictionCreatedAt));
  });
});

describe("confirmNoWorkflowRuns", () => {
  const response = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("confirms only on HTTP 200 with total_count 0 and an empty workflow_runs array", async () => {
    let seenUrl = "";
    let seenHeaders: Record<string, string> = {};
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      seenUrl = String(url);
      seenHeaders = (init?.headers ?? {}) as Record<string, string>;
      return response(200, { total_count: 0, workflow_runs: [] });
    }) as typeof fetch;
    const c = await confirmNoWorkflowRuns("acme/web", "abc123", "tok", fetchImpl);
    assert.deepEqual(c, { confirmedNoRuns: true, totalCount: 0, httpStatus: 200 });
    assert.equal(seenUrl, "https://api.github.com/repos/acme/web/actions/runs?head_sha=abc123&per_page=1");
    assert.equal(seenHeaders["User-Agent"], "diffci-shadow", "GitHub's API firewall 403s Workers requests without a User-Agent");
    assert.equal(seenHeaders.Authorization, "Bearer tok");
  });

  it("any run of any status means not confirmed", async () => {
    const fetchImpl = (async () => response(200, { total_count: 1, workflow_runs: [{ id: 1, status: "queued" }] })) as typeof fetch;
    const c = await confirmNoWorkflowRuns("acme/web", "abc123", undefined, fetchImpl);
    assert.equal(c.confirmedNoRuns, false);
    assert.equal(c.totalCount, 1);
  });

  it("non-200, malformed bodies and thrown fetch errors are all 'not confirmed', never thrown", async () => {
    assert.equal((await confirmNoWorkflowRuns("acme/web", "x", undefined, (async () => response(403, { message: "forbidden" })) as typeof fetch)).confirmedNoRuns, false);
    assert.equal((await confirmNoWorkflowRuns("acme/web", "x", undefined, (async () => response(200, { message: "no fields" })) as typeof fetch)).confirmedNoRuns, false);
    const thrown = await confirmNoWorkflowRuns("acme/web", "x", undefined, (async () => { throw new Error("network down"); }) as typeof fetch);
    assert.equal(thrown.confirmedNoRuns, false);
    assert.equal(thrown.error, "network down");
  });
});
