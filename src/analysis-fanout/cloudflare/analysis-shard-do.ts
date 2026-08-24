/**
 * AnalysisShard - one alarm-driven Durable Object per fan-out shard (2026-08-23).
 *
 * The shard's whole lifecycle used to live inside a `ctx.waitUntil(...)` in the control Worker, with a
 * `while (true)` poll loop that ran for 15-40 minutes - a Worker only extends a request by a bounded
 * grace period, so the fan-out was terminated mid-flight and the watchdog then marked every shard
 * failed. The fix moves the state machine here: a thin sibling DO that owns a Sandbox container by
 * name and advances ONE bounded step per `alarm()` invocation, persisting `step`, `processId`,
 * `flushedLines` and `rows` so an eviction or a double-fired alarm resumes without re-cloning,
 * re-extracting, or duplicating rows.
 *
 * Steps (each fits inside one DO invocation):
 *   bootstrapping -> cloning -> analyzing (poll, re-schedule) -> finalizing -> done | failed
 *
 * The engine itself (src/repo/*, src/git/*, scripts/diffci-benchmark-external.ts,
 * scripts/diffci-blind-baseline.ts) is FROZEN - this DO only bootstraps it into a container from a
 * source tarball, verifies the frozen engine against a manifest downloaded from R2 (not the tarball
 * copy), and drives the unmodified replay driver with a deterministic per-shard slice manifest.
 */
import { isResourceKill, resourceKillRow } from "../row-mapping.js";
import type { SandboxLike, R2BucketLike } from "../sandbox-like.js";
import type {
  ShardRecord,
  ShardProbe,
  ShardStatus,
  ShardStep,
  ShardTimings,
} from "../fanout-types.js";

export const SHAPE = "standard-2";
/** How long the shard sleeps between poll alarms while the replay driver runs. */
export const POLL_MS = 20_000;

const SANDBOX_OPTS = { enableDefaultSession: false, keepAlive: false, sleepAfter: "10m", transport: "rpc" } as const;
const STATE_KEY = "shard";
const TERMINAL_PROCESS: ReadonlySet<string> = new Set(["completed", "failed", "killed", "error"]);
const TERMINAL_STEPS: ReadonlySet<ShardStep> = new Set(["done", "failed", "cancelled"]);

/** Minimal Durable Object runtime typing (no @cloudflare/workers-types dependency). */
interface DurableObjectStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  setAlarm(scheduledTime: number | Date): Promise<void>;
  deleteAlarm(): Promise<void>;
  getAlarm(): Promise<number | null>;
}
interface DurableObjectState {
  storage: DurableObjectStorage;
  waitUntil(promise: Promise<unknown>): void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SandboxNamespace = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DONamespace = any;
interface DOStub {
  fetch(request: Request): Promise<Response>;
}

export interface ShardEnv {
  ANALYSIS_SHARD_CONTAINER: SandboxNamespace;
  ANALYSIS_RUN: DONamespace;
  ANALYSIS_BUCKET: R2BucketLike;
}

/** A heartbeat update the shard sends to the AnalysisRun coordinator (minus the shardId). */
export interface ShardHeartbeat {
  status?: ShardStatus;
  rowsCompleted?: number;
  lastError?: string;
  peakMemMb?: number;
  memAvailableBeforeMb?: number;
  memAvailableAfterMb?: number;
  diskFreeBytes?: number;
  timings?: ShardTimings;
}

/**
 * The injectable dependencies of the state machine. `stepShard` depends only on this structural
 * surface (a Sandbox stub + R2 stub + heartbeat), so the whole machine is testable with no network
 * and no real container - exactly like tests/runner/*.test.ts stub their providers.
 */
export interface ShardStepDeps {
  sandbox: SandboxLike;
  bucket: R2BucketLike;
  heartbeat(p: ShardHeartbeat): Promise<void>;
  now(): number;
}

export interface ShardStepResult {
  record: ShardRecord;
  /** Delay until the next alarm; `null` means the shard reached a terminal state. */
  nextAlarmDelayMs: number | null;
}

export function repoSlug(repo: string): string {
  return repo.replace("/", "__");
}

function parseMemAvailableMb(stdout: string): number | undefined {
  const m = /MemAvailable:\s*(\d+)\s*kB/.exec(stdout);
  return m ? Math.round(Number(m[1]) / 1024) : undefined;
}

/** Parse the live-shape probe (`nproc`, `MemAvailable`, `df -B1 /workspace`). */
export function parseProbe(stdout: string): ShardProbe {
  const nproc = /nproc=(\d+)/.exec(stdout);
  const df = /(\d+)\s+\d+\s+\d+\s+\d+%\s+\/workspace\s*$/.exec(stdout);
  return {
    nproc: nproc ? Number(nproc[1]) : undefined,
    memAvailableMb: parseMemAvailableMb(stdout),
    diskFreeBytes: df ? Number(df[1]) : undefined,
    raw: stdout,
  };
}

/** Pull every not-yet-flushed line out of the container's rows.jsonl and append it to `rows`. */
async function ingestRows(sandbox: SandboxLike, rows: string[], flushedLines: number): Promise<number> {
  try {
    const content = (await sandbox.readFile("/workspace/rows.jsonl")).content ?? "";
    const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length > flushedLines) {
      rows.push(...lines.slice(flushedLines));
      return lines.length;
    }
    return flushedLines;
  } catch {
    return flushedLines; // rows.jsonl not created yet
  }
}

