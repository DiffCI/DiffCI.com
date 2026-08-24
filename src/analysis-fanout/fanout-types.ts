/**
 * Shared types for the DiffCI Cloudflare-Sandbox analysis fan-out (2026-08-23).
 *
 * This is product-path infrastructure: the same horizontal fan-out that runs the frozen blind
 * multi-repository baseline here will later analyze customer pull requests concurrently. The types
 * below are the stable wire/storage contract between the control Worker, the AnalysisRun Durable
 * Object, the Sandbox (AnalysisShard) containers, and the local CLI driver.
 *
 * NOTE: the engine itself (src/repo/*, src/git/*, scripts/diffci-benchmark-external.ts,
 * scripts/diffci-blind-baseline.ts) is FROZEN. Nothing in this directory changes its behaviour -
 * this is orchestration and reporting only.
 */

/** One PR-merge in an immutable selection manifest. `index` is the original 1-based position in the
 * parent manifest and is preserved verbatim through slicing so a collector can order rows globally. */
export interface MergeRow {
  index: number;
  prNumber: number | null;
  mergeSha: string;
  baseSha: string;
  mergeTimestamp: string;
  subject: string;
  changedFiles: number;
  mergeKind?: "merge-commit" | "squash-or-rebase";
  prVerified?: string;
  prMergedAt?: string;
  prMergeCommitSha?: string;
}

/** An immutable, frozen 30-merge selection manifest (see docs/research/blind-baseline-2026-08-23/). */
export interface SelectionManifest {
  repository: string;
  resolvedRepository?: string;
  url?: string;
  defaultBranch?: string;
  cutoff?: string;
  merges: MergeRow[];
  mergeListSha256: string;
  [key: string]: unknown;
}

/** A deterministic per-shard slice of a selection manifest. Carries the parent's merge-list checksum
 * (`parentManifestSha256`) so rows can be traced back to the immutable parent even though the slice's
 * own `mergeListSha256` is recomputed the same way the frozen driver validates it. */
export interface ShardSlice extends SelectionManifest {
  parentManifestSha256: string;
  parentRepository: string;
  shardIndex: number;
  shardCount: number;
}

export type ShardStatus =
  | "pending"
  | "bootstrapping"
  | "cloning"
  | "analyzing"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

/** The shard Durable Object's own persisted state-machine step. */
export type ShardStep =
  | "bootstrapping"
  | "cloning"
  | "analyzing"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

export interface RepositorySpec {
  /** e.g. "vercel/turborepo" - full owner/name. */
  name: string;
  /** R2 key of the immutable selection manifest. */
  manifestKey: string;
}

export interface RunRequest {
  runId: string;
  repositories: RepositorySpec[];
  shardsPerRepository: number;
  /**
   * Maximum number of shards the coordinator may keep running at once, across the whole run. Enforced
   * by the coordinator releasing the next pending shard only when one reaches a terminal state - never
   * by an in-memory mapWithConcurrency inside a single request. Defaults to 8.
   */
  maxConcurrentShards?: number;
}

/**
 * The pack record written by the CLI `pack` step and read back by the Worker at run time. It is the
 * single source of truth for the tarball's identity: the Worker re-hashes the R2 tarball object and
 * compares to `tarballSha256` (a client-supplied engineChecksum string is no longer trusted), and the
 * in-container verifier runs against the frozen manifest downloaded from R2 (`frozenManifestKey`),
 * not the copy inside the tarball.
 */
export interface PackRecord {
  runId: string;
  packedAt: string;
  /** R2 key of the packed source tarball. */
  tarballKey: string;
  /** SHA-256 hex of the tarball bytes, computed at pack time. */
  tarballSha256: string;
  tarballBytes: number;
  /** Frozen build manifest's engineChecksum (recorded for the run record; the tarball hash is the gate). */
  engineChecksum: string;
  /** R2 key of the frozen build manifest the container must download and verify against. */
  frozenManifestKey: string;
  gitHead: string;
  /** Exit code of `node verify-frozen-engine.cjs` run locally at pack time. */
  verifyFrozenEngineExit: number;
}

export interface ShardTimings {
  bootstrapMs?: number;
  cloneMs?: number;
  analyzeMs?: number;
  totalMs?: number;
}

export interface ShardState {
  id: string;
  runId: string;
  repo: string;
  shardIndex: number;
  shardCount: number;
  mergeCount: number;
  status: ShardStatus;
  rowsCompleted: number;
  lastError?: string;
  /** Epoch ms of the last heartbeat - the watchdog marks a shard failed when this goes stale. */
  heartbeatAt: number;
  peakMemMb?: number;
  memAvailableBeforeMb?: number;
  memAvailableAfterMb?: number;
  diskFreeBytes?: number;
  timings: ShardTimings;
}

export type RunStatus = "running" | "completed" | "failed" | "cancelled";

/** Live-shape probe captured from a real container before any result is trusted. */
export interface ShardProbe {
  nproc?: number;
  memAvailableMb?: number;
  diskFreeBytes?: number;
  raw?: string;
}

export interface RunState {
  runId: string;
  createdAt: number;
  status: RunStatus;
  shape: string;
  shardsPerRepository: number;
  maxConcurrentShards: number;
  repositories: RepositorySpec[];
  engineChecksum: string;
  tarballKey: string;
  tarballSha256: string;
  shards: ShardState[];
}

/**
 * The full state the AnalysisShard Durable Object persists in its own storage. Persisting `step`,
 * `processId`, `flushedLines` and `rows` is what makes the state machine resumable across an eviction:
 * an alarm that fires twice, or a restored DO, resumes from exactly where it left off without
 * re-cloning, re-extracting, or duplicating rows.
 */
export interface ShardRecord {
  id: string;
  runId: string;
  repo: string;
  manifestKey: string;
  tarballKey: string;
  /** SHA-256 of the tarball the Worker already verified - re-checked in-container after transfer. */
  tarballSha256: string;
  frozenManifestKey: string;
  slice: ShardSlice;
  shardIndex: number;
  shardCount: number;
  mergeCount: number;
  step: ShardStep;
  /** Stable container DO name the Sandbox is addressed by. */
  sandboxId: string;
  /** Set once the replay driver is started; lets a resumed shard poll instead of restarting. */
  processId?: string;
  /** Exit code of the (already terminated) replay process, captured once it reaches a terminal state. */
  exitCode?: number;
  /** Number of lines already ingested from the container's rows.jsonl. */
  flushedLines: number;
  /** Every row produced so far (raw JSON strings), so a resume never loses or duplicates a row. */
  rows: string[];
  memBeforeMb?: number;
  memAfterMb?: number;
  diskBeforeBytes?: number;
  peakMemMb?: number;
  timings: ShardTimings;
  lastError?: string;
  /** e.g. "engine-drift" or "tarball-corrupt" - a fatal shard-level failure class. */
  errorClass?: string;
  startedAt: number;
  heartbeatAt: number;
  probe?: ShardProbe;
}