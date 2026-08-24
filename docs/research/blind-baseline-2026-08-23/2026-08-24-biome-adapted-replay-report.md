# DiffCI ADAPTED REPLAY — biomejs/biome (2026-08-24)

Adapted engine (`engineChecksum` `c6cf10e6b047a19527ba04c5da20019eba7ffeef4b28d6f795591f88fe15bd76`),
same 30 merges as the original blind baseline. Run on `diffci-analysis-fanout`, `standard-4`, 6/6
shards, all `done`, zero errors. Raw rows: `2026-08-24-biome-adapted-replay-rows.jsonl`. Original blind
baseline (`2026-08-23-biome-blind-baseline-rows.jsonl`, `.../2026-08-24-biome-blind-baseline-report.md`)
unmodified.

## Headline: the crash is fixed. A second, distinct gap remains.

| | Blind baseline (original engine) | Adapted replay (fixed engine) |
|---|---|---|
| `ok: true` (real verdict produced) | **0 / 30** | **30 / 30** |
| Cause when not `ok` | 100% `createProgram` crash on missing root tsconfig | - |
| `totalTestsInGraph` | n/a (crashed) | **0 on every single merge** |
| `SAFE_TO_PROPOSE` | n/a | 2 (both vacuous - see below) |

The `createProgram()` fix works exactly as designed: it no longer throws, and correctly falls back to
conservative `FALLBACK`/`UNSAFE` behavior instead of crashing the whole analysis. **This is real,
verified progress** - biome went from "DiffCI cannot analyze this repository at all" to "DiffCI analyzes
every merge and produces a (currently unhelpful) conservative verdict."

**But the fix only repaired `graph.ts`'s TS-program/AST build.** `analyzeRepository()`'s separate
source-root discovery (`discoverSourceRoots()` in `src/repo/analyzer.ts`) still only tries a fixed list
of conventional directory names (`src`, `app`, `pages`, ...) **at the repository root**. Biome has none
of those at its root (its real layout is `crates/`, `packages/`, `plugins/`), so `sourceRoots` comes
back empty, `discoverTestRunnerConfigs()` finds no configs (`testRunnerConfigs: []` on every row), and
`totalTestsInGraph` is **0 on all 30 merges** - not because biome has no tests (a GitHub code search
confirms 7 real `*.test.ts` files under `packages/`), but because DiffCI currently finds none.

Both `SAFE_TO_PROPOSE` merges (#11449, #11410) have `totalTestsInGraph: 0` - a vacuous "safe," not a
meaningful one (nothing was in the universe to select from). **Category: general engine bug /
incomplete fix** - `discoverSourceRoots()` needs the same nested-discovery treatment `createProgram()`
just received, or a fallback to recursively scanning the whole repository when no conventional root
directory is found (the `discoverTests()` code path already supports a whole-repo fallback in principle
- `sources = roots.length > 0 ? ... : [repoPath]` - so the empty result here needs further
investigation, not assumed to be the same root cause without checking).

## Standard results

| Metric | Value |
|---|---|
| `SAFE_TO_PROPOSE` | 2 (vacuous, see above) |
| `FALLBACK` | 28 |
| Fallback reasons | Unknown changed file 27 (still overwhelmingly Rust `.rs`/`.vue`/`.snap` - unaffected by either fix, expected), config 2, lockfile 1, workflow 1 |
| Median graph-build / total wall | 2.8 s / 4.0 s |

## Conclusion

Real, verified progress (crash eliminated) but **not a complete fix** - flagged precisely rather than
overstated. Recommended next step: extend nested-config discovery to `discoverSourceRoots()`/test
discovery, not just the TS program builder, before re-testing biome again.