async function flushRows(bucket: R2BucketLike, record: ShardRecord, rows: string[]): Promise<void> {
  await bucket.put(
    `runs/${record.runId}/${repoSlug(record.repo)}/shard-${record.shardIndex}.jsonl`,
    rows.join("\n") + (rows.length ? "\n" : ""),
  );
}

function summaryKey(record: ShardRecord): string {
  return `runs/${record.runId}/${repoSlug(record.repo)}/shard-${record.shardIndex}-summary.json`;
}

function buildSummary(record: ShardRecord): Record<string, unknown> {
  return {
    runId: record.runId,
    repo: record.repo,
    shardIndex: record.shardIndex,
    shardCount: record.shardCount,
    status: record.errorClass ? "failed" : "done",
    rowsCompleted: record.rows.length,
    mergeCount: record.mergeCount,
    unanalyzedMerges: record.mergeCount - record.rows.length,
    exitCode: record.exitCode,
    errorClass: record.errorClass,
    lastError: record.lastError,
    peakMemMb: record.peakMemMb,
    memAvailableBeforeMb: record.memBeforeMb,
    memAvailableAfterMb: record.memAfterMb,
    diskFreeBytes: record.diskBeforeBytes,
    probe: record.probe,
    timings: record.timings,
    sliceChecksum: record.slice.mergeListSha256,
    parentManifestSha256: record.slice.parentManifestSha256,
  };
}

/** Mark the shard failed with a fatal shard-level error class and heartbeat it. */
async function failShard(record: ShardRecord, deps: ShardStepDeps, errorClass: string, lastError: string): Promise<void> {
  record.step = "failed";
  record.errorClass = errorClass;
  record.lastError = lastError;
  await deps.heartbeat({ status: "failed", lastError });
}

