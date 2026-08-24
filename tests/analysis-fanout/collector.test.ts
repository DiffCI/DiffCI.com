import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIndexLookup,
  concatenateShards,
  orderRowsByIndex,
  parseRows,
  type Row,
} from "../../src/analysis-fanout/collector.js";
import type { MergeRow, SelectionManifest } from "../../src/analysis-fanout/fanout-types.js";

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

function manifest(merges: MergeRow[]): SelectionManifest {
  return { repository: "test/repo", merges, mergeListSha256: "s".repeat(64) };
}

function rowFor(m: MergeRow, tag = "x"): Row {
  return { mergeSha: m.mergeSha, ok: true, tag };
}

describe("collector", () => {
  it("buildIndexLookup maps mergeSha -> 1-based index", () => {
    const merges = [merge(1), merge(2), merge(3)];
    const lookup = buildIndexLookup(manifest(merges));
    assert.equal(lookup.get(merges[0]!.mergeSha), 1);
    assert.equal(lookup.get(merges[2]!.mergeSha), 3);
    assert.equal(lookup.get("nope"), undefined);
  });

  it("parseRows splits JSONL and ignores blank lines", () => {
    const rows = parseRows('{"a":1}\n\n{"a":2}\r\n');
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], { a: 1 });
    assert.deepEqual(rows[1], { a: 2 });
  });

  it("orders rows strictly by manifest index, never by shard or arrival order", () => {
    const merges = [1, 2, 3, 4, 5, 6].map(merge);
    const lookup = buildIndexLookup(manifest(merges));
    // shard A rows arrive out of manifest order; shard B interleaves after them.
    const shardA = [rowFor(merges[2]!, "A"), rowFor(merges[0]!, "A"), rowFor(merges[4]!, "A")]; // indices 3,1,5
    const shardB = [rowFor(merges[1]!, "B"), rowFor(merges[5]!, "B"), rowFor(merges[3]!, "B")]; // 2,6,4
    const ordered = concatenateShards([shardA, shardB], lookup);
    assert.deepEqual(
      ordered.map((r) => r.mergeSha),
      merges.map((m) => m.mergeSha),
    );
    assert.deepEqual(
      ordered.map((r) => r.tag),
      ["A", "B", "A", "B", "A", "B"], // strictly by index 1..6, stable within a shared index
    );
  });

  it("does not silently collapse duplicate mergeSha across shards", () => {
    const merges = [merge(1), merge(2)];
    const lookup = buildIndexLookup(manifest(merges));
    const a = rowFor(merges[0]!, "shardA");
    const b = rowFor(merges[0]!, "shardB"); // duplicate mergeSha from a second shard
    const ordered = concatenateShards([[a], [b]], lookup);
    // Both rows survive (the collector never silently picks one); stable order preserves arrival.
    assert.equal(ordered.length, 2);
    assert.deepEqual(ordered, [a, b]);
  });

  it("orderRowsByIndex sorts unknown mergeShas last without dropping them", () => {
    const merges = [merge(1), merge(2)];
    const lookup = buildIndexLookup(manifest(merges));
    const known = rowFor(merges[1]!);
    const unknown = { mergeSha: "z".repeat(40), ok: false, tag: "unknown" };
    const ordered = orderRowsByIndex([unknown, known], lookup);
    assert.deepEqual(ordered, [known, unknown]);
  });
});