import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLL_MS, parseProbe, repoSlug, stepShard } from "../../src/analysis-fanout/cloudflare/analysis-shard-do.js";
import type { ShardHeartbeat, ShardStepDeps } from "../../src/analysis-fanout/cloudflare/analysis-shard-do.js";
import type { R2BucketLike, R2ObjectBodyLike, SandboxLike } from "../../src/analysis-fanout/sandbox-like.js";
import type { MergeRow, ShardRecord, ShardSlice } from "../../src/analysis-fanout/fanout-types.js";
import { hasVerdict } from "../../src/analysis-fanout/row-mapping.js";

function merge(index: number): MergeRow {
  return {
    index,
    prNumber: index,
    mergeSha: `b${index}`.padEnd(40, "0"),
    baseSha: `a${index}`.padEnd(40, "0"),
    mergeTimestamp: "2026-08-23T00:00:00Z",
    subject: `merge ${index}`,
    changedFiles: 1,
  };
}

function makeSlice(merges: MergeRow[]): ShardSlice {
  return {
    repository: "test/repo",
    resolvedRepository: "test/repo",
    defaultBranch: "main",
    merges,
    mergeListSha256: "s".repeat(64),
    parentManifestSha256: "p".repeat(64),
    parentRepository: "test/repo",
    shardIndex: 0,
    shardCount: 1,
  };
}

function makeRecord(overrides: Partial<ShardRecord> = {}): ShardRecord {
  return {
    id: "shard-0",
    runId: "run-1",
    repo: "test/repo",
    manifestKey: "manifests/sel.json",
    tarballKey: "tarballs/x.tgz",
    tarballSha256: "a".repeat(64),
    frozenManifestKey: "manifests/frozen.json",
    slice: makeSlice([merge(1), merge(2)]),
    shardIndex: 0,
    shardCount: 1,
    mergeCount: 2,
    step: "bootstrapping",
    sandboxId: "sandbox-0",
    flushedLines: 0,
    rows: [],
    timings: {},
    startedAt: 0,
    heartbeatAt: 0,
    ...overrides,
  };
}

