# DiffCI x deepseek-harness — three-way comparison on the identical 30 merges (2026-08-23)

Same 30 PR-merge SHAs as both earlier records (short-SHA list checksum `4adba3b4d3036fbbd76b712d2762b34b`
verified against `...-benchmark-results.jsonl` and `...-replay-companions.jsonl` before each run).
Static analysis only in this document: no deepseek test was executed here. Raw per-merge output:

- baseline: `2026-08-23-deepseek-harness-benchmark-results.jsonl` (unchanged)
- companion-only: `2026-08-23-deepseek-harness-benchmark-replay-companions.jsonl` (unchanged)
- correctness-complete, pre graph fix (Phases 1-3 only): `...-replay-complete-pre-graph-fix.jsonl`
- correctness-complete, final (Phases 1-3 + Phase 5 graph fix): `...-replay-complete.jsonl`

## Headline

Under the correctness-complete policy, DiffCI authorized selective execution on **15 of the same 30
historical merges** (baseline 2, companion-only 10). Of the +5, all five are the merges previously
blocked ONLY by graph confidence, cleared by one general resolver fix (bundler `?query` import
suffixes, Phase 5). Phases 1-3 (production wiring, test discovery, fixture ownership) changed NO
verdict on their own (10 -> 10); they changed the modeled test universe and the affected sets.

| Metric | Original baseline | Companion-only | Correctness-complete (pre graph fix) | Correctness-complete (final) |
|---|---:|---:|---:|---:|
| Recognized tests (median per merge) | 864 | 864 | 1,023 | **1,023** |
| — by family at HEAD b150a551 | 872 unit | 872 unit | 875 unit · 136 e2e · 22 snapshot · 1 stress | same |
| `SAFE_TO_PROPOSE` | 2 | 10 | 10 | **15** |
| `FALLBACK` | 28 | 20 | 20 | **15** |
| Unknown-file merges | 26 | 6 | 5 | 5 |
| Unknown-file instances | 943 | 168 | 10 | 10 |
| Median selected % (authorized merges) | 0.7 (n=2) | 1.6 (n=10) | 1.4 (n=10) | 1.4 (n=15) |
| Median analysis wall time | 37 s | 25 s (warm cache) | 29 s | 57 s† |
| Impact step median | 46 ms | 39 ms | 265 ms | 645 ms‡ |
| Config triggers | 12 | 12 | 12 | 12 |
| Lockfile triggers | 5 | 5 | 5 | 5 |
| Workflow triggers | 5 | 5 | 5 | 5 |
| Manifest triggers | 1 | 1 | 1 | 1 |
| Graph-UNSAFE triggers | 8 | 8 | 8 | **0** |

† The final replay overlapped with DiffCI's own test suite and graph tests for part of its run and one
merge (#2768) stalled at 1,662 s in `git checkout`/graph build (result unaffected); treat 57 s as an
upper bound, 25-37 s as the representative figure. ‡ Impact-step growth is the fixture-ownership
lookup (per changed path x HEAD inventory of ~9k paths) - still sub-second, but worth indexing later.

## Every changed verdict / affected set, explained (final vs companion-only)

Verdict changes (all FALLBACK -> SAFE): #2814 59/1023, #2749 62/1016, #2820 3/1016, #2794 5/1015,
#2796 59/1015. Cause: identical in all five - the only unresolved imports reachable from the delta were
five `../styles/*.css?inline` imports in `packages/client/ui-theme/src/client/styles.ts`. After
`stripImportQuery()` (src/repo/graph.ts) they resolve to the real CSS assets; graph confidence for
these deltas becomes PARTIAL (project-references cap), unresolved = 0. Affected sets unchanged.
The same fix also removed the graph-UNSAFE trigger from #2903, #2856, #2608 - they stay FALLBACK on
config/lockfile, as they should.

Affected-set growth with unchanged verdict - two mechanisms:
1. Wider universe (Phase 2): snapshot/e2e suites that import changed sources now count.
   #2844 173 -> 254 (+71 e2e, +9 snapshot, +1 stress); #2725 206 -> 288; #2730 309 -> 352;
   #2776 142 -> 150; #2509 289 -> 324; #2726 7 -> 21; #1798 4 -> 12.
2. Fixture ownership (Phase 3): `tests/<snapshots|fixtures>/**` changes now select owners instead of
   being unknown. #2702: 153 fixture files -> 21 owning tests, unknown 157 -> 4, affected 4 -> 100
   (the remaining 4 unknowns - `scripts/snapshots/.../*.jsonl` x3 with no tests dir, and
   `scripts/smoke-python-runtime.py` - keep it FALLBACK, correctly). #2676: 3 fixtures -> 6 tests,
   unknown 4 -> 1; #2903 and #2608: 1 fixture -> 6 tests.

Residual unknown files (10, across 5 merges), all legitimately outside the rules: two `.i18n.yaml`
DELETED together with their `.md` (companion gone at HEAD -> conservative), three `.jsonl` under
`scripts/snapshots/` (no tests-dir ancestor), three `*.cordis.yml` example configs, one `.py`, one `.sh`.

## Hypothesis discipline

The "~10/30" figure from the companion replay was not a target; Phases 1-3 reproduced exactly 10/30
with a larger universe, and the 15/30 came from a resolver defect that was diagnosed first
(`scripts/diffci-graph-unsafe-probe.ts`) and fixed generally, with tests, not from any policy change.
