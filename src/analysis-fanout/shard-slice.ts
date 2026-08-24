/**
 * Deterministic shard slicing for the analysis fan-out (2026-08-23).
 *
 * Shard k of N owns merges k, k+N, k+2N, ... (0-based array positions). This makes a re-run shard
 * identically, and guarantees the N shards cover every merge index exactly once with no overlap. The
 * slice keeps the parent manifest's merge-list checksum in `parentManifestSha256` (for provenance) and
 * recomputes its own `mergeListSha256` exactly as the frozen driver validates it:
 * `sha256(merges.map(m => baseSha + ".." + mergeSha).join("\n"))`.
 *
 * The frozen engine is never modified here - slicing only chooses WHICH merges a container runs, and
 * writes a manifest the unmodified `scripts/diffci-blind-baseline.ts replay` driver accepts verbatim.
 */
import { createHash } from "node:crypto";
import type { MergeRow, SelectionManifest, ShardSlice } from "./fanout-types.js";

/** The exact checksum the frozen driver computes and validates against `manifest.mergeListSha256`. */
export function computeMergeListSha256(merges: MergeRow[]): string {
  return createHash("sha256")
    .update(merges.map((m) => `${m.baseSha}..${m.mergeSha}`).join("\n"))
    .digest("hex");
}

export function sliceManifest(manifest: SelectionManifest, shardIndex: number, shardCount: number): ShardSlice {
  if (!Number.isInteger(shardCount) || shardCount < 1) {
    throw new Error(`shardCount must be a positive integer, got ${shardCount}`);
  }
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error(`shardIndex ${shardIndex} out of range for shardCount ${shardCount}`);
  }
  // Original 1-based `index` is preserved on each merge (NOT renumbered) so a collector can order
  // rows globally against the immutable parent manifest.
  const merges = manifest.merges.filter((_, i) => i % shardCount === shardIndex);
  const repository = manifest.resolvedRepository ?? manifest.repository;
  return {
    repository,
    resolvedRepository: repository,
    defaultBranch: manifest.defaultBranch,
    cutoff: manifest.cutoff,
    merges,
    mergeListSha256: computeMergeListSha256(merges),
    parentManifestSha256: manifest.mergeListSha256,
    parentRepository: repository,
    shardIndex,
    shardCount,
  };
}

export function buildShardSlices(manifest: SelectionManifest, shardCount: number): ShardSlice[] {
  return Array.from({ length: shardCount }, (_, k) => sliceManifest(manifest, k, shardCount));
}

/**
 * Asserts the slicing property the tests pin down: every merge index in the parent manifest appears in
 * exactly one slice. Returns the ordered global index list (equal to the parent order) on success;
 * throws on any gap or overlap. Never silently drops or duplicates a merge.
 */
export function assertExactCoverage(manifest: SelectionManifest, shardCount: number): number[] {
  const slices = buildShardSlices(manifest, shardCount);
  const seen = new Set<number>();
  for (const slice of slices) {
    for (const m of slice.merges) {
      if (seen.has(m.index)) throw new Error(`merge index ${m.index} assigned to more than one shard`);
      seen.add(m.index);
    }
  }
  const parent = manifest.merges.map((m) => m.index);
  if (seen.size !== parent.length) throw new Error(`coverage count ${seen.size} != parent ${parent.length}`);
  for (const idx of parent) {
    if (!seen.has(idx)) throw new Error(`merge index ${idx} not assigned to any shard`);
  }
  return parent;
}