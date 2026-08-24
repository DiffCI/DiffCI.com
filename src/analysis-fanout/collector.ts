/**
 * Collector ordering for the analysis fan-out (2026-08-23).
 *
 * Each shard writes one immutable JSONL object (`runs/<runId>/<repo>/shard-<n>.jsonl`). The collector
 * concatenates those objects into a single JSONL stream ordered by manifest index. Rows are never
 * merged, deduplicated, or re-interpreted - the only "smarts" allowed is a stable sort by the
 * immutable parent manifest's merge index.
 *
 * The frozen driver does not write an `index` field into each row, so ordering is recovered by mapping
 * the row's `mergeSha` back to the immutable parent manifest's 1-based `index`.
 */
import type { SelectionManifest } from "./fanout-types.js";

export type Row = Record<string, unknown>;

/** mergeSha -> 1-based parent manifest index. */
export function buildIndexLookup(manifest: SelectionManifest): Map<string, number> {
  const map = new Map<string, number>();
  for (const m of manifest.merges) map.set(m.mergeSha, m.index);
  return map;
}

export function parseRows(text: string): Row[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Row);
}

/** Stable sort by manifest index. Unknown mergeShas sort last but are NEVER dropped. */
export function orderRowsByIndex(rows: Row[], indexByMergeSha: Map<string, number>): Row[] {
  const withOrder = rows.map((row, i) => {
    const sha = typeof row.mergeSha === "string" ? row.mergeSha : undefined;
    const index = sha !== undefined ? indexByMergeSha.get(sha) : undefined;
    return { row, index: index ?? Number.POSITIVE_INFINITY, original: i };
  });
  withOrder.sort((a, b) => a.index - b.index || a.original - b.original);
  return withOrder.map((x) => x.row);
}

/** Concatenate shard objects (already concatenated JSONL) and order globally. */
export function concatenateShards(shardRows: Row[][], indexByMergeSha: Map<string, number>): Row[] {
  return orderRowsByIndex(shardRows.flat(), indexByMergeSha);
}