async function bootstrap(record: ShardRecord, deps: ShardStepDeps): Promise<ShardStepResult> {
  const { sandbox, bucket } = deps;
  try {
    await deps.heartbeat({ status: "bootstrapping" });

    // 1. Probe the LIVE shape before trusting any result (nproc / MemAvailable / disk).
    const probe = await sandbox.exec("echo nproc=$(nproc); grep MemAvailable /proc/meminfo; df -B1 /workspace | tail -1", { timeout: 30_000 });
    record.probe = parseProbe(probe.stdout);
    record.memBeforeMb = record.probe.memAvailableMb;
    record.diskBeforeBytes = record.probe.diskFreeBytes;

    // 2. Source tarball from R2 -> extract.
    const tar = await bucket.get(record.tarballKey);
    if (!tar) {
      await failShard(record, deps, "tarball-missing", `tarball missing in R2: ${record.tarballKey}`);
      return { record, nextAlarmDelayMs: null };
    }
    await sandbox.exec("rm -rf /opt/diffci /workspace && mkdir -p /opt/diffci /workspace", { timeout: 30_000 });
    await sandbox.writeFile("/opt/diffci-source.tgz", tar.body);
    await sandbox.exec("tar -xzf /opt/diffci-source.tgz -C /opt/diffci", { timeout: 120_000 });

    // 3. Mandatory post-transfer checksum: the bytes actually written must match the pack record's
    //    tarballSha256 (the Worker already verified the R2 object; this catches a corrupt/truncated
    //    transfer, the failure mode item 3 warns about).
    const sum = await sandbox.exec("sha256sum /opt/diffci-source.tgz", { timeout: 30_000 });
    const got = /^([0-9a-f]{64})/.exec(sum.stdout.trim());
    if (!got || got[1].toLowerCase() !== record.tarballSha256.toLowerCase()) {
      await failShard(record, deps, "tarball-corrupt", `post-transfer sha256 mismatch (${got ? got[1].slice(0, 12) : "none"} != ${record.tarballSha256.slice(0, 12)})`);
      return { record, nextAlarmDelayMs: null };
    }

    // 4. npm ci (bounded by an explicit exec timeout, not a request lifetime).
    const boot0 = deps.now();
    const npm = await sandbox.exec("cd /opt/diffci && npm ci --no-audit --no-fund", { timeout: 10 * 60_000 });
    if (!npm.success) {
      await failShard(record, deps, "bootstrap-failed", `npm ci exit ${npm.exitCode}: ${(npm.stdout + " " + npm.stderr).trim().slice(-1000)}`);
      return { record, nextAlarmDelayMs: null };
    }

    // 5. Download the frozen manifest FROM R2 (the trusted copy) and verify against it - NOT against
    //    the copy that shipped inside the tarball (a modified tarball with a regenerated manifest used
    //    to pass both checks).
    const frozen = await bucket.get(record.frozenManifestKey);
    if (!frozen) {
      await failShard(record, deps, "frozen-manifest-missing", `frozen manifest missing in R2: ${record.frozenManifestKey}`);
      return { record, nextAlarmDelayMs: null };
    }
    await sandbox.writeFile("/opt/frozen-manifest.json", await frozen.text());
    const verify = await sandbox.exec(
      "cd /opt/diffci && node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs --manifest /opt/frozen-manifest.json",
      { timeout: 120_000 },
    );
    if (!verify.success) {
      await failShard(record, deps, "engine-drift", `verify-frozen-engine exit ${verify.exitCode}: ${(verify.stdout + " " + verify.stderr).trim().slice(0, 1000)}`);
      return { record, nextAlarmDelayMs: null };
    }

    record.timings.bootstrapMs = deps.now() - boot0;
    record.step = "cloning";
    await deps.heartbeat({ status: "cloning", timings: { bootstrapMs: record.timings.bootstrapMs }, memAvailableBeforeMb: record.memBeforeMb, diskFreeBytes: record.diskBeforeBytes });
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    await failShard(record, deps, "bootstrap-failed", err instanceof Error ? err.message : String(err));
    return { record, nextAlarmDelayMs: null };
  }
}

async function clone(record: ShardRecord, deps: ShardStepDeps): Promise<ShardStepResult> {
  const { sandbox } = deps;
  try {
    await deps.heartbeat({ status: "cloning" });
    const clone0 = deps.now();
    // Blob-less clone; blobs arrive on checkout.
    await sandbox.exec(`git clone --filter=blob:none https://github.com/${record.repo}.git /workspace/${repoSlug(record.repo)}`, { timeout: 20 * 60_000 });
    record.timings.cloneMs = deps.now() - clone0;
    record.step = "analyzing";
    await deps.heartbeat({ status: "analyzing", timings: { cloneMs: record.timings.cloneMs } });
    return { record, nextAlarmDelayMs: 0 };
  } catch (err) {
    await failShard(record, deps, "clone-failed", err instanceof Error ? err.message : String(err));
    return { record, nextAlarmDelayMs: null };
  }
}

