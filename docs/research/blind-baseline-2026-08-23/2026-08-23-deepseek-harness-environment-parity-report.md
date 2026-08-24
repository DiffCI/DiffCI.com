# DiffCI analysis fan-out — deepseek-harness environment-parity gate (2026-08-23)

**Result: PASS. 30/30 rows match.** The Cloudflare `diffci-analysis-fanout` Worker, running the frozen
DiffCI build inside `standard-2` Sandbox containers, reproduces the local benchmark's verdicts and
selected-test counts exactly on all 30 deepseek-ai/deepseek-harness merges. The container environment
does not change the frozen engine's behavior.

## Setup

- Worker: `diffci-analysis-fanout` at `https://diffci-analysis-fanout.damp-waterfall-0cd8.workers.dev`
  (deployed this session, version `fe868fcc`).
- Run `deepseek-parity-1`: 30-merge manifest (`2026-08-23-deepseek-blind-baseline-selection-manifest.json`,
  `mergeListSha256` `a5bd1c195389a057...`), 4 shards (8/8/7/7 merges), `maxConcurrentShards: 4`, shape
  `standard-2` (Worker-reported).
- Pack record `engineChecksum` `e0f20b722d880d59...` matches the frozen build manifest
  (`node docs/research/blind-baseline-2026-08-23/verify-frozen-engine.cjs` → MATCH, both before and
  after this run).
- All 4 shards reached `done` with zero errors, zero resource kills, zero timeouts.

## Comparison

Reference: `docs/research/2026-08-23-deepseek-harness-benchmark-replay-complete.jsonl` (the local
correctness-complete replay, 30 rows). Compared field-by-field per merge: `analysisStatus`,
`affectedTests`, `totalTestsInGraph`. Raw fan-out output preserved unmodified at
`2026-08-23-deepseek-harness-environment-parity-rows.jsonl`.

| | |
|---|---|
| Rows compared | 30 / 30 |
| Matches | **30** |
| Mismatches | **0** |
| PR set difference | none (identical 30 PR numbers both sides) |

## Timing (container, standard-2, cold clone every shard)

| | median |
|---|---|
| Total wall time per merge | 12.7 s |
| Graph-build time per merge | 11.7 s |
| Impact-analysis step | 272 ms |

(Not directly comparable to the local run's per-merge timings — the container ran 4 shards concurrently
against a freshly-cloned tree with no OS filesystem cache; the local run analyzed sequentially against
an already-warm clone. This is noted, not treated as an efficiency finding.)

## Harness-only fixes made to reach this result

Three bugs in `scripts/diffci-analysis-fanout-cli.ts` were found and fixed while getting the smoke test
to run (documented in that file's inline comments; the file is outside the checksummed `engineFiles`
set, and `verify-frozen-engine.cjs` was re-confirmed MATCH after each fix):

1. GNU tar on this Windows box misread an absolute `C:\...` output path as a remote `host:file` spec →
   added `--force-local`.
2. `wrangler r2 object put` without `--remote` silently writes to wrangler's local dev-mode R2
   simulator, not the real bucket the deployed Worker reads — confirmed by writing an object without
   the flag and finding it absent from the remote bucket immediately after. Added `--remote`.
3. `spawnSync("npx", ...)` failed to spawn at all on this machine, and `spawnSync("npx.cmd", ...)`
   failed with `EINVAL` (Node cannot exec a `.cmd` batch file without a shell), while `shell: true`
   broke argv quoting on this repo's own path (it contains a space). Fixed by invoking wrangler's own
   `bin/wrangler.js` directly via `process.execPath`.

None of these touch analysis, classification, graph construction, or test discovery.

## Conclusion

The parity gate passes. Per the task's rules, the four holdout repositories (turborepo, biome, cal.com,
nx) may now be run through the same fan-out.
