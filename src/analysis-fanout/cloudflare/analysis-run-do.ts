/**
 * AnalysisRun - the coordinator Durable Object for one fan-out run (2026-08-23).
 *
 * One AnalysisRun instance per `runId`. It is the single writer of run/shard state (the control Worker
 * only enqueues work and reads state back), and it owns the liveness watchdog: shards heartbeat it
 * while doing real work, and its alarm marks a shard `failed` if the heartbeat goes stale.
 *
 * All mutable state lives in DO storage, so `GET /v1/run/:runId` is a consistent point-in-time snapshot
 * even while containers are running concurrently.
 */
import type {
  RepositorySpec,
  RunState,
  RunStatus,
  ShardRecord,
  ShardState,
  ShardStatus,
} from "../fanout-types.js";
import { computeNextAlarmAt, findStaleShards } from "../watchdog.js";

/**
 * Minimal structural typing for the Durable Object runtime (this repo does not depend on
 * @cloudflare/workers-types, matching the existing product-path code).
 */
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
type DONamespace = any;
interface DOStub {
  fetch(request: Request): Promise<Response>;
}
export interface RunEnv {
  ANALYSIS_SHARD_MACHINE: DONamespace;
}

const STATE_KEY = "run";
const SEEDS_KEY = "shardSeeds";

export interface InitPayload {
  runId: string;
  createdAt: number;
  shape: string;
  shardsPerRepository: number;
  maxConcurrentShards: number;
  repositories: RepositorySpec[];
  engineChecksum: string;
  tarballKey: string;
  tarballSha256: string;
  shards: ShardState[];
  shardSeeds: ShardRecord[];
}

export interface HeartbeatPayload {
  shardId: string;
  status?: ShardStatus;
  rowsCompleted?: number;
  lastError?: string;
  peakMemMb?: number;
  memAvailableBeforeMb?: number;
  memAvailableAfterMb?: number;
  diskFreeBytes?: number;
  timings?: ShardState["timings"];
}

/** Shard statuses that count as "still working" (i.e. still holding a concurrency slot). */
export const RUNNING_SHARD_STATUSES: ReadonlySet<ShardStatus> = new Set<ShardStatus>([
  "bootstrapping",
  "cloning",
  "analyzing",
  "finalizing",
]);
/** Shard statuses after which no further shard work can happen (a concurrency slot is released). */
export const TERMINAL_SHARD_STATUSES: ReadonlySet<ShardStatus> = new Set<ShardStatus>([
  "done",
  "failed",
  "cancelled",
]);

export function countRunningShards(shards: ShardState[]): number {
  return shards.filter((s) => RUNNING_SHARD_STATUSES.has(s.status)).length;
}

/** Select the pending shards to release now, respecting the concurrency bound. */
export function selectNextReleases(shards: ShardState[], maxConcurrentShards: number): ShardState[] {
  const available = maxConcurrentShards - countRunningShards(shards);
  if (available <= 0) return [];
  return shards.filter((s) => s.status === "pending").slice(0, available);
}

/** Derive the run-level status from its shards. Terminal wins; otherwise still running. */
export function recomputeRunStatus(run: RunState): RunStatus {
  if (run.status === "cancelled") return "cancelled";
  if (run.shards.length === 0) return "running";
  if (run.shards.every((s) => TERMINAL_SHARD_STATUSES.has(s.status))) {
    return run.shards.some((s) => s.status === "failed") ? "failed" : "completed";
  }
  return "running";
}

/**
 * Release the next bounded batch of pending shards (never exceeding `maxConcurrentShards` total
 * running). `startShard` is the single place the shard DO `/start` call is made; a start failure is
 * recorded on the shard so the run can surface it, without aborting the remaining releases.
 */