async function analyze(record: ShardRecord, deps: ShardStepDeps): Promise<ShardStepResult> {
  const { sandbox, bucket } = deps;
  try {
    // First analyzing alarm: write the slice manifest and START the replay driver once. On every later
    // alarm (and after an eviction), `processId` is persisted so we poll instead of restarting.
    if (!record.processId) {
      await sandbox.writeFile("/workspace/slice.json", JSON.stringify(record.slice, null, 2));
      const memMid = await sandbox.exec("grep MemAvailable /proc/meminfo", { timeout: 30_000 });
      record.memAfterMb = parseMemAvailableMb(memMid.stdout);
      await deps.heartbeat({ status: "analyzing", memAvailableAfterMb: record.memAfterMb });

      const timeAvail = (await sandbox.exec("command -v /usr/bin/time >/dev/null 2>&1 && echo yes || echo no", { timeout: 30_000 })).stdout.trim() === "yes";
      // startProcess, never exec: a full slice can exceed the ~580 s SDK exec cap.
      const cmd = `cd /opt/diffci && ${timeAvail ? "/usr/bin/time -v -o /workspace/time.txt " : ""}npx tsx scripts/diffci-blind-baseline.ts replay --clone /workspace/${repoSlug(record.repo)} --manifest /workspace/slice.json --out /workspace/rows.jsonl`;
      const proc = await sandbox.startProcess(cmd, { cwd: "/opt/diffci", autoCleanup: false });
      record.processId = proc.id;
      record.startedAt = deps.now();
      await deps.heartbeat({ status: "analyzing", rowsCompleted: record.rows.length });
      return { record, nextAlarmDelayMs: POLL_MS };
    }

    // Poll the already-running process: refresh status, flush any new rows to R2 (partial upload), heartbeat.
    let status: string | undefined;
    let exitCode: number | undefined;
    try {
      const info = await sandbox.getProcess(record.processId);
      status = info?.status;
      exitCode = info?.exitCode;
    } catch {
      status = "error";
    }

    record.flushedLines = await ingestRows(sandbox, record.rows, record.flushedLines);
    if (record.rows.length) await flushRows(bucket, record, record.rows);

    try {
      const t = (await sandbox.readFile("/workspace/time.txt")).content ?? "";
      const peak = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(t);
      if (peak) record.peakMemMb = Math.round(Number(peak[1]) / 1024);
    } catch {
      /* time.txt not yet written */
    }

    await deps.heartbeat({ status: "analyzing", rowsCompleted: record.rows.length, peakMemMb: record.peakMemMb });

    if (status && TERMINAL_PROCESS.has(status)) {
      record.exitCode = exitCode;
      // A resource-kill (exit 137 / killed) maps to a row-level errorClass for the in-flight merge with
      // NO verdict; the already-written rows are preserved as the partial result.
      if (isResourceKill(exitCode) || status === "killed") {
        const inflight = record.slice.merges[record.rows.length];
        if (inflight) {
          record.rows.push(JSON.stringify(resourceKillRow(inflight, record.repo, { shape: SHAPE, memAvailableBeforeMb: record.memAfterMb, memAvailableAfterMb: undefined, peakRssMb: record.peakMemMb })));
          await flushRows(bucket, record, record.rows);
        }
        record.errorClass = "resource-kill";
        record.lastError = `resource-kill (exit ${exitCode ?? "killed"})`;
      } else if (exitCode !== undefined && exitCode !== 0) {
        record.errorClass = `exit:${exitCode}`;
        record.lastError = `replay exit ${exitCode}`;
      }
      record.step = "finalizing";
      await deps.heartbeat({ status: "finalizing", rowsCompleted: record.rows.length, lastError: record.lastError, peakMemMb: record.peakMemMb });
      return { record, nextAlarmDelayMs: 0 };
    }

    return { record, nextAlarmDelayMs: POLL_MS };
  } catch (err) {
    await failShard(record, deps, "analyze-failed", err instanceof Error ? err.message : String(err));
    return { record, nextAlarmDelayMs: null };
  }
}

async function finalize(record: ShardRecord, deps: ShardStepDeps): Promise<ShardStepResult> {
  const { sandbox, bucket } = deps;
  try {
    record.flushedLines = await ingestRows(sandbox, record.rows, record.flushedLines);
    if (record.rows.length) await flushRows(bucket, record, record.rows);
    record.timings.totalMs = deps.now() - record.startedAt;
    await bucket.put(summaryKey(record), JSON.stringify(buildSummary(record), null, 2));

    const failed = record.errorClass !== undefined;
    record.step = failed ? "failed" : "done";
    await deps.heartbeat({
      status: failed ? "failed" : "done",
      rowsCompleted: record.rows.length,
      lastError: record.lastError,
      peakMemMb: record.peakMemMb,
      timings: record.timings,
    });
    return { record, nextAlarmDelayMs: null };
  } catch (err) {
    await failShard(record, deps, "finalize-failed", err instanceof Error ? err.message : String(err));
    return { record, nextAlarmDelayMs: null };
  } finally {
    try {
      await sandbox.destroy();
    } catch {
      /* best-effort teardown; sleepAfter backstop still applies */
    }
  }
}

