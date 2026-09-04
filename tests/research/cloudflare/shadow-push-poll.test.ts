import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_SHADOW_CRON_CONFIG, type ShadowCronConfig, type VerifiedSourceArchive, type RepositoryLivenessUpdate } from "../../../src/research/cloudflare/shadow-cron.js";
import { parsePushPollMessage, runPushTriggeredPoll, type PushPollDeps, type PushPollMessage, type PushPollRecord } from "../../../src/research/cloudflare/shadow-push-poll.js";

const SHA = "a".repeat(40);
const CURRENT_SOURCE: VerifiedSourceArchive = {
  status: "CURRENT",
  file: new File(["fake-tarball"], "s.tgz"),
  archiveSha: "b".repeat(40),
  expectedSha: "b".repeat(40),
  detail: "source archive matches the deployed Worker's expected SHA",
};
const STALE_SOURCE: VerifiedSourceArchive = {
  status: "STALE",
  expectedSha: "b".repeat(40),
  archiveSha: "c".repeat(40),
  detail: "archive was built from a different commit than the deployed Worker expects",
};

const CONFIG: ShadowCronConfig = { ...DEFAULT_SHADOW_CRON_CONFIG, maxPollsPerDay: 5, maxConsecutivePollErrors: 3 };

function message(overrides: Partial<PushPollMessage> = {}): PushPollMessage {
  return { kind: "poll", repository: "acme/web", headSha: SHA, enqueuedAt: "2026-09-04T10:00:00.000Z", ...overrides };
}

interface Calls {
  polled: { repository: string; language: string; engineSourceSha: string }[];
  bridged: string[];
  slots: { repository: string; slotNo: number; outcome?: string }[];
  liveness: RepositoryLivenessUpdate[];
  paused: { repository: string; reason: string }[];
  begun: unknown[];
  finished: { id: number; record: PushPollRecord }[];
  logs: string[];
}

