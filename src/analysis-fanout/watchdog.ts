/**
 * Watchdog helpers for the analysis fan-out (2026-08-23).
 *
 * Each shard heartbeats the AnalysisRun Durable Object while it is doing real work. If a container
 * vanishes mid-merge (eviction, OOM of the container itself, network partition), the watchdog marks the
 * shard `failed` so a run can never hang in `running` forever. These pure helpers keep the DO's alarm
 * handler trivial to reason about.
 */
import type { ShardState, ShardStatus } from "./fanout-types.js";

export const ACTIVE_STATUSES: ReadonlySet<ShardStatus> = new Set<ShardStatus>([
  "bootstrapping",
  "cloning",
  "analyzing",
  "finalizing",
]);

/** How long a shard may go without a heartbeat before the watchdog declares it dead. */
export const DEFAULT_MAX_AGE_MS = 35 * 60 * 1000;

export function isActive(status: ShardStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

export function findStaleShards(shards: ShardState[], now: number, maxAgeMs: number = DEFAULT_MAX_AGE_MS): ShardState[] {
  return shards.filter((s) => isActive(s.status) && now - s.heartbeatAt > maxAgeMs);
}

/**
 * Next alarm time so the DO wakes up the moment the earliest-stale active shard crosses the threshold
 * (bounded to `now + maxAgeMs`). Returns null when there is nothing active left to watch.
 */
export function computeNextAlarmAt(shards: ShardState[], now: number, maxAgeMs: number = DEFAULT_MAX_AGE_MS): number | null {
  const active = shards.filter((s) => isActive(s.status));
  if (active.length === 0) return null;
  const earliestStaleAt = Math.min(...active.map((s) => s.heartbeatAt + maxAgeMs));
  return Math.max(now + 1000, Math.min(now + maxAgeMs, earliestStaleAt));
}