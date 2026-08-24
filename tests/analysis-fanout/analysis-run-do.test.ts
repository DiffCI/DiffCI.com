import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  countRunningShards,
  recomputeRunStatus,
  releasePendingShards,
  selectNextReleases,
} from "../../src/analysis-fanout/cloudflare/analysis-run-do.js";
import { computeNextAlarmAt, findStaleShards } from "../../src/analysis-fanout/watchdog.js";
import type {
  RunState,
  RunStatus,
  ShardRecord,
  ShardState,
  ShardStatus,
} from "../../src/analysis-fanout/fanout-types.js";

function shard(id: string, status: ShardStatus, overrides: Partial<ShardState> = {}): ShardState {
  return {
    id,
    runId: "run-1",
    repo: "x/y",
    shardIndex: 0,
    shardCount: 1,
    mergeCount: 1,
    status,
    rowsCompleted: 0,
    heartbeatAt: 0,
    timings: {},
    ...overrides,
  };
}

function runState(shards: ShardState[], status: RunStatus = "running"): RunState {
  return {
    runId: "run-1",
    createdAt: 0,
    status,
    shape: "standard-2",
    shardsPerRepository: 1,
    maxConcurrentShards: 8,
    repositories: [],
    engineChecksum: "c".repeat(64),
    tarballKey: "tarballs/x.tgz",
    tarballSha256: "a".repeat(64),
    shards,
  };
}

function seed(id: string): ShardRecord {
  return {
    id,
    runId: "run-1",
    repo: "x/y",
    manifestKey: "manifests/sel.json",
    tarballKey: "tarballs/x.tgz",
    tarballSha256: "a".repeat(64),
    frozenManifestKey: "manifests/frozen.json",
    slice: {
      repository: "x/y",
      resolvedRepository: "x/y",
      defaultBranch: "main",
      merges: [],
      mergeListSha256: "s".repeat(64),
      parentManifestSha256: "p".repeat(64),
      parentRepository: "x/y",
      shardIndex: 0,
      shardCount: 1,
    },
    shardIndex: 0,
    shardCount: 1,
    mergeCount: 0,
    step: "bootstrapping",
    sandboxId: "sandbox",
    flushedLines: 0,
    rows: [],
    timings: {},
    startedAt: 0,
    heartbeatAt: 0,
  };
}

describe("selectNextReleases", () => {
  it("never returns more than maxConcurrentShards minus currently-running shards", () => {
    const shards = [
      shard("a", "bootstrapping"),
      shard("b", "cloning"),
      shard("c", "analyzing"),
      shard("d", "finalizing"),
      shard("e", "pending"),
      shard("f", "pending"),
      shard("g", "pending"),
      shard("h", "done"),
    ];
    assert.equal(countRunningShards(shards), 4);

    const released = selectNextReleases(shards, 6);
    assert.equal(released.length, 2);
    assert.deepEqual(released.map((s) => s.id), ["e", "f"]);

    for (const max of [1, 2, 4, 8, 16]) {
      const r = selectNextReleases(shards, max);
      assert.ok(r.length <= Math.max(0, max - countRunningShards(shards)));
      assert.ok(r.every((s) => s.status === "pending"));
    }
  });

  it("returns [] when at or over the concurrency bound", () => {
    const shards = [shard("a", "analyzing"), shard("b", "cloning"), shard("c", "pending")];
    assert.deepEqual(selectNextReleases(shards, 2), []);
  });

  it("terminal shards (done/failed/cancelled) never hold a slot", () => {
    const shards = [shard("a", "done"), shard("b", "failed"), shard("c", "cancelled"), shard("d", "pending")];
    assert.equal(countRunningShards(shards), 0);
    assert.deepEqual(selectNextReleases(shards, 2).map((s) => s.id), ["d"]);
  });
});

describe("recomputeRunStatus (terminal-state accounting)", () => {
  it("completed when every shard is terminal with no failures", () => {
    assert.equal(recomputeRunStatus(runState([shard("a", "done"), shard("b", "done")])), "completed");
  });

  it("failed when any shard failed", () => {
    assert.equal(recomputeRunStatus(runState([shard("a", "done"), shard("b", "failed")])), "failed");
  });

  it("running while any shard is active or pending", () => {
    assert.equal(recomputeRunStatus(runState([shard("a", "done"), shard("b", "pending")])), "running");
    assert.equal(recomputeRunStatus(runState([shard("a", "done"), shard("b", "analyzing")])), "running");
  });

  it("cancelled stays cancelled regardless of shards", () => {
    assert.equal(recomputeRunStatus(runState([shard("a", "done")], "cancelled")), "cancelled");
  });

  it("empty shards are still running (nothing terminal yet)", () => {
    assert.equal(recomputeRunStatus(runState([])), "running");
  });
});

describe("releasePendingShards (the coordinator's /init reducer)", () => {
  it("releases pending shards up to the bound, marks them bootstrapping, and starts each once", async () => {
    const run = runState([shard("a", "pending"), shard("b", "pending"), shard("c", "pending")]);
    run.maxConcurrentShards = 2;
    const started: string[] = [];
    const seeds = new Map([["a", seed("a")], ["b", seed("b")], ["c", seed("c")]]);
    await releasePendingShards(run, seeds, async (s) => { started.push(s.id); }, 0);

    assert.deepEqual(started, ["a", "b"]);
    assert.equal(run.shards.find((s) => s.id === "a")!.status, "bootstrapping");
    assert.equal(run.shards.find((s) => s.id === "b")!.status, "bootstrapping");
    assert.equal(run.shards.find((s) => s.id === "c")!.status, "pending");
  });

  it("marks a shard with a missing seed failed", async () => {
    const run = runState([shard("a", "pending")]);
    await releasePendingShards(run, new Map(), async () => {}, 0);
    assert.equal(run.shards[0]!.status, "failed");
    assert.match(run.shards[0]!.lastError ?? "", /missing shard seed/);
  });

  it("records a start failure without aborting the remaining releases", async () => {
    const run = runState([shard("a", "pending"), shard("b", "pending")]);
    run.maxConcurrentShards = 8;
    const seeds = new Map([["a", seed("a")], ["b", seed("b")]]);
    await releasePendingShards(run, seeds, async (s) => { if (s.id === "a") throw new Error("boom"); }, 0);
    assert.equal(run.shards.find((s) => s.id === "a")!.status, "failed");
    assert.match(run.shards.find((s) => s.id === "a")!.lastError ?? "", /boom/);
    assert.equal(run.shards.find((s) => s.id === "b")!.status, "bootstrapping");
  });
});

describe("watchdog (coordinator liveness)", () => {
  const maxAge = 35 * 60 * 1000;

  it("findStaleShards flags only stale active shards", () => {
    const now = 1_000_000;
    const shards = [
      shard("a", "analyzing", { heartbeatAt: now - maxAge - 1 }),
      shard("b", "cloning", { heartbeatAt: now - 1000 }),
      shard("c", "done", { heartbeatAt: now - maxAge - 1000 }),
    ];
    assert.deepEqual(findStaleShards(shards, now).map((s) => s.id), ["a"]);
  });

  it("computeNextAlarmAt returns null when nothing is active", () => {
    assert.equal(computeNextAlarmAt([shard("a", "done"), shard("b", "failed")], 0), null);
  });

  it("computeNextAlarmAt schedules no later than the earliest stale crossing", () => {
    const now = 1_000_000;
    const at = computeNextAlarmAt([shard("a", "analyzing", { heartbeatAt: now - maxAge + 5000 })], now);
    assert.ok(at !== null);
    assert.ok(at! > now && at! <= now + maxAge);
  });
});