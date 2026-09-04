import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_SHADOW_CRON_CONFIG,
  runShadowCronOnce,
  selectRepositoriesToPoll,
  type PollableRepository,
  type ShadowCronDeps,
  type ShadowCronRunRecord,
  type VerifiedSourceArchive,
} from "../../../src/research/cloudflare/shadow-cron.js";

function repo(overrides: Partial<PollableRepository> & { repository: string }): PollableRepository {
  return { state: "SHADOW_ACTIVE", language: "typescript", ...overrides };
}

const CURRENT_SOURCE: VerifiedSourceArchive = {
  status: "CURRENT",
  file: new File(["fake-tarball"], "s.tgz"),
  archiveSha: "aaaa111111111111111111111111111111111111",
  expectedSha: "aaaa111111111111111111111111111111111111",
  detail: "source archive matches the deployed Worker's expected SHA",
};

interface FakeCalls {
  polled: string[];
  polledWithSha: string[];
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
  /** Defaults to a CURRENT archive - override to exercise the STALE/MISSING/UNKNOWN refusal paths. */
  sourceArchive?: VerifiedSourceArchive;
  pollResult?: (repository: string) => Promise<{ predictionsRecorded: number; errors: string[] }>;
  reconcileResult?: (repository: string) => Promise<{ reconciled: number; stillPending: number; errors: string[] }>;
  recordThrows?: boolean;
  pollsAlreadyToday?: number;
  priorPollErrors?: Record<string, number>;
}): { deps: ShadowCronDeps; calls: FakeCalls & { transitions: { repository: string; toSha: string; analysed: boolean }[]; slots: { repository: string; slotNo: number; outcome?: string }[]; paused: { repository: string; reason: string }[] } } {
  const calls = { polled: [], polledWithSha: [], reconciled: [], headChecked: [], recorded: [], logs: [], transitions: [], slots: [], paused: [] } as FakeCalls & {
    paused: { repository: string; reason: string }[];
    transitions: { repository: string; toSha: string; analysed: boolean }[];
    slots: { repository: string; slotNo: number; outcome?: string }[];
  };
  const deps: ShadowCronDeps = {
    listPollableRepositories: async () => options.repos,
    listReconcilableRepositories: async () => options.reconcilable ?? options.repos,
    fetchRemoteHead: async (repository) => {
      calls.headChecked.push(repository);
      return options.heads?.[repository];
    },
    getVerifiedSourceArchive: async () => options.sourceArchive ?? CURRENT_SOURCE,
    pollRepository: async (r, _source, engineSourceSha) => {
      calls.polled.push(r.repository);
      calls.polledWithSha.push(engineSourceSha);
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
    pauseRepository: async (repository, reason) => {
      calls.paused.push({ repository, reason });
    },
    consecutivePollErrors: async (repository) => options.priorPollErrors?.[repository] ?? 0,
    reserveLaunchSlot: async (repository, maxPerDay) => {
      // Mirrors the D1 PRIMARY KEY (day, slot_no) arbiter: a slot number can only be taken once.
      const next = (options.pollsAlreadyToday ?? 0) + calls.slots.length + 1;
      if (next > maxPerDay) return { granted: false };
      calls.slots.push({ repository, slotNo: next, outcome: undefined });
      return { granted: true, slotNo: next };
    },
    recordLaunchOutcome: async (slotNo, outcome) => {
      const slot = calls.slots.find((s) => s.slotNo === slotNo);
      if (slot) slot.outcome = outcome;
    },
    recordHeadTransition: async (t) => {
      calls.transitions.push({ repository: t.repository, toSha: t.toSha, analysed: t.analysed });
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
    const record = await runShadowCronOnce(deps, { maxPollsPerRun: 2, maxReconcilesPerRun: 10, maxPollsPerDay: 1000, maxHeadChecksPerRun: 25, maxConsecutivePollErrors: 5, reconcileLimitPerRepo: 10 });

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
    const record = await runShadowCronOnce(deps, { maxPollsPerRun: 2, maxReconcilesPerRun: 10, maxPollsPerDay: 1000, maxHeadChecksPerRun: 25, maxConsecutivePollErrors: 5, reconcileLimitPerRepo: 10 });

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

  it("records a loud error and still reconciles when no source archive is uploaded (MISSING)", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/one" })],
      sourceArchive: { status: "MISSING", detail: "no source archive has ever been uploaded - run npm run shadow:deploy" },
    });
    const record = await runShadowCronOnce(deps);

    assert.deepEqual(calls.polled, []);
    assert.deepEqual(calls.reconciled, ["a/one"]);
    assert.equal(record.errors.length, 1);
    assert.match(record.errors[0]!, /source-integrity-MISSING/);
    assert.equal(record.sourceIntegrityStatus, "MISSING");
    assert.equal(calls.recorded.length, 1, "the failed run must still be recorded for the audit trail");
  });

  describe("source-version integrity gate (2026-08-21 fix)", () => {
    it("polls normally when the source archive is CURRENT, passing the verified SHA through to pollRepository", async () => {
      const { deps, calls } = makeDeps({ repos: [repo({ repository: "a/one" })] });
      const record = await runShadowCronOnce(deps);

      assert.deepEqual(calls.polled, ["a/one"]);
      assert.deepEqual(calls.polledWithSha, ["aaaa111111111111111111111111111111111111"]);
      assert.equal(record.predictionsRecorded, 1);
      assert.equal(record.sourceIntegrityStatus, "CURRENT");
      assert.deepEqual(record.errors, []);
    });

    it("refuses to poll ANY due repository when the archive is STALE - never falls back to the old archive", async () => {
      const repos = [repo({ repository: "a/one" }), repo({ repository: "b/two" })];
      const { deps, calls } = makeDeps({
        repos,
        sourceArchive: {
          status: "STALE",
          expectedSha: "bbbb222222222222222222222222222222222222",
          archiveSha: "aaaa111111111111111111111111111111111111",
          detail: "deployed Worker expects source bbbb222222222222222222222222222222222222 but the uploaded archive is aaaa111111111111111111111111111111111111",
        },
      });
      const record = await runShadowCronOnce(deps);

      assert.deepEqual(calls.polled, [], "a stale archive must never silently produce a prediction");
      assert.equal(record.predictionsRecorded, 0);
      assert.equal(record.sourceIntegrityStatus, "STALE");
      assert.equal(record.errors.length, 1);
      assert.match(record.errors[0]!, /source-integrity-STALE/);
      // The refusal must read as an infrastructure/version-integrity failure, never get folded into an
      // opportunity-classifier outcome like MANDATORY_FALLBACK - assert the literal string never appears.
      assert.ok(!record.errors[0]!.includes("MANDATORY_FALLBACK"));
      // Still reconciles - ground truth for earlier, already-recorded predictions doesn't depend on the
      // source archive at all.
      assert.deepEqual(calls.reconciled, ["a/one", "b/two"]);
    });

    it("refuses to poll when the archive is UNKNOWN (Worker deployed without EXPECTED_SOURCE_SHA)", async () => {
      const { deps, calls } = makeDeps({
        repos: [repo({ repository: "a/one" })],
        sourceArchive: { status: "UNKNOWN", detail: "deployed Worker has no EXPECTED_SOURCE_SHA configured" },
      });
      const record = await runShadowCronOnce(deps);

      assert.deepEqual(calls.polled, []);
      assert.equal(record.sourceIntegrityStatus, "UNKNOWN");
      assert.match(record.errors[0]!, /source-integrity-UNKNOWN/);
    });

    it("never even checks source integrity when nothing needs polling this run", async () => {
      const repos = [repo({ repository: "a/unchanged", lastPolledSha: "same", lastPolledAt: "2026-08-21T09:00:00Z" })];
      let integrityChecked = false;
      const { deps, calls } = makeDeps({ repos, heads: { "a/unchanged": { sha: "same" } } });
      deps.getVerifiedSourceArchive = async () => {
        integrityChecked = true;
        return CURRENT_SOURCE;
      };
      const record = await runShadowCronOnce(deps);

      assert.equal(integrityChecked, false, "a repository with an unchanged head must never trigger a source fetch");
      assert.deepEqual(calls.polled, []);
      assert.equal(record.sourceIntegrityStatus, undefined);
    });

    it("a get-source-archive failure also refuses to poll, distinctly from a clean STALE/MISSING result", async () => {
      const { deps, calls } = makeDeps({ repos: [repo({ repository: "a/one" })] });
      deps.getVerifiedSourceArchive = async () => {
        throw new Error("R2 read timed out");
      };
      const record = await runShadowCronOnce(deps);

      assert.deepEqual(calls.polled, []);
      assert.match(record.errors.join(" "), /get-source-archive: R2 read timed out/);
      assert.match(record.errors.join(" "), /get-source-archive-failed/);
    });
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

describe("daily launch ceiling", () => {
  const CFG = { maxPollsPerRun: 3, maxReconcilesPerRun: 10, maxPollsPerDay: 60, maxHeadChecksPerRun: 25, maxConsecutivePollErrors: 5, reconcileLimitPerRepo: 10 };

  it("NEVER suppresses head checks when the ceiling is spent - observation must continue", async () => {
    // The bug this pins: gating the ceiling before the head check made a repository whose head HAD moved
    // look idle, destroying both the liveness signal and the missed-commit measurement.
    const repos = [
      repo({ repository: "a/one", lastPolledSha: "old1", lastPolledAt: "2026-08-21T09:00:00Z" }),
      repo({ repository: "b/two", lastPolledSha: "old2", lastPolledAt: "2026-08-21T10:00:00Z" }),
    ];
    const { deps, calls } = makeDeps({
      repos,
      heads: { "a/one": { sha: "new1" }, "b/two": { sha: "new2" } },
      pollsAlreadyToday: 60, // ceiling fully spent
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");

    assert.deepEqual(calls.headChecked.sort(), ["a/one", "b/two"], "every repository must still be head-checked");
    assert.deepEqual(calls.polled, [], "but no container may launch");
    assert.equal(run.dailyCeilingRefusals, 2, "both real changes deferred, and counted as deferrals");
    assert.equal(run.headTransitionsDetected, 2, "the changes were genuinely observed");
    assert.equal(run.headChecksSkipped, 0, "deferred is NOT the same as skipped-unchanged");
  });

  it("records every observed transition, including deferred ones, so the sequence survives", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/one", lastPolledSha: "old1", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/one": { sha: "new1" } },
      pollsAlreadyToday: 60,
    });
    await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.transitions.length, 1);
    assert.equal(calls.transitions[0]!.toSha, "new1");
    assert.equal(calls.transitions[0]!.analysed, false, "deferred transitions must be retained and marked unanalysed");
  });

  it("caps launches at the remaining daily budget rather than refusing the whole sweep", async () => {
    const repos = [
      repo({ repository: "a/one", lastPolledSha: "o1", lastPolledAt: "2026-08-21T09:00:00Z" }),
      repo({ repository: "b/two", lastPolledSha: "o2", lastPolledAt: "2026-08-21T10:00:00Z" }),
      repo({ repository: "c/three", lastPolledSha: "o3", lastPolledAt: "2026-08-21T11:00:00Z" }),
    ];
    const { deps, calls } = makeDeps({
      repos,
      heads: { "a/one": { sha: "n1" }, "b/two": { sha: "n2" }, "c/three": { sha: "n3" } },
      pollsAlreadyToday: 59, // exactly one launch left
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.polled.length, 1, "exactly the remaining budget is spent");
    assert.equal(run.dailyCeilingRefusals, 2);
    assert.equal(calls.headChecked.length, 3, "all three still observed");
  });

  it("an unchanged head is skipped, not counted as a ceiling deferral", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/one", lastPolledSha: "same", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/one": { sha: "same" } },
      pollsAlreadyToday: 60,
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(run.headChecksSkipped, 1);
    assert.equal(run.dailyCeilingRefusals, 0, "nothing changed, so nothing was deferred");
    assert.equal(calls.transitions.length, 0, "no transition to record");
  });
});

