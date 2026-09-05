/**
 * runner-dispatch.ts (2026-09-05, repair step 4): job-unique label pinning, message parsing, the
 * reconciler's decisions, and start-error classification - pinned on the live incident shape (a runner
 * spawned for job 101267766892 served job 101260055348).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  MAX_DISPATCH_ATTEMPTS,
  MIN_QUEUED_AGE_MS,
  STALE_DISPATCH_MS,
  classifyStartError,
  decideReconcileDispatches,
  isPinned,
  jobAddressedToFleet,
  parseDispatchMessage,
  registrationLabels,
  type LifecycleView,
  type QueuedJobView,
} from "../../../src/research/cloudflare/runner-dispatch.js";

const NOW = "2026-09-05T08:00:00.000Z";
const nowMs = Date.parse(NOW);
const iso = (ms: number) => new Date(ms).toISOString();

describe("labels", () => {
  it("a pinned job or a legacy plain-label job is ours; anything else is not", () => {
    assert.equal(jobAddressedToFleet(["self-hosted", "cloudflare"]), true);
    assert.equal(jobAddressedToFleet(["self-hosted", "diffci-job-33953059449"]), true);
    assert.equal(jobAddressedToFleet(["self-hosted", "cloudflare", "diffci-job-33951761194"]), true);
    assert.equal(jobAddressedToFleet(["ubuntu-latest"]), false);
    assert.equal(jobAddressedToFleet(["self-hosted", "linux"]), false);
    assert.equal(jobAddressedToFleet(["diffci-job-1"]), false, "self-hosted is what routes a job away from GitHub-hosted runners");
    assert.equal(isPinned(["self-hosted", "diffci-job-33953059449"]), true);
    assert.equal(isPinned(["self-hosted", "cloudflare"]), false);
  });

  it("a pinned runner registers with the pin label ONLY, so a legacy plain-label job can never be handed it; a legacy runner registers plain", () => {
    assert.deepEqual(registrationLabels(["self-hosted", "diffci-job-33953059449"]), ["diffci-job-33953059449"]);
    assert.deepEqual(registrationLabels(["self-hosted", "cloudflare", "diffci-job-33951761194"]), ["diffci-job-33951761194"], "even a pinned job that also asked for cloudflare gets a pin-only runner");
    assert.deepEqual(registrationLabels(["self-hosted", "cloudflare"]), ["cloudflare"], "a legacy plain-label job registers a plain runner - GitHub's oldest-first choice, as before");
    assert.deepEqual(registrationLabels([]), ["cloudflare"]);
  });
});

describe("parseDispatchMessage", () => {
  it("accepts a well-formed message and rejects malformed ones", () => {
    const m = parseDispatchMessage({ jobId: 1, owner: "acme", repo: "web", installationId: 7, labels: ["self-hosted", "diffci-job-9", "bad label!"], workflowRunId: 9, source: "reconcile" });
    assert.deepEqual(m, { jobId: 1, owner: "acme", repo: "web", installationId: 7, labels: ["self-hosted", "diffci-job-9"], workflowRunId: 9, source: "reconcile" });
    assert.equal(parseDispatchMessage({ jobId: "1", owner: "acme", repo: "web", installationId: 7 }), undefined);
    assert.equal(parseDispatchMessage({ jobId: 1, owner: "../x", repo: "web", installationId: 7 }), undefined);
    assert.equal(parseDispatchMessage(null), undefined);
    assert.equal(parseDispatchMessage({ jobId: 1, owner: "acme", repo: "web", installationId: 7 })?.source, "webhook");
  });
});

describe("decideReconcileDispatches", () => {
  const queued = (jobId: number, ageMs: number, labels = ["self-hosted", "cloudflare"]): QueuedJobView => ({ jobId, workflowRunId: jobId * 10, labels, queuedAt: iso(nowMs - ageMs) });
  const view = (jobId: number, o: Partial<LifecycleView> = {}): [number, LifecycleView] => [jobId, { jobId, dispatchAttempts: 0, ...o }];

  it("a queued job that never got a dispatch is re-dispatched once it is older than the webhook grace period", () => {
    const d = decideReconcileDispatches([queued(1, MIN_QUEUED_AGE_MS + 1), queued(2, MIN_QUEUED_AGE_MS - 1)], new Map(), NOW, 5);
    assert.deepEqual(d, [{ jobId: 1, reason: "never_dispatched" }]);
  });

  it("a failed dispatch is retried, a stale one is retried, an in-flight one is left alone, an assigned one is never touched", () => {
    const rows = new Map([
      view(1, { dispatchRequestedAt: iso(nowMs - 60_000), containerStartedAt: iso(nowMs - 60_000), disposition: "capacity", dispatchAttempts: 1 }),
      view(2, { dispatchRequestedAt: iso(nowMs - STALE_DISPATCH_MS - 1), containerStartedAt: iso(nowMs - STALE_DISPATCH_MS - 1), dispatchAttempts: 1 }),
      view(3, { dispatchRequestedAt: iso(nowMs - 60_000), containerStartedAt: iso(nowMs - 60_000), dispatchAttempts: 1 }),
      view(4, { dispatchRequestedAt: iso(nowMs - 60_000), assignedAt: iso(nowMs - 30_000), dispatchAttempts: 1 }),
      // The live 07:27Z shape: the pinned runner exited (exec-succeeded) after GitHub gave it a legacy job;
      // this job was never assigned and certainly has no runner now.
      view(5, { dispatchRequestedAt: iso(nowMs - 60_000), containerStartedAt: iso(nowMs - 60_000), disposition: "exec-succeeded", dispatchAttempts: 1 }),
    ]);
    const d = decideReconcileDispatches([1, 2, 3, 4, 5].map((id) => queued(id, 10 * 60_000)), rows, NOW, 5);
    assert.deepEqual(d, [{ jobId: 1, reason: "dispatch_failed" }, { jobId: 2, reason: "dispatch_stale" }, { jobId: 5, reason: "runner_gone" }]);
  });

  it("stops retrying after the attempt cap, ignores jobs not addressed to the fleet, and respects the capacity cap oldest-first", () => {
    const rows = new Map([view(1, { dispatchRequestedAt: iso(nowMs - 60_000), disposition: "start-failed", dispatchAttempts: MAX_DISPATCH_ATTEMPTS })]);
    const jobs = [queued(1, 10 * 60_000), queued(2, 9 * 60_000, ["ubuntu-latest"]), queued(3, 8 * 60_000), queued(4, 7 * 60_000), queued(5, 6 * 60_000)];
    assert.deepEqual(decideReconcileDispatches(jobs, rows, NOW, 2), [{ jobId: 3, reason: "never_dispatched" }, { jobId: 4, reason: "never_dispatched" }]);
    assert.deepEqual(decideReconcileDispatches(jobs, rows, NOW, 0), []);
  });
});

describe("classifyStartError", () => {
  it("separates capacity from timeouts from everything else", () => {
    assert.equal(classifyStartError("Container application has reached max_instances"), "capacity");
    assert.equal(classifyStartError("exec timed out after 600000ms"), "exec-timeout");
    assert.equal(classifyStartError("ECONNRESET"), "start-failed");
  });
});