function makeDeps(options: {
  state?: { state: string; language: string } | undefined;
  source?: VerifiedSourceArchive;
  pollsAlreadyToday?: number;
  pollResult?: () => Promise<{ predictionsRecorded: number; errors: string[]; newHeadSha?: string }>;
  priorPollErrors?: number;
  beginThrows?: boolean;
  bridge?: boolean;
  bridgeResult?: () => Promise<{ ok: boolean; outcome?: string; error?: string }>;
} = {}): { deps: PushPollDeps; calls: Calls } {
  const calls: Calls = { polled: [], bridged: [], slots: [], liveness: [], paused: [], begun: [], finished: [], logs: [] };
  let clock = 0;
  const deps: PushPollDeps = {
    getRepositoryState: async () => ("state" in options ? options.state : { state: "SHADOW_ACTIVE", language: "typescript" }),
    getVerifiedSourceArchive: async () => options.source ?? CURRENT_SOURCE,
    reserveLaunchSlot: async (repository, maxPerDay) => {
      const next = (options.pollsAlreadyToday ?? 0) + calls.slots.length + 1;
      if (next > maxPerDay) return { granted: false };
      calls.slots.push({ repository, slotNo: next });
      return { granted: true, slotNo: next };
    },
    recordLaunchOutcome: async (slotNo, outcome) => {
      const slot = calls.slots.find((s) => s.slotNo === slotNo);
      if (slot) slot.outcome = outcome;
    },
    pollRepository: async (repository, language, _source, engineSourceSha) => {
      calls.polled.push({ repository, language, engineSourceSha });
      return options.pollResult ? options.pollResult() : { predictionsRecorded: 2, errors: [], newHeadSha: SHA };
    },
    ...(options.bridge
      ? {
          runCiReproductionBridge: async (repository: string) => {
            calls.bridged.push(repository);
            return options.bridgeResult ? options.bridgeResult() : { ok: true, outcome: "REPRODUCED" };
          },
        }
      : {}),
    recordRepositoryLiveness: async (updates) => {
      calls.liveness.push(...updates);
    },
    consecutivePollErrors: async () => options.priorPollErrors ?? 0,
    pauseRepository: async (repository, reason) => {
      calls.paused.push({ repository, reason });
    },
    beginPushPoll: async (input) => {
      if (options.beginThrows) throw new Error("d1 insert failed");
      calls.begun.push(input);
      return 77;
    },
    finishPushPoll: async (id, record) => {
      calls.finished.push({ id, record });
    },
    now: () => new Date(Date.UTC(2026, 8, 4, 10, 0, clock++)),
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

describe("parsePushPollMessage", () => {
  it("accepts a well-formed poll message and drops a malformed headSha rather than trusting it", () => {
    assert.deepEqual(parsePushPollMessage({ kind: "poll", repository: "acme/web", headSha: SHA, enqueuedAt: "t" }), { kind: "poll", repository: "acme/web", headSha: SHA, enqueuedAt: "t" });
    assert.equal(parsePushPollMessage({ kind: "poll", repository: "acme/web", headSha: "not-a-sha; rm -rf /", enqueuedAt: "t" })?.headSha, undefined);
  });

  it("rejects anything that could reach a shell command or is not a known kind", () => {
    assert.equal(parsePushPollMessage(null), undefined);
    assert.equal(parsePushPollMessage("acme/web"), undefined);
    assert.equal(parsePushPollMessage({ kind: "poll", repository: "acme/web; echo", enqueuedAt: "t" }), undefined);
    assert.equal(parsePushPollMessage({ kind: "poll", repository: "no-slash", enqueuedAt: "t" }), undefined);
    assert.equal(parsePushPollMessage({ kind: "something-else", repository: "acme/web", enqueuedAt: "t" }), undefined);
    assert.equal(parsePushPollMessage({ kind: "poll", repository: "acme/web" }), undefined);
  });
});

describe("runPushTriggeredPoll", () => {
  it("polls with the verified source, spends one launch slot, records liveness, and leaves a durable start+finish trail", async () => {
    const { deps, calls } = makeDeps();
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "succeeded");
    assert.equal(record.predictionsRecorded, 2);
    assert.equal(record.slotNo, 1);
    assert.deepEqual(calls.polled, [{ repository: "acme/web", language: "typescript", engineSourceSha: CURRENT_SOURCE.archiveSha }]);
    assert.deepEqual(calls.slots, [{ repository: "acme/web", slotNo: 1, outcome: "succeeded" }]);
    assert.equal(calls.liveness.length, 1);
    assert.equal(calls.liveness[0]!.pollAttempted, true);
    assert.equal(calls.liveness[0]!.pollSucceeded, true);
    assert.equal(calls.liveness[0]!.observedHeadSha, SHA);
    // Start is written BEFORE any container work, finish after - a consumer that dies mid-poll leaves
    // the start row behind as the in-flight marker.
    assert.equal(calls.begun.length, 1);
    assert.deepEqual(calls.finished.map((f) => f.id), [77]);
    assert.equal(calls.finished[0]!.record.outcome, "succeeded");
    assert.ok(calls.finished[0]!.record.finishedAt > calls.finished[0]!.record.startedAt);
    assert.deepEqual(calls.paused, []);
  });

  it("a failed poll still consumes its slot, increments liveness failure, and is recorded as failed - never silent", async () => {
    const { deps, calls } = makeDeps({ pollResult: async () => { throw new Error("shadow-poll failed (exit 1): npm ci timed out"); } });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "failed");
    assert.match(record.error ?? "", /npm ci timed out/);
    assert.deepEqual(calls.slots, [{ repository: "acme/web", slotNo: 1, outcome: "failed" }]);
    assert.equal(calls.liveness[0]!.pollAttempted, true);
    assert.equal(calls.liveness[0]!.pollSucceeded, false);
    assert.equal(calls.finished[0]!.record.outcome, "failed");
    assert.deepEqual(calls.paused, [], "one failure is transient - below the threshold");
    assert.equal(record.autoPaused, false);
  });

  it("auto-pauses a repository that reaches the consecutive-failure threshold, with a durable reason", async () => {
    const { deps, calls } = makeDeps({ priorPollErrors: 2, pollResult: async () => { throw new Error("clone-excluded: too large"); } });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "failed");
    assert.equal(record.autoPaused, true);
    assert.equal(calls.paused.length, 1);
    assert.match(calls.paused[0]!.reason, /AUTO_PAUSED after 3 consecutive failed polls \(push-triggered\)/);
    assert.match(calls.paused[0]!.reason, /clone-excluded/);
  });

  it("refuses a PAUSED repository without touching the source, a slot, or a container", async () => {
    const { deps, calls } = makeDeps({ state: { state: "PAUSED", language: "typescript" } });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "refused-state");
    assert.deepEqual(calls.polled, []);
    assert.deepEqual(calls.slots, []);
    assert.equal(calls.finished[0]!.record.outcome, "refused-state");
  });

  it("refuses an unknown repository explicitly rather than enrolling or polling it", async () => {
    const { deps, calls } = makeDeps({ state: undefined });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);
    assert.equal(record.outcome, "refused-unknown-repository");
    assert.deepEqual(calls.polled, []);
  });

  it("fails closed on a non-CURRENT source archive and does NOT burn a launch slot for it", async () => {
    const { deps, calls } = makeDeps({ source: STALE_SOURCE });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "refused-source");
    assert.match(record.detail ?? "", /source-integrity-STALE/);
    assert.deepEqual(calls.polled, []);
    assert.deepEqual(calls.slots, [], "no container launched, so no slot consumed");
  });

  it("refuses at the daily launch ceiling - recorded as a deliberate refusal, not a failure", async () => {
    const { deps, calls } = makeDeps({ pollsAlreadyToday: 5 });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "refused-ceiling");
    assert.deepEqual(calls.polled, []);
    assert.deepEqual(calls.liveness, [], "no poll was attempted, so the failure counter must not move");
    assert.deepEqual(calls.paused, []);
  });

  it("still runs the poll when the durable start write fails - the trail is loud, not load-bearing", async () => {
    const { deps, calls } = makeDeps({ beginThrows: true });
    const record = await runPushTriggeredPoll(message(), deps, CONFIG);

    assert.equal(record.outcome, "succeeded");
    assert.deepEqual(calls.polled.map((p) => p.repository), ["acme/web"]);
    assert.deepEqual(calls.finished, [], "no row id to finish");
    assert.ok(calls.logs.some((l) => l.includes("failed to record start")));
  });

  it("runs the ci-reproduction bridge through the same source gate, without an analysis launch slot", async () => {
    const { deps, calls } = makeDeps({ bridge: true });
    const record = await runPushTriggeredPoll(message({ kind: "ci-reproduction-bridge", headSha: undefined }), deps, CONFIG);

    assert.equal(record.outcome, "succeeded");
    assert.equal(record.detail, "REPRODUCED");
    assert.deepEqual(calls.bridged, ["acme/web"]);
    assert.deepEqual(calls.polled, []);
    assert.deepEqual(calls.slots, []);
    assert.deepEqual(calls.liveness, [], "the bridge is not the analysis poll - liveness is the poll's signal");
  });

  it("refuses the bridge (recorded) when the source is not CURRENT, and when the bridge is not wired", async () => {
    const stale = makeDeps({ bridge: true, source: STALE_SOURCE });
    assert.equal((await runPushTriggeredPoll(message({ kind: "ci-reproduction-bridge" }), stale.deps, CONFIG)).outcome, "refused-source");
    assert.deepEqual(stale.calls.bridged, []);

    const unwired = makeDeps({ bridge: false });
    const record = await runPushTriggeredPoll(message({ kind: "ci-reproduction-bridge" }), unwired.deps, CONFIG);
    assert.equal(record.outcome, "refused-state");
    assert.match(record.detail ?? "", /not wired/);
  });

  it("a bridge that reports ok=false is recorded as failed with its error, never as a poll failure", async () => {
    const { deps, calls } = makeDeps({ bridge: true, bridgeResult: async () => ({ ok: false, outcome: "REFUSED", error: "no lockfile" }) });
    const record = await runPushTriggeredPoll(message({ kind: "ci-reproduction-bridge" }), deps, CONFIG);
    assert.equal(record.outcome, "failed");
    assert.equal(record.error, "no lockfile");
    assert.deepEqual(calls.paused, []);
    assert.deepEqual(calls.liveness, []);
  });
});