interface ExecResultLike {
  success?: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

function makeSandbox(init: {
  exec?: (command: string) => ExecResultLike | undefined;
  readFile?: Record<string, string>;
  process?: { status: string; exitCode?: number } | null;
} = {}) {
  const execCalls: { command: string; options?: { timeout?: number; cwd?: string } }[] = [];
  const writeFileCalls: { path: string; content: unknown }[] = [];
  const startProcessCalls: { command: string }[] = [];
  let destroyCalled = false;

  const sandbox: SandboxLike = {
    async exec(command, options) {
      execCalls.push({ command, options });
      const r = init.exec?.(command) ?? {};
      return { success: r.success ?? true, exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async writeFile(path, content) {
      writeFileCalls.push({ path, content });
      return { success: true };
    },
    async readFile(path) {
      return { content: init.readFile?.[path] ?? "" };
    },
    async startProcess(command) {
      startProcessCalls.push({ command });
      return { id: "proc-1", status: "running" };
    },
    async getProcess() {
      if (init.process === null) return null;
      const p = init.process === undefined ? { status: "running" } : init.process;
      return { id: "proc-1", status: p.status, exitCode: p.exitCode };
    },
    async getProcessLogs() {
      return { stdout: "", stderr: "" };
    },
    async killProcess() {},
    async destroy() {
      destroyCalled = true;
    },
  };

  return { sandbox, execCalls, writeFileCalls, startProcessCalls, isDestroyed: () => destroyCalled };
}

function makeBucket(objects: Record<string, string> = {}) {
  const putCalls: { key: string; value: unknown }[] = [];
  const bucket: R2BucketLike = {
    async get(key) {
      if (!(key in objects)) return null;
      const text = objects[key]!;
      const bytes = new TextEncoder().encode(text);
      const obj: R2ObjectBodyLike = {
        key,
        size: bytes.length,
        body: new ReadableStream<Uint8Array>(),
        async arrayBuffer() {
          return bytes.buffer as ArrayBuffer;
        },
        async text() {
          return text;
        },
      };
      return obj;
    },
    async put(key, value) {
      putCalls.push({ key, value });
      return undefined;
    },
  };
  return { bucket, putCalls };
}

function makeDeps(sandbox: SandboxLike, bucket: R2BucketLike) {
  const heartbeats: ShardHeartbeat[] = [];
  const deps: ShardStepDeps = {
    sandbox,
    bucket,
    heartbeat: async (p) => {
      heartbeats.push(p);
    },
    now: () => 1000,
  };
  return { deps, heartbeats };
}

describe("AnalysisShard state machine (stepShard)", () => {
  it("resumes an analyzing shard from persisted state without re-cloning or duplicating rows", async () => {
    const firstRow = JSON.stringify({ ok: true, mergeSha: merge(1).mergeSha, analysisStatus: "safe" });
    const record = makeRecord({ step: "analyzing", processId: "proc-1", flushedLines: 1, rows: [firstRow] });
    const { sandbox, execCalls, writeFileCalls, startProcessCalls } = makeSandbox({
      readFile: { "/workspace/rows.jsonl": firstRow + "\n" },
      process: { status: "running" },
    });
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);

    const { record: out, nextAlarmDelayMs } = await stepShard(record, deps);

    assert.equal(out.step, "analyzing");
    assert.equal(nextAlarmDelayMs, POLL_MS);
    assert.equal(execCalls.some((c) => c.command.includes("git clone")), false);
    assert.equal(startProcessCalls.length, 0);
    assert.equal(writeFileCalls.some((c) => c.path === "/workspace/slice.json"), false);
    assert.equal(out.rows.length, 1);
    assert.equal(out.rows[0], firstRow);
  });

  it("maps exit 137 to a resource-kill row for the in-flight merge, preserving prior rows", async () => {
    const firstRow = JSON.stringify({
      ok: true,
      mergeSha: merge(1).mergeSha,
      analysisStatus: "safe",
      affectedTests: 1,
      totalTestsInGraph: 10,
    });
    const record = makeRecord({ step: "analyzing", processId: "proc-1", flushedLines: 1, rows: [firstRow] });
    const { sandbox } = makeSandbox({
      readFile: { "/workspace/rows.jsonl": firstRow + "\n" },
      process: { status: "failed", exitCode: 137 },
    });
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);

    const { record: out, nextAlarmDelayMs } = await stepShard(record, deps);

    assert.equal(out.step, "finalizing");
    assert.equal(nextAlarmDelayMs, 0);
    assert.equal(out.errorClass, "resource-kill");
    assert.equal(out.rows.length, 2);
    assert.equal(out.rows[0], firstRow);
    const kill = JSON.parse(out.rows[1]!) as Record<string, unknown>;
    assert.equal(kill.ok, false);
    assert.equal(kill.errorClass, "resource-kill");
    assert.equal(hasVerdict(kill), false);
    assert.equal(kill.mergeSha, merge(2).mergeSha);
  });

  it("aborts as tarball-corrupt on a post-transfer checksum mismatch before any clone", async () => {
    const record = makeRecord({ step: "bootstrapping", tarballSha256: "a".repeat(64) });
    const wrongHash = "b".repeat(64);
    const { sandbox, execCalls } = makeSandbox({
      exec: (command) => {
        if (command.includes("sha256sum /opt/diffci-source.tgz")) {
          return { success: true, exitCode: 0, stdout: `${wrongHash}  /opt/diffci-source.tgz` };
        }
        return { success: true, exitCode: 0, stdout: "" };
      },
    });
    const { bucket } = makeBucket({
      "tarballs/x.tgz": "tarball-bytes",
      "manifests/frozen.json": JSON.stringify({ engineChecksum: "c".repeat(64) }),
    });
    const { deps, heartbeats } = makeDeps(sandbox, bucket);

    const { record: out, nextAlarmDelayMs } = await stepShard(record, deps);

    assert.equal(out.step, "failed");
    assert.equal(out.errorClass, "tarball-corrupt");
    assert.equal(nextAlarmDelayMs, null);
    assert.equal(execCalls.some((c) => c.command.includes("git clone")), false);
    assert.equal(execCalls.some((c) => c.command.includes("npm ci")), false);
    assert.equal(heartbeats.some((h) => h.status === "failed"), true);
  });

  it("aborts as engine-drift when verify-frozen-engine fails in-container", async () => {
    const record = makeRecord({ step: "bootstrapping", tarballSha256: "a".repeat(64) });
    const { sandbox } = makeSandbox({
      exec: (command) => {
        if (command.includes("sha256sum")) return { success: true, exitCode: 0, stdout: `${"a".repeat(64)}  /opt/diffci-source.tgz` };
        if (command.includes("verify-frozen-engine.cjs")) return { success: false, exitCode: 1, stdout: "", stderr: "DRIFT" };
        return { success: true, exitCode: 0, stdout: "" };
      },
    });
    const { bucket } = makeBucket({
      "tarballs/x.tgz": "tarball-bytes",
      "manifests/frozen.json": JSON.stringify({ engineChecksum: "c".repeat(64) }),
    });
    const { deps } = makeDeps(sandbox, bucket);

    const { record: out } = await stepShard(record, deps);
    assert.equal(out.step, "failed");
    assert.equal(out.errorClass, "engine-drift");
  });
});

describe("parseProbe / repoSlug", () => {
  it("parses nproc, MemAvailable, and disk free", () => {
    const probe = parseProbe("nproc=1\nMemAvailable:   6291456 kB\n123456789 0 0 10% /workspace\n");
    assert.equal(probe.nproc, 1);
    assert.equal(probe.memAvailableMb, Math.round(6291456 / 1024));
    assert.equal(probe.diskFreeBytes, 123456789);
  });

  it("repoSlug replaces / with __", () => {
    assert.equal(repoSlug("vercel/turborepo"), "vercel__turborepo");
  });
});