export async function releasePendingShards(
  run: RunState,
  seeds: ReadonlyMap<string, ShardRecord>,
  startShard: (seed: ShardRecord) => Promise<void>,
  now: number,
): Promise<void> {
  for (const shard of selectNextReleases(run.shards, run.maxConcurrentShards)) {
    const seed = seeds.get(shard.id);
    if (!seed) {
      shard.status = "failed";
      shard.lastError = "failed: missing shard seed";
      shard.heartbeatAt = now;
      continue;
    }
    shard.status = "bootstrapping";
    shard.heartbeatAt = now;
    try {
      await startShard(seed);
    } catch (err) {
      shard.status = "failed";
      shard.lastError = `failed: start shard: ${err instanceof Error ? err.message : String(err)}`;
      shard.heartbeatAt = now;
    }
  }
}

export class AnalysisRun {
  private readonly state: DurableObjectState;
  private readonly env: RunEnv;

  constructor(state: DurableObjectState, env: RunEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "POST" && url.pathname === "/init") return await this.init((await request.json()) as InitPayload);
      if (request.method === "POST" && url.pathname === "/heartbeat") return await this.heartbeat((await request.json()) as HeartbeatPayload);
      if (request.method === "POST" && url.pathname === "/cancel") return await this.cancel();
      if (request.method === "GET" && url.pathname === "/state") {
        return Response.json((await this.getState()) ?? { ok: false, error: "not-found" });
      }
      return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    } catch (err) {
      return Response.json({ ok: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
    }
  }

  /**
   * One bounded tick of the state machine: release pending shards up to the concurrency bound, fail
   * stale active shards (watchdog), then recompute the run status and re-arm for the next tick.
   */
  async alarm(): Promise<void> {
    const run = await this.getState();
    if (!run) return;
    const now = Date.now();
    if (run.status !== "running") {
      await this.state.storage.deleteAlarm();
      return;
    }

    const seeds = await this.getSeeds();
    await releasePendingShards(run, seeds, (seed) => this.startShard(seed), now);

    for (const s of findStaleShards(run.shards, now)) {
      if (s.status !== "failed") {
        s.status = "failed";
        s.lastError = "failed: watchdog (no heartbeat for >35min)";
        s.heartbeatAt = now;
      }
    }

    run.status = recomputeRunStatus(run);
    await this.state.storage.put(STATE_KEY, run);

    const next = this.scheduleNextAlarm(run, now);
    if (next !== null) await this.state.storage.setAlarm(next);
    else await this.state.storage.deleteAlarm();
  }
private async init(payload: InitPayload): Promise<Response> {
    const existing = await this.getState();
    if (existing) return Response.json({ ok: false, error: "runId already exists" }, { status: 409 });
    const now = Date.now();
    const run: RunState = {
      runId: payload.runId,
      createdAt: payload.createdAt,
      status: "running",
      shape: payload.shape,
      shardsPerRepository: payload.shardsPerRepository,
      maxConcurrentShards: payload.maxConcurrentShards,
      repositories: payload.repositories,
      engineChecksum: payload.engineChecksum,
      tarballKey: payload.tarballKey,
      tarballSha256: payload.tarballSha256,
      shards: payload.shards,
    };
    await this.state.storage.put(STATE_KEY, run);
    await this.state.storage.put(SEEDS_KEY, payload.shardSeeds);

    // Release the first batch immediately so the run starts without waiting for the first alarm tick.
    await releasePendingShards(run, await this.getSeeds(), (seed) => this.startShard(seed), now);
    run.status = recomputeRunStatus(run);
    await this.state.storage.put(STATE_KEY, run);

    const next = this.scheduleNextAlarm(run, now);
    if (next !== null) await this.state.storage.setAlarm(next);
    return Response.json({ ok: true, runId: run.runId, shardCount: run.shards.length });
  }

  private async heartbeat(payload: HeartbeatPayload): Promise<Response> {
    const run = await this.getState();
    if (!run) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    const shard = run.shards.find((s) => s.id === payload.shardId);
    if (!shard) return Response.json({ ok: false, error: "shard not-found" }, { status: 404 });
    const now = Date.now();
    if (payload.status !== undefined) shard.status = payload.status;
    if (payload.rowsCompleted !== undefined) shard.rowsCompleted = payload.rowsCompleted;
    if (payload.lastError !== undefined) shard.lastError = payload.lastError;
    if (payload.peakMemMb !== undefined) shard.peakMemMb = payload.peakMemMb;
    if (payload.memAvailableBeforeMb !== undefined) shard.memAvailableBeforeMb = payload.memAvailableBeforeMb;
    if (payload.memAvailableAfterMb !== undefined) shard.memAvailableAfterMb = payload.memAvailableAfterMb;
    if (payload.diskFreeBytes !== undefined) shard.diskFreeBytes = payload.diskFreeBytes;
    if (payload.timings !== undefined) shard.timings = { ...shard.timings, ...payload.timings };
    shard.heartbeatAt = now;

    // A terminal shard releases a slot immediately (no in-memory limiter): release the next pending.
    if (payload.status !== undefined && TERMINAL_SHARD_STATUSES.has(payload.status)) {
      await releasePendingShards(run, await this.getSeeds(), (seed) => this.startShard(seed), now);
    }

    run.status = recomputeRunStatus(run);
    await this.state.storage.put(STATE_KEY, run);

    const next = this.scheduleNextAlarm(run, now);
    if (next !== null) await this.state.storage.setAlarm(next);
    else await this.state.storage.deleteAlarm();
    return Response.json({ ok: true });
  }

  private async cancel(): Promise<Response> {
    const run = await this.getState();
    if (!run) return Response.json({ ok: false, error: "not-found" }, { status: 404 });
    run.status = "cancelled";
    const seeds = await this.getSeeds();
    for (const s of run.shards) {
      if (TERMINAL_SHARD_STATUSES.has(s.status)) continue;
      s.status = "cancelled";
      const seed = seeds.get(s.id);
      if (seed) {
        try {
          await this.startShardCancel(seed);
        } catch {
          // best-effort: the run is already marked cancelled locally; the shard will be reaped by its
          // own alarm if the cancel request never reaches it.
        }
      }
    }
    await this.state.storage.put(STATE_KEY, run);
    await this.state.storage.deleteAlarm();
    return Response.json({ ok: true, runId: run.runId, status: "cancelled" });
  }

  /** Compute when the next alarm should fire, or null if no further ticks are needed. */
  private scheduleNextAlarm(run: RunState, now: number): number | null {
    if (run.status !== "running") return null;
    const available = run.maxConcurrentShards - countRunningShards(run.shards);
    const hasPending = run.shards.some((s) => s.status === "pending");
    if (hasPending && available > 0) return now + 1000;
    return computeNextAlarmAt(run.shards, now) ?? (hasPending ? now + 5000 : null);
  }

  private async startShard(seed: ShardRecord): Promise<void> {
    const ns = this.env.ANALYSIS_SHARD_MACHINE as DONamespace;
    const stub = ns.get(ns.idFromName(seed.id)) as DOStub;
    const resp = await stub.fetch(new Request("https://do/start", { method: "POST", body: JSON.stringify(seed) }));
    if (!resp.ok) throw new Error(`shard /start ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }

  private async startShardCancel(seed: ShardRecord): Promise<void> {
    const ns = this.env.ANALYSIS_SHARD_MACHINE as DONamespace;
    const stub = ns.get(ns.idFromName(seed.id)) as DOStub;
    await stub.fetch(new Request("https://do/cancel", { method: "POST" }));
  }

  private async getSeeds(): Promise<Map<string, ShardRecord>> {
    const seeds = await this.state.storage.get<ShardRecord[]>(SEEDS_KEY);
    return new Map((seeds ?? []).map((s) => [s.id, s]));
  }

  private async getState(): Promise<RunState | undefined> {
    return this.state.storage.get<RunState>(STATE_KEY);
  }
}