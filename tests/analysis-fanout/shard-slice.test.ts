import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  assertExactCoverage,
  buildShardSlices,
  computeMergeListSha256,
  sliceManifest,
} from "../../src/analysis-fanout/shard-slice.js";
import type { MergeRow, SelectionManifest } from "../../src/analysis-fanout/fanout-types.js";

function hex40(seed: string, index: number): string {
  return createHash("sha256").update(`${seed}:${index}`).digest("hex").slice(0, 40);
}

function makeMerge(index: number): MergeRow {
  return {
    index,
    prNumber: index,
    mergeSha: hex40("merge", index),
    baseSha: hex40("base", index),
    mergeTimestamp: "2026-08-23T00:00:00Z",
    subject: `merge ${index}`,
    changedFiles: index,
  };
}

function makeManifest(mergeCount: number): SelectionManifest {
  const merges = Array.from({ length: mergeCount }, (_, i) => makeMerge(i + 1));
  return {
    repository: "test/repo",
    merges,
    mergeListSha256: computeMergeListSha256(merges),
    defaultBranch: "main",
  };
}

/** Independent recomputation of the driver's merge-list checksum formula. */
function independentSha256(merges: MergeRow[]): string {
  return createHash("sha256")
    .update(merges.map((m) => `${m.baseSha}..${m.mergeSha}`).join("\n"))
    .digest("hex");
}

describe("buildShardSlices / assertExactCoverage", () => {
  const pairs: [number, number][] = [
    [1, 1],
    [1, 4],
    [4, 1],
    [4, 4],
    [8, 3],
    [3, 8],
    [30, 8],
    [30, 16],
    [7, 16],
    [5, 100],
  ];

  for (const [mergeCount, shardCount] of pairs) {
    it(`covers every index exactly once (${mergeCount} merges, ${shardCount} shards)`, () => {
      const manifest = makeManifest(mergeCount);
      const slices = buildShardSlices(manifest, shardCount);
      assert.equal(slices.length, shardCount);
      const ordered = assertExactCoverage(manifest, shardCount);
      assert.deepEqual(ordered, manifest.merges.map((m) => m.index));
    });
  }

  it("each slice's mergeListSha256 matches an independent recomputation", () => {
    const manifest = makeManifest(30);
    for (const slice of buildShardSlices(manifest, 8)) {
      assert.equal(slice.mergeListSha256, independentSha256(slice.merges));
    }
  });

  it("each slice's parentManifestSha256 equals the parent's mergeListSha256", () => {
    const manifest = makeManifest(30);
    for (const slice of buildShardSlices(manifest, 8)) {
      assert.equal(slice.parentManifestSha256, manifest.mergeListSha256);
    }
  });

  it("sliceManifest preserves the original 1-based index and shard metadata", () => {
    const manifest = makeManifest(8);
    const slice = sliceManifest(manifest, 1, 4);
    // shard 1 of 4 owns 0-based positions 1 and 5 -> original indices 2 and 6.
    assert.deepEqual(slice.merges.map((m) => m.index), [2, 6]);
    assert.equal(slice.shardIndex, 1);
    assert.equal(slice.shardCount, 4);
    assert.equal(slice.parentManifestSha256, manifest.mergeListSha256);
  });

  it("sliceManifest throws on invalid shardCount / shardIndex", () => {
    const manifest = makeManifest(4);
    assert.throws(() => sliceManifest(manifest, 0, 0), /shardCount/);
    assert.throws(() => sliceManifest(manifest, 5, 4), /shardIndex/);
    assert.throws(() => sliceManifest(manifest, -1, 2), /shardIndex/);
  });
});