/**
 * Advance a shard's state machine by exactly ONE bounded step. Returns the updated record (the caller
 * persists it) and the delay until the next alarm (or null at a terminal state). This is the heart of
 * the resumability guarantee: given a persisted record, an evicted+restored DO resumes from the exact
 * step it left off, without re-cloning, re-extracting, or duplicating rows.
 */
export async function stepShard(record: ShardRecord, deps: ShardStepDeps): Promise<ShardStepResult> {
  switch (record.step) {
    case "bootstrapping":
      return bootstrap(record, deps);
    case "cloning":
      return clone(record, deps);
    case "analyzing":
      return analyze(record, deps);
    case "finalizing":
      return finalize(record, deps);
    default:
      return { record, nextAlarmDelayMs: null };
  }
}

/**
 * The AnalysisShard Durable Object: owns a Sandbox container by name and is driven entirely by alarms.
 * `/start` persists the seed record and arms the first alarm, then returns immediately - nothing here
 * depends on a request lifetime.
 */
export class AnalysisShard {
  private readonly state: DurableObjectState;
  private readonly env: ShardEnv;

  constructor(state: DurableObjectState, env: ShardEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/start") {
        const seed = (await request.json()) as ShardRecord;
        const existing = await this.state.storage.get<ShardRecord>(STATE_KEY);
        if (existing && !TERMINAL_STEPS.has(existing.step)) {
          // Idempotent start: an already-running shard must not be re-seeded (would re-clone/re-extract).
          return Response.json({ ok: true, id: existing.id, alreadyRunning: true });
        }
        await this.state.storage.put(STATE_KEY, seed);
        await this.state.storage.setAlarm(Date.now() + 1000);
        return Response.json({ ok: true, id: seed.id });
      }
      if (request.method === "POST" && url.pathname === "/cancel") {
        await this.state.storage.deleteAlarm();
        const rec = await this.state.storage.get<ShardRecord>(STATE_KEY);
        if (rec && !TERMINAL_STEPS.has(rec.step)) {
          rec.step = "cancelled";
          await this.state.storage.put(STATE_KEY, rec);
        }
        return Response.json({ ok: true });
      }
      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  async alarm(): Promise<void> {
    const record = await this.state.storage.get<ShardRecord>(STATE_KEY);
    if (!record || TERMINAL_STEPS.has(record.step)) return;

    // Re-obtain the container handle by name; the container (and any running process) persists across
    // alarms and evictions. `@cloudflare/sandbox` is imported lazily so the pure state machine
    // (`stepShard` and its helpers) stays loadable under Node/tsx, whose ESM loader cannot resolve the
    // package's `cloudflare:` specifiers.
    const { getSandbox } = await import("@cloudflare/sandbox");
    const sandbox: SandboxLike = getSandbox(this.env.ANALYSIS_SHARD_CONTAINER, record.sandboxId, SANDBOX_OPTS);
    const deps: ShardStepDeps = {
      sandbox,
      bucket: this.env.ANALYSIS_BUCKET,
      heartbeat: async (p) => {
        try {
          const ns = this.env.ANALYSIS_RUN as DONamespace;
          const stub = ns.get(ns.idFromName(record.runId)) as DOStub;
          await stub.fetch(new Request("https://do/heartbeat", { method: "POST", body: JSON.stringify({ shardId: record.id, ...p }) }));
        } catch (err) {
          console.error("analysis-shard: heartbeat failed", err instanceof Error ? err.message : String(err));
        }
      },
      now: () => Date.now(),
    };

    const { record: updated, nextAlarmDelayMs } = await stepShard(record, deps);
    await this.state.storage.put(STATE_KEY, updated);
    if (nextAlarmDelayMs !== null) {
      await this.state.storage.setAlarm(Date.now() + nextAlarmDelayMs);
    } else {
      await this.state.storage.deleteAlarm();
    }
  }
}