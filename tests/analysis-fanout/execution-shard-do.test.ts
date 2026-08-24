import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { POLL_MS, seedExecutionRecord, stepExecution } from "../../src/analysis-fanout/cloudflare/execution-shard-do.js";
import type { ExecutionStepDeps } from "../../src/analysis-fanout/cloudflare/execution-shard-do.js";
import type { R2BucketLike, R2ObjectBodyLike, SandboxLike } from "../../src/analysis-fanout/sandbox-like.js";
import type { ExecutionRecord, ExecutionSpec, RepoExecutionProfile } from "../../src/analysis-fanout/execution-types.js";

function spec(overrides: Partial<ExecutionSpec> = {}): ExecutionSpec {
  return {
    runId: "run-1",
    repository: "calcom/cal.diy",
    mergeSha: "b".repeat(40),
    baseSha: "a".repeat(40),
    prNumber: 29940,
    subject: "test change",
    selectedTestPaths: ["apps/web/lib/foo.test.ts"],
    totalTestsInGraph: 250,
    analysisOverheadMs: 5_000,
    ...overrides,
  };
}

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return { ...seedExecutionRecord(spec(), "standard-4", 1000), ...overrides };
}

function profile(): RepoExecutionProfile {
  return {
    repository: "calcom/cal.diy",
    packageManager: "yarn",
    installArgv: ["install"],
    pretestArgv: [["prisma", "generate"]],
    testArgv: ["test", "--", "--no-isolate"],
    testEnv: { TZ: "UTC" },
    reporterArgv: ["--reporter=json"],
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
  const startProcessCalls: { command: string; options?: { cwd?: string } }[] = [];
  let destroyCalled = false;

  const sandbox: SandboxLike = {
    async exec(command, options) {
      execCalls.push({ command, options });
      const r = init.exec?.(command) ?? {};
      return { success: r.success ?? true, exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    },
    async writeFile(path, content) {
      return { success: true, path: typeof path === "string" ? path : undefined };
    },
    async readFile(path) {
      if (init.readFile && !(path in init.readFile)) throw new Error(`no such file: ${path}`);
      return { content: init.readFile?.[path] ?? "" };
    },
    async startProcess(command, options) {
      startProcessCalls.push({ command, options });
      return { id: "proc-1", status: "running" };
    },
    async getProcess() {
      if (init.process === null) return null;
      const p = init.process === undefined ? { status: "running" } : init.process;
      return { id: "proc-1", status: p.status, exitCode: p.exitCode };
    },
    async destroy() {
      destroyCalled = true;
    },
  };

  return { sandbox, execCalls, startProcessCalls, isDestroyed: () => destroyCalled };
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
        async arrayBuffer() { return bytes.buffer as ArrayBuffer; },
        async text() { return text; },
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

function makeDeps(sandbox: SandboxLike, bucket: R2BucketLike, nowValue = 2000): { deps: ExecutionStepDeps } {
  return { deps: { sandbox, bucket, profile: profile(), now: () => nowValue } };
}

describe("AnalysisExecutionShard state machine (stepExecution)", () => {
  it("bootstrap -> cloning", async () => {
    const { sandbox } = makeSandbox();
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    const { record: out, nextAlarmDelayMs } = await stepExecution(record({ step: "bootstrapping" }), deps);
    assert.equal(out.step, "cloning");
    assert.equal(nextAlarmDelayMs, 0);
  });

  it("clone runs git clone + checkout to the exact mergeSha, then advances to installing", async () => {
    const { sandbox, execCalls } = makeSandbox();
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    const { record: out } = await stepExecution(record({ step: "cloning" }), deps);
    assert.equal(out.step, "installing");
    assert.ok(execCalls.some((c) => c.command.includes("git clone") && c.command.includes("calcom/cal.diy")));
    assert.ok(execCalls.some((c) => c.command.includes(`git checkout --quiet --force --detach ${"b".repeat(40)}`)));
  });

  it("install failure surfaces install-failed with stdout/stderr tail, never silently passes", async () => {
    const { sandbox } = makeSandbox({ exec: (cmd) => (cmd.includes("yarn install") ? { success: false, exitCode: 1, stderr: "EACCES boom" } : undefined) });
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    const { record: out, nextAlarmDelayMs } = await stepExecution(record({ step: "installing" }), deps);
    assert.equal(out.step, "failed");
    assert.equal(out.errorClass, "install-failed");
    assert.match(out.lastError ?? "", /EACCES boom/);
    assert.equal(nextAlarmDelayMs, null);
  });

  it("install success advances to pretest and records installMs", async () => {
    const { sandbox } = makeSandbox();
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket, 9000);
    const { record: out } = await stepExecution(record({ step: "installing", timings: {} }), deps);
    assert.equal(out.step, "pretest");
    assert.equal(typeof out.timings.installMs, "number");
  });

  it("pretest runs every configured pretest step and fails fast on the first non-zero exit", async () => {
    const { sandbox, execCalls } = makeSandbox({ exec: (cmd) => (cmd.includes("prisma generate") ? { success: false, exitCode: 1, stderr: "db unreachable" } : undefined) });
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    const { record: out } = await stepExecution(record({ step: "pretest" }), deps);
    assert.equal(out.step, "failed");
    assert.equal(out.errorClass, "pretest-failed");
    assert.ok(execCalls.some((c) => c.command.includes("prisma generate")));
  });

  describe("full-baseline (a representative test-run step: start-then-poll across alarms)", () => {
    it("first alarm starts the process (never fabricating a result) and requests a POLL_MS re-alarm", async () => {
      const { sandbox, startProcessCalls } = makeSandbox({ process: { status: "running" } });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket, 3000);
      const { record: out, nextAlarmDelayMs } = await stepExecution(record({ step: "full-baseline" }), deps);
      assert.equal(out.step, "full-baseline"); // still running - has not advanced
      assert.equal(nextAlarmDelayMs, POLL_MS);
      assert.equal(out.processId, "proc-1");
      assert.equal(out.processStartedAt, 3000);
      assert.equal(startProcessCalls.length, 1);
      assert.match(startProcessCalls[0]!.command, /yarn test -- --no-isolate --reporter=json --outputFile=\/workspace\/full-baseline\.json/);
      assert.match(startProcessCalls[0]!.command, /TZ=UTC/);
    });

    it("a later alarm with a still-running process polls again without re-starting it", async () => {
      const { sandbox, startProcessCalls } = makeSandbox({ process: { status: "running" } });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out, nextAlarmDelayMs } = await stepExecution(record({ step: "full-baseline", processId: "proc-1", processStartedAt: 1000 }), deps);
      assert.equal(nextAlarmDelayMs, POLL_MS);
      assert.equal(startProcessCalls.length, 0); // resumed, not restarted
      assert.equal(out.step, "full-baseline");
    });

    it("terminal completed process with a parseable report advances to selected-baseline and never fabricates counts", async () => {
      const raw = JSON.stringify({ numTotalTestSuites: 40, numFailedTestSuites: 0, numTotalTests: 250, numFailedTests: 0, numPassedTests: 250, testResults: [] });
      const { sandbox } = makeSandbox({ process: { status: "completed", exitCode: 0 }, readFile: { "/workspace/full-baseline.json": raw } });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket, 61_000);
      const { record: out, nextAlarmDelayMs } = await stepExecution(record({ step: "full-baseline", processId: "proc-1", processStartedAt: 1000 }), deps);
      assert.equal(out.step, "selected-baseline");
      assert.equal(nextAlarmDelayMs, 0);
      assert.equal(out.processId, undefined); // cleared for the next test-run step
      assert.equal(out.baseline?.full.tests, 250);
      assert.equal(out.baseline?.full.failed, 0);
      assert.equal(out.baseline?.full.wallMs, 60_000);
    });

    it("terminal process but a MISSING report yields parsed:undefined fields, never a fabricated pass", async () => {
      const { sandbox } = makeSandbox({ process: { status: "completed", exitCode: 0 } }); // no readFile entries -> throws
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out } = await stepExecution(record({ step: "full-baseline", processId: "proc-1", processStartedAt: 1000 }), deps);
      assert.equal(out.baseline?.full.tests, undefined);
      assert.equal(out.baseline?.full.passed, undefined);
      assert.equal(out.baseline?.full.failed, undefined);
      assert.equal(out.step, "selected-baseline"); // still advances - "unexecuted" is reported via undefined fields, not a stall
    });

    it("a killed/errored process is reported as timedOut, still advancing (never silently treated as passing)", async () => {
      const { sandbox } = makeSandbox({ process: { status: "killed", exitCode: 137 } });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out } = await stepExecution(record({ step: "full-baseline", processId: "proc-1", processStartedAt: 1000 }), deps);
      assert.equal(out.baseline?.full.timedOut, true);
      assert.equal(out.baseline?.full.exitCode, 137);
    });
  });

  it("selected-baseline appends the selected test paths as trailing argv", async () => {
    const { sandbox, startProcessCalls } = makeSandbox({ process: { status: "running" } });
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    await stepExecution(record({ step: "selected-baseline", baseline: { full: { command: [], exitCode: 0, timedOut: false, wallMs: 1 }, selected: undefined as never } }), deps);
    assert.match(startProcessCalls[0]!.command, /apps\/web\/lib\/foo\.test\.ts/);
  });

  describe("mutate", () => {
    it("no non-test source file changed -> skips mutation and goes straight to reverting", async () => {
      const { sandbox } = makeSandbox({ exec: (cmd) => (cmd.includes("git diff --name-only") ? { stdout: "" } : undefined) });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out } = await stepExecution(record({ step: "mutating" }), deps);
      assert.equal(out.step, "reverting");
      assert.equal(out.mutation?.applied, false);
      assert.match(out.mutation?.skippedReason ?? "", /no non-test source file/);
    });

    it("every changed file is newly added at base -> skips mutation, records why", async () => {
      const { sandbox } = makeSandbox({
        exec: (cmd) => {
          if (cmd.includes("git diff --name-only")) return { stdout: "apps/web/new.ts\n" };
          if (cmd.includes("git cat-file -e")) return { stdout: "no\n" };
          return undefined;
        },
      });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out } = await stepExecution(record({ step: "mutating" }), deps);
      assert.equal(out.step, "reverting");
      assert.equal(out.mutation?.applied, false);
      assert.match(out.mutation?.skippedReason ?? "", /newly added/);
    });

    it("applies the whole-file revert to the first candidate that existed at base, advancing to full-mutant", async () => {
      const { sandbox, execCalls } = makeSandbox({
        exec: (cmd) => {
          if (cmd.includes("git diff --name-only")) return { stdout: "apps/web/foo.ts\napps/web/bar.ts\n" };
          if (cmd.includes("git cat-file -e") && cmd.includes("foo.ts")) return { stdout: "no\n" };
          if (cmd.includes("git cat-file -e") && cmd.includes("bar.ts")) return { stdout: "yes\n" };
          return undefined;
        },
      });
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out } = await stepExecution(record({ step: "mutating" }), deps);
      assert.equal(out.step, "full-mutant");
      assert.equal(out.mutation?.applied, true);
      assert.equal(out.mutation?.path, "apps/web/bar.ts");
      assert.ok(execCalls.some((c) => c.command.includes(`git show ${"a".repeat(40)}:apps/web/bar.ts`)));
    });
  });

  it("full-mutant is skipped straight to reverting when no mutation was applied", async () => {
    const { sandbox, startProcessCalls } = makeSandbox();
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    const { record: out } = await stepExecution(record({ step: "full-mutant", mutation: { path: "", applied: false, skippedReason: "x" } }), deps);
    assert.equal(out.step, "reverting");
    assert.equal(startProcessCalls.length, 0); // no test process spawned when there is nothing to prove recall on
  });

  it("revert restores the mutated file from mergeSha and advances to finalizing even if git checkout throws", async () => {
    const { sandbox } = makeSandbox({ exec: () => { throw new Error("git unreachable"); } });
    const { bucket } = makeBucket();
    const { deps } = makeDeps(sandbox, bucket);
    const { record: out } = await stepExecution(record({ step: "reverting", mutation: { path: "apps/web/bar.ts", applied: true } }), deps);
    assert.equal(out.step, "finalizing"); // measurement already taken - a revert failure doesn't invalidate it
    assert.match(out.lastError ?? "", /git unreachable/);
  });

  describe("finalize", () => {
    it("computes economics using the threaded analysisOverheadMs, never a hardcoded value", async () => {
      const { sandbox, isDestroyed } = makeSandbox();
      const { bucket, putCalls } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const rec = record({
        step: "finalizing",
        analysisOverheadMs: 4_000,
        baseline: {
          full: { command: [], exitCode: 0, timedOut: false, wallMs: 100_000 },
          selected: { command: [], exitCode: 0, timedOut: false, wallMs: 10_000 },
        },
      });
      const { record: out, nextAlarmDelayMs } = await stepExecution(rec, deps);
      assert.equal(out.step, "done");
      assert.equal(nextAlarmDelayMs, null);
      assert.equal(out.economics?.analysisOverheadMs, 4_000);
      assert.equal(out.economics?.grossSavedMs, 90_000);
      assert.equal(out.economics?.netSavedMs, 86_000);
      assert.equal(isDestroyed(), true);
      assert.equal(putCalls.length, 1);
    });

    it("recall is unmeasurable (not falsely 'safe') when the full suite itself misses the mutant", async () => {
      const { sandbox } = makeSandbox();
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const rec = record({
        step: "finalizing",
        mutation: { path: "apps/web/bar.ts", applied: true },
        mutant: {
          full: { command: [], exitCode: 0, timedOut: false, wallMs: 1, failed: 0 },
          selected: { command: [], exitCode: 0, timedOut: false, wallMs: 1, failed: 0 },
        },
      });
      const { record: out } = await stepExecution(rec, deps);
      assert.equal(out.recall?.fullSuiteCaughtMutant, false);
      assert.equal(out.recall?.recallMeasurable, false);
    });

    it("recall is measurable and reports a real selected-suite miss when the full suite catches the mutant but selected does not", async () => {
      const { sandbox } = makeSandbox();
      const { bucket } = makeBucket();
      const { deps } = makeDeps(sandbox, bucket);
      const rec = record({
        step: "finalizing",
        mutation: { path: "apps/web/bar.ts", applied: true },
        mutant: {
          full: { command: [], exitCode: 1, timedOut: false, wallMs: 1, failed: 1 },
          selected: { command: [], exitCode: 0, timedOut: false, wallMs: 1, failed: 0 },
        },
      });
      const { record: out } = await stepExecution(rec, deps);
      assert.equal(out.recall?.fullSuiteCaughtMutant, true);
      assert.equal(out.recall?.recallMeasurable, true);
      assert.equal(out.recall?.selectedSuiteCaughtMutant, false);
    });

    it("destroys the sandbox even when finalize itself throws", async () => {
      const { sandbox, isDestroyed } = makeSandbox();
      const bucket: R2BucketLike = {
        async get() { return null; },
        async put() { throw new Error("R2 unavailable"); },
      };
      const { deps } = makeDeps(sandbox, bucket);
      const { record: out } = await stepExecution(record({ step: "finalizing" }), deps);
      assert.equal(out.step, "failed");
      assert.equal(out.errorClass, "finalize-failed");
      assert.equal(isDestroyed(), true);
    });
  });

  it("seedExecutionRecord starts at bootstrapping and carries analysisOverheadMs through verbatim", () => {
    const rec = seedExecutionRecord(spec({ analysisOverheadMs: 12_345 }), "standard-4", 500);
    assert.equal(rec.step, "bootstrapping");
    assert.equal(rec.analysisOverheadMs, 12_345);
    assert.equal(rec.startedAt, 500);
  });
});
