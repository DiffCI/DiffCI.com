import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SHADOW_CRON_CONFIG,
  runShadowCronOnce,
  selectRepositoriesToPoll,
  type PollableRepository,
  type ShadowCronDeps,
  type ShadowCronRunRecord,
} from "../../../src/research/cloudflare/shadow-cron.js";

function repo(overrides: Partial<PollableRepository> & { repository: string }): PollableRepository {
  return { state: "SHADOW_ACTIVE", language: "typescript", ...overrides };
}

interface FakeCalls {
  polled: string[];
  reconciled: string[];
  headChecked: string[];
  recorded: ShadowCronRunRecord[];
  logs: string[];
}

function makeDeps(options: {
  repos: PollableRepository[];
  /** Defaults to `repos` - the common case where every pollable repository is also reconcilable. */
  reconcilable?: PollableRepository[];
  heads?: Record<string, { sha: string } | { gone: string } | undefined>;
  source?: File | undefined;
  pollResult?: (repository: string) => Promise<{ predictionsRecorded: number; errors: string[] }>;
  reconcileResult?: (repository: string) => Promise<{ reconciled: number; stillPending: number; errors: string[] }>;
  recordThrows?: boolean;
}): { deps: ShadowCronDeps; calls: FakeCalls } {
  const calls: FakeCalls = { polled: [], reconciled: [], headChecked: [], recorded: [], logs: [] };
  const deps: ShadowCronDeps = {
    listPollableRepositories: async () => options.repos,
    listReconcilableRepositories: async () => options.reconcilable ?? options.repos,
    fetchRemoteHead: async (repository) => {
      calls.headChecked.push(repository);
      return options.heads?.[repository];
    },
    getSourceArchive: async () => ("source" in options ? options.source : new File(["fake-tarball"], "s.tgz")),
    pollRepository: async (r) => {
      calls.polled.push(r.repository);
      return options.pollResult ? options.pollResult(r.repository) : { predictionsRecorded: 1, errors: [] };
    },
    reconcileRepository: async (repository) => {
      calls.reconciled.push(repository);
      return options.reconcileResult ? options.reconcileResult(repository) : { reconciled: 0, stillPending: 0, errors: [] };
    },
    recordCronRun: async (run) => {
      if (options.recordThrows) throw new Error("d1 write failed");
      calls.recorded.push(run);
    },
    now: () => new Date("2026-08-21T12:00:00.000Z"),
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

describe("selectRepositoriesToPoll", () => {
  it("orders never-polled repositories first, then oldest-polled first", () => {
    const selected = selectRepositoriesToPoll([
      repo({ repository: "a/newest", lastPolledAt: "2026-08-21T11:00:00Z", lastPolledSha: "x" }),
      repo({ repository: "b/never" }),
      repo({ repository: "c/oldest", lastPolledAt: "2026-08-21T09:00:00Z", lastPolledSha: "y" }),
    ]);
    assert.deepEqual(selected.map((r) => r.repository), ["b/never", "c/oldest", "a/newest"]);
  });

  it("filters non-pollable states even if the store query regresses", () => {
    const selected = selectRepositoriesToPoll([
      repo({ repository: "a/paused", state: "PAUSED" }),
      repo({ repository: "b/removed", state: "REMOVED" }),
      repo({ repository: "c/unsupported", state: "UNSUPPORTED" }),
      repo({ repository: "d/active", state: "SHADOW_ACTIVE" }),
      repo({ repository: "e/validating", state: "VALIDATING" }),
      repo({ repository: "f/limited", state: "SHADOW_LIMITED" }),
    ]);
    assert.deepEqual(selected.map((r) => r.repository), ["d/active", "e/validating", "f/limited"]);
  });
});

describe("runShadowCronOnce", () => {
  it("polls up to maxPollsPerRun and reconciles every pollable repository", async () => {
    const repos = [repo({ repository: "a/one" }), repo({ repository: "b/two" }), repo({ repository: "c/three" }), repo({ repository: "d/four" })];
    const { deps, calls } = makeDeps({ repos });
    const record = await runShadowCronOnce(deps, { maxPollsPerRun: 2, maxReconcilesPerRun: 10, reconcileLimitPerRepo: 10 });

    assert.deepEqual(calls.polled, ["a/one", "b/two"]);
    assert.deepEqual(calls.reconciled, ["a/one", "b/two", "c/three", "d/four"]);
    assert.equal(record.predictionsRecorded, 2);
    assert.equal(record.reposConsidered, 4);
    assert.deepEqual(record.errors, []);
    assert.equal(calls.recorded.length, 1);
  });

  it("skips a repository whose remote head equals last_polled_sha without consuming a poll slot", async () => {
    const repos = [
      repo({ repository: "a/unchanged", lastPolledSha: "same-sha", lastPolledAt: "2026-08-21T09:00:00Z" }),
      repo({ repository: "b/moved", lastPolledSha: "old-sha", lastPolledAt: "2026-08-21T10:00:00Z" }),
      repo({ repository: "c/also-moved", lastPolledSha: "old-sha", lastPolledAt: "2026-08-21T11:00:00Z" }),
    ];
    const { deps, calls } = makeDeps({
      repos,
      heads: { "a/unchanged": { sha: "same-sha" }, "b/moved": { sha: "new-sha" }, "c/also-moved": { sha: "new-sha" } },
    });
    const record = await runShadowCronOnce(deps, { maxPollsPerRun: 2, maxReconcilesPerRun: 10, reconcileLimitPerRepo: 10 });

    // a/unchanged was skipped, so BOTH moved repositories fit within maxPollsPerRun=2.
    assert.deepEqual(calls.polled, ["b/moved", "c/also-moved"]);
    assert.equal(record.headChecksSkipped, 1);
  });

  it("always polls a never-polled repository without a head pre-check (no baseline to compare)", async () => {
    const { deps, calls } = makeDeps({ repos: [repo({ repository: "a/first-poll" })], heads: {} });
    await runShadowCronOnce(deps);
    assert.deepEqual(calls.headChecked, []);
    assert.deepEqual(calls.polled, ["a/first-poll"]);
  });

  it("polls anyway when the head pre-check cannot determine the remote head", async () => {
    const repos = [repo({ repository: "a/api-down", lastPolledSha: "sha", lastPolledAt: "2026-08-21T09:00:00Z" })];
    const { deps, calls } = makeDeps({ repos, heads: { "a/api-down": undefined } });
    await runShadowCronOnce(deps);
    assert.deepEqual(calls.polled, ["a/api-down"]);
  });

  it("never spends a container on a repository the head check reports gone", async () => {
    const repos = [repo({ repository: "a/deleted", lastPolledSha: "sha", lastPolledAt: "2026-08-21T09:00:00Z" })];
    const { deps, calls } = makeDeps({ repos, heads: { "a/deleted": { gone: "HTTP 404" } } });
    const record = await runShadowCronOnce(deps);
    assert.deepEqual(calls.polled, []);
    assert.equal(record.errors.length, 1);
    assert.match(record.errors[0]!, /gone/);
  });

  it("records a loud error and still reconciles when no source archive is uploaded", async () => {
    const { deps, calls } = makeDeps({ repos: [repo({ repository: "a/one" })], source: undefined });
    const record = await runShadowCronOnce(deps);

    assert.deepEqual(calls.polled, []);
    assert.deepEqual(calls.reconciled, ["a/one"]);
    assert.equal(record.errors.length, 1);
    assert.match(record.errors[0]!, /source-archive-missing/);
    assert.equal(calls.recorded.length, 1, "the failed run must still be recorded for the audit trail");
  });

  it("isolates one repository's poll failure from the others", async () => {
    const repos = [repo({ repository: "a/fails" }), repo({ repository: "b/works" })];
    const { deps, calls } = makeDeps({
      repos,
      pollResult: async (repository) => {
        if (repository === "a/fails") throw new Error("container exploded");
        return { predictionsRecorded: 3, errors: [] };
      },
    });
    const record = await runShadowCronOnce(deps);

    assert.deepEqual(record.reposPolled, ["b/works"]);
    assert.equal(record.predictionsRecorded, 3);
    assert.equal(record.errors.length, 1);
    assert.match(record.errors[0]!, /a\/fails: container exploded/);
    assert.deepEqual(calls.reconciled, ["a/fails", "b/works"], "a poll failure must not block reconciliation");
  });

  it("aggregates reconcile results and isolates reconcile failures", async () => {
    const repos = [repo({ repository: "a/one" }), repo({ repository: "b/two" })];
    const { deps } = makeDeps({
      repos,
      reconcileResult: async (repository) => {
        if (repository === "a/one") throw new Error("github 500");
        return { reconciled: 2, stillPending: 1, errors: ["one evidence blob missing"] };
      },
    });
    const record = await runShadowCronOnce(deps);

    assert.equal(record.reposReconciled, 1);
    assert.equal(record.groundTruthReconciled, 2);
    assert.equal(record.stillPending, 1);
    assert.equal(record.errors.filter((e) => e.includes("github 500")).length, 1);
    assert.equal(record.errors.filter((e) => e.includes("evidence blob missing")).length, 1);
  });

  it("survives a telemetry write failure without failing the run", async () => {
    const { deps, calls } = makeDeps({ repos: [repo({ repository: "a/one" })], recordThrows: true });
    const record = await runShadowCronOnce(deps);
    assert.equal(record.reposPolled.length, 1);
    assert.equal(calls.logs.filter((l) => l.includes("failed to record cron run telemetry")).length, 1);
  });

  it("reconciles webhook-enrolled repositories that are not in the pollable list", async () => {
    const pollable = [repo({ repository: "a/polled" })];
    const webhookEnrolled = [...pollable, repo({ repository: "b/webhook-only" })];
    const { deps, calls } = makeDeps({ repos: pollable, reconcilable: webhookEnrolled });
    await runShadowCronOnce(deps);
    assert.deepEqual(calls.polled, ["a/polled"]);
    assert.deepEqual(calls.reconciled, ["a/polled", "b/webhook-only"]);
  });

  it("labels manual triggers distinctly from scheduled ones", async () => {
    const { deps } = makeDeps({ repos: [] });
    const manual = await runShadowCronOnce(deps, DEFAULT_SHADOW_CRON_CONFIG, "manual");
    const scheduled = await runShadowCronOnce(deps);
    assert.equal(manual.trigger, "manual");
    assert.equal(scheduled.trigger, "cron");
  });
});
