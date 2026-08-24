# DiffCI ADAPTED REPLAY — deepseek-ai/deepseek-harness (2026-08-24)

**This is an adapted replay, not a blind baseline.** The engine was intentionally modified after the
2026-08-24 cross-repository aggregate report to fix two findings from that report:

1. `src/repo/impact.ts` - a directly-modified test file now selects itself (`processTestChange` /
   `DIRECT_TEST_CHANGE`), fixing the silent-zero-selection bug found on nx PR #36723 and reproduced here.
2. `src/repo/graph.ts` - `createProgram()` no longer throws when no root `tsconfig.json` exists; it now
   discovers nested per-package tsconfigs (or falls back to conservative `UNSAFE`), fixing the total
   failures on biomejs/biome and calcom/cal.diy.

Adapted build manifest: `2026-08-24-diffci-adapted-build-manifest.json`, `engineChecksum`
`c6cf10e6b047a19527ba04c5da20019eba7ffeef4b28d6f795591f88fe15bd76`, typecheck clean, 985/985 local
tests. **The original blind-baseline frozen manifest and all original raw result files remain
permanently unmodified** - this run's outputs are saved under new, distinctly-named files and were
never merged into or used to overwrite any `*-blind-baseline-*` file.

Run on `diffci-analysis-fanout` (same deployed Worker), `standard-4`, 6 shards / 6 concurrent, same 30
deepseek-harness merges as the original correctness-complete replay
(`docs/research/2026-08-23-deepseek-harness-benchmark-replay-complete.jsonl`). All 6 shards `done`,
zero errors. Raw rows: `2026-08-24-deepseek-harness-adapted-replay-rows.jsonl`.

## Result: fix behaves exactly as intended

| | |
|---|---|
| Merges compared | 30 / 30 |
| Unchanged (identical verdict + selection) | 13 |
| Changed (more tests selected) | 17 |
| **Decreases in selected tests** | **0** |
| **Verdict flips (SAFE<->FALLBACK)** | **0** |

Every one of the 17 changed rows shows a **small, strictly positive** increase in `affectedTests` (+1
to +3), with `totalTestsInGraph` unchanged (same graph, same test universe - only the selection
changed) and the same `analysisStatus` as before. This is exactly the expected signature of the
test-self-selection fix: previously-missed directly-changed test files (leaf test files with no
dependents, which were silently dropped) are now correctly included. No merge lost coverage, no SAFE
verdict became FALLBACK or vice versa (the fix only ADDS tests to the selected set, and deepseek-harness
has a root `tsconfig.json` so the second fix - nested-tsconfig discovery - was not exercised here).

## Sample

| PR | Before | After |
|---|---|---|
| #2760 | SAFE_TO_PROPOSE, 0/1024 | SAFE_TO_PROPOSE, **1**/1024 |
| #2708 | SAFE_TO_PROPOSE, 14/1023 | SAFE_TO_PROPOSE, **15**/1023 |
| #2890 | FALLBACK, 0/1024 | FALLBACK, **1**/1024 |
| #2903 | FALLBACK, 227/1024 | FALLBACK, **230**/1024 |

Full list of the 17 changed rows in the raw JSONL and the driver's diff output; all follow this pattern.

## Conclusion

The test-self-selection fix is verified working correctly against real historical data: strictly
conservative (only adds selections, never removes), zero regressions, zero verdict flips. Proceeding to
re-run the four holdout repositories (turborepo, biome, cal.com, nx) under the same adapted engine.