describe("atomic launch-slot accounting", () => {
  const CFG = { maxPollsPerRun: 3, maxReconcilesPerRun: 10, maxPollsPerDay: 60, maxHeadChecksPerRun: 25, maxConsecutivePollErrors: 5, reconcileLimitPerRepo: 10 };

  // (1) The defect vitest-dev/vitest exposed live: a clone-excluded poll still burned a real container,
  // yet the old success-counting ceiling read 1/60 while it happened every ten minutes.
  it("a clone-excluded launch consumes a slot - failure never refunds budget", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/one", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/one": { sha: "new" } },
      pollResult: async () => {
        throw new Error("clone-excluded: no tsconfig.json found at the repository root");
      },
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.slots.length, 1, "the container ran, so the slot is spent");
    assert.equal(calls.slots[0]?.outcome, "failed");
    assert.equal(run.launchesAllowed, 1);
    assert.equal(run.launchesFailed, 1);
    assert.equal(run.launchesSucceeded, 0);
    assert.deepEqual(run.reposPolled, [], "reposPolled stays a SUCCESS count and is not redefined as attempts");
  });

  // (2)
  it("a successful launch consumes exactly one slot", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/one", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/one": { sha: "new" } },
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.slots.length, 1);
    assert.equal(calls.slots[0]?.outcome, "succeeded");
    assert.equal(run.launchesSucceeded, 1);
    assert.equal(run.launchesFailed, 0);
  });

  // (3)
  it("work refused BEFORE a launch consumes no slot", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/one", lastPolledSha: "same", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/one": { sha: "same" } },
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.slots.length, 0, "an unchanged head never reaches a container");
    assert.equal(run.launchesAttempted, 0);
    assert.equal(run.headChecksSkipped, 1);
  });

  // (4)
  it("slot 60 is allowed and slot 61 is refused", async () => {
    const mk = (already: number) =>
      makeDeps({
        repos: [repo({ repository: "a/one", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
        heads: { "a/one": { sha: "new" } },
        pollsAlreadyToday: already,
      });
    const at59 = mk(59);
    const run59 = await runShadowCronOnce(at59.deps, CFG, "cron");
    assert.equal(run59.launchesAllowed, 1, "slot 60 must be granted");
    assert.equal(at59.calls.slots[0]?.slotNo, 60);

    const at60 = mk(60);
    const run60 = await runShadowCronOnce(at60.deps, CFG, "cron");
    assert.equal(run60.launchesAllowed, 0, "slot 61 must be refused");
    assert.equal(run60.dailyCeilingRefusals, 1);
    assert.equal(at60.calls.slots.length, 0);
  });

  // (5)
  it("concurrent reservations cannot together exceed the ceiling", async () => {
    const shared = { taken: 59 };
    const mkDeps = () =>
      makeDeps({
        repos: [repo({ repository: "a/one", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
        heads: { "a/one": { sha: "new" } },
      }).deps;
    const withSharedLedger = (deps: ShadowCronDeps): ShadowCronDeps => ({
      ...deps,
      reserveLaunchSlot: async (_repository, maxPerDay) => {
        const next = shared.taken + 1;
        if (next > maxPerDay) return { granted: false };
        shared.taken = next; // stands in for the PRIMARY KEY (day, slot_no) arbiter
        return { granted: true, slotNo: next };
      },
    });
    const [a, b] = await Promise.all([runShadowCronOnce(withSharedLedger(mkDeps()), CFG, "cron"), runShadowCronOnce(withSharedLedger(mkDeps()), CFG, "cron")]);
    const totalAllowed = (a.launchesAllowed ?? 0) + (b.launchesAllowed ?? 0);
    assert.equal(totalAllowed, 1, "exactly one of the two racing sweeps may take the final slot");
    assert.equal(shared.taken, 60, "the ceiling is never exceeded");
  });

  // (6)
  it("a ceiling refusal never suppresses head checks on later repositories", async () => {
    const repos = [
      repo({ repository: "a/one", lastPolledSha: "o1", lastPolledAt: "2026-08-21T09:00:00Z" }),
      repo({ repository: "b/two", lastPolledSha: "o2", lastPolledAt: "2026-08-21T10:00:00Z" }),
      repo({ repository: "c/three", lastPolledSha: "o3", lastPolledAt: "2026-08-21T11:00:00Z" }),
    ];
    const { deps, calls } = makeDeps({
      repos,
      heads: { "a/one": { sha: "n1" }, "b/two": { sha: "n2" }, "c/three": { sha: "n3" } },
      pollsAlreadyToday: 60,
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.deepEqual(calls.headChecked.sort(), ["a/one", "b/two", "c/three"]);
    assert.equal(run.headTransitionsDetected, 3, "all three changes observed despite zero budget");
    assert.equal(calls.slots.length, 0);
  });

  // (7)
  it("a failing repository does not prevent later repositories being scanned or launched", async () => {
    const repos = [
      repo({ repository: "a/broken", lastPolledSha: "o1", lastPolledAt: "2026-08-21T09:00:00Z" }),
      repo({ repository: "b/fine", lastPolledSha: "o2", lastPolledAt: "2026-08-21T10:00:00Z" }),
    ];
    const { deps, calls } = makeDeps({
      repos,
      heads: { "a/broken": { sha: "n1" }, "b/fine": { sha: "n2" } },
      pollResult: async (repository) => {
        if (repository === "a/broken") throw new Error("clone-excluded: no tsconfig.json found at the repository root");
        return { predictionsRecorded: 2, errors: [] };
      },
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.deepEqual(calls.headChecked.sort(), ["a/broken", "b/fine"]);
    assert.deepEqual(run.reposPolled, ["b/fine"], "the healthy repository still succeeds");
    assert.equal(run.launchesAttempted, 2);
    assert.equal(run.launchesAllowed, 2);
    assert.equal(run.launchesSucceeded, 1);
    assert.equal(run.launchesFailed, 1);
    assert.equal(calls.slots.length, 2, "both containers ran, so both slots are spent");
  });

  it("attempted always reconciles against allowed + refusedByCeiling", async () => {
    const { deps } = makeDeps({
      repos: [
        repo({ repository: "a/one", lastPolledSha: "o1", lastPolledAt: "2026-08-21T09:00:00Z" }),
        repo({ repository: "b/two", lastPolledSha: "o2", lastPolledAt: "2026-08-21T10:00:00Z" }),
      ],
      heads: { "a/one": { sha: "n1" }, "b/two": { sha: "n2" } },
      pollsAlreadyToday: 59,
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(run.launchesAttempted, (run.launchesAllowed ?? 0) + (run.dailyCeilingRefusals ?? 0));
    assert.equal(run.launchesAllowed, (run.launchesSucceeded ?? 0) + (run.launchesFailed ?? 0));
  });
});

describe("explicit refusal for persistently failing repositories", () => {
  const CFG = { maxPollsPerRun: 3, maxReconcilesPerRun: 10, maxPollsPerDay: 60, maxHeadChecksPerRun: 25, maxConsecutivePollErrors: 5, reconcileLimitPerRepo: 10 };

  it("auto-pauses a repository that reaches the consecutive-failure threshold", async () => {
    // The vitest-dev/vitest shape: deterministically ineligible, so it re-fails every sweep at real
    // container cost until something stops it.
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/ineligible", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/ineligible": { sha: "new" } },
      priorPollErrors: { "a/ineligible": 4 }, // this failure is the 5th
      pollResult: async () => {
        throw new Error("clone-excluded: no tsconfig.json found at the repository root");
      },
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.paused.length, 1);
    assert.equal(calls.paused[0]?.repository, "a/ineligible");
    assert.match(calls.paused[0]?.reason ?? "", /AUTO_PAUSED after 5 consecutive failed polls/);
    assert.deepEqual(run.autoPaused, ["a/ineligible"], "the pause is recorded loudly, never silent");
  });

  it("does NOT pause a repository below the threshold - transient failures are tolerated", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/flaky", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/flaky": { sha: "new" } },
      priorPollErrors: { "a/flaky": 1 },
      pollResult: async () => {
        throw new Error("transient: GitHub API 502");
      },
    });
    const run = await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.paused.length, 0);
    assert.equal(run.autoPaused?.length ?? 0, 0);
    assert.equal(run.launchesFailed, 1, "the failure is still counted and still spends its slot");
  });

  it("a failing repository still spends its slot before being paused - the container ran", async () => {
    const { deps, calls } = makeDeps({
      repos: [repo({ repository: "a/ineligible", lastPolledSha: "old", lastPolledAt: "2026-08-21T09:00:00Z" })],
      heads: { "a/ineligible": { sha: "new" } },
      priorPollErrors: { "a/ineligible": 4 },
      pollResult: async () => {
        throw new Error("clone-excluded");
      },
    });
    await runShadowCronOnce(deps, CFG, "cron");
    assert.equal(calls.slots.length, 1);
    assert.equal(calls.slots[0]?.outcome, "failed");
  });
});

describe("runShadowCronOnce: push-triggered polls in flight (2026-09-04)", () => {
  const CFG = { maxPollsPerRun: 2, maxReconcilesPerRun: 10, maxPollsPerDay: 1000, maxHeadChecksPerRun: 25, maxConsecutivePollErrors: 5, reconcileLimitPerRepo: 10 };

  it("head-checks and records the transition for a repository whose push poll is running, but never launches a second container", async () => {
    const repos = [
      repo({ repository: "a/in-flight", lastPolledSha: "old", lastPolledAt: "2026-08-27T01:58:57Z" }),
      repo({ repository: "b/idle-moved", lastPolledSha: "old", lastPolledAt: "2026-09-03T13:21:27Z" }),
    ];
    const { deps, calls } = makeDeps({ repos, heads: { "a/in-flight": { sha: "new-a" }, "b/idle-moved": { sha: "new-b" } } });
    deps.pollInFlight = async (repository) => repository === "a/in-flight";
    const record = await runShadowCronOnce(deps, CFG, "cron");

    assert.deepEqual(calls.headChecked, ["a/in-flight", "b/idle-moved"], "observation is never suppressed");
    assert.deepEqual(calls.polled, ["b/idle-moved"]);
    assert.equal(record.inFlightSkipped, 1);
    assert.equal(record.headTransitionsDetected, 2);
    assert.deepEqual(
      calls.transitions.map((t) => [t.repository, t.analysed]),
      [["a/in-flight", false], ["b/idle-moved", true]],
      "the deferred change is still a real observation",
    );
    assert.equal(calls.slots.length, 1, "no slot spent on the deferred repository");
    assert.ok(calls.logs.some((l) => l.includes("a/in-flight head moved but a push-triggered poll is in flight")));
  });

  it("an in-flight check that throws does not suppress the launch", async () => {
    const repos = [repo({ repository: "a/moved", lastPolledSha: "old", lastPolledAt: "2026-09-03T13:21:27Z" })];
    const { deps, calls } = makeDeps({ repos, heads: { "a/moved": { sha: "new" } } });
    deps.pollInFlight = async () => { throw new Error("d1 unavailable"); };
    const record = await runShadowCronOnce(deps, CFG, "cron");
    assert.deepEqual(calls.polled, ["a/moved"]);
    assert.equal(record.inFlightSkipped, 0);
  });

  it("without a pollInFlight dependency (older wiring) behaviour is unchanged", async () => {
    const repos = [repo({ repository: "a/moved", lastPolledSha: "old", lastPolledAt: "2026-09-03T13:21:27Z" })];
    const { deps, calls } = makeDeps({ repos, heads: { "a/moved": { sha: "new" } } });
    const record = await runShadowCronOnce(deps, CFG, "cron");
    assert.deepEqual(calls.polled, ["a/moved"]);
    assert.equal(record.inFlightSkipped, 0);
  });
});
