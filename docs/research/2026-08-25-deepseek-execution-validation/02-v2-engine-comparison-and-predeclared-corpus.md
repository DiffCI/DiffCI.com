# Report 02 — v2-engine canonical replay comparison, and the predeclared 5-merge execution corpus

## 1. v1-adapted vs. v2 comparison (30/30 rows)

Full field-by-field comparison of `analysisStatus`, `affectedTests`, `totalTestsInGraph` between the existing v1-adapted rows (`2026-08-24-deepseek-harness-adapted-replay-rows.jsonl`, engine `c6cf10e6...`) and the fresh canonical v2 replay (`2026-08-25-deepseek-v2-engine-canonical-replay-rows.jsonl`, engine `f6fd3ec...`, this mission):

| | |
|---|---|
| Rows compared | 30 / 30 |
| `analysisStatus` changed | **0** |
| `affectedTests` changed | **0** |
| `totalTestsInGraph` changed | **30 / 30 — every row, uniformly +3** (e.g. PR #2908: 1031 → 1034; PR #2760: 1024 → 1027) |

**Confirmed, not assumed:** the v2 fix (`graph.ts` unions `profile.testFilePaths` into the graph node set) adds exactly 3 additional test files to deepseek-harness's graph on every single merge, and has **zero** effect on which merges are `SAFE_TO_PROPOSE`/`FALLBACK` or on `affectedTests` for any of them. This validates the hypothesis in Report 01 (deepseek-harness has a root `tsconfig.json`, so the exclusion this fix targets wasn't expected to bite here) empirically rather than leaving it as an assumption. **The v1-adapted rows' selection decisions were correct all along for this repository** — but the v2 rows are still used as the source of truth below, since they are the exact engine identity every execution run in this mission uses, and the ~3-test denominator shift does trivially move `affectedTests/totalTestsInGraph` percentages (never by more than 0.01 points at these scales).

## 2. Predeclared 5-merge execution corpus

Selected **before observing any execution result**, per the mission's deterministic rule, from `2026-08-25-deepseek-v2-engine-canonical-replay-rows.jsonl`:

1. **Eligible** = `analysisStatus === "SAFE_TO_PROPOSE"`, `fallbackRequired === false`, `affectedTests >= 1`, `selectedTestsByFamily.unit >= 1` (must select at least one test in the family this mission's harness can actually execute selectively — see Report 01 §1, unit-only this round). **14 / 30** merges qualify.
2. Sort ascending by `affectedTests / totalTestsInGraph` (ties broken by manifest index, lower = newer).
3. Partition the 14 eligible merges into 5 quantile buckets by rank position (`Math.floor(q·n/5)` boundaries: 0, 2, 5, 8, 11, 14 → bucket sizes 2, 3, 3, 3, 3).
4. From each bucket, pick the earliest manifest-ordered (lowest index = most recent) merge.

**Immutable artifact:** `02-predeclared-5-merge-corpus.json`, `manifestHash 3d42deea836c66281d0e8f718f09f783cafcc15351333a60a4c26ab2f95e3c9b`.

| Quantile | PR | Selection % | Selected (unit / total by family) | Total in graph | Changed files | Mutation target |
|---|---:|---:|---|---:|---:|---|
| 0 | #2760 | 0.097% | unit: 1 | 1027 | 1 (test-only) | **unavailable** — no `source`-category file changed (see §3) |
| 1 | #2808 | 0.390% | unit: 4 | 1026 | 15 (1 source, 1 test, 1 config, 4 docs, 8 asset) | available |
| 2 | #1373 | 0.585% | unit: 6 | 1026 | 134 (1 source, 1 test, 44 docs, 88 asset) | available |
| 3 | #2814 | 5.848% | unit: 59, e2e: 1 (60 total) | 1026 | 7 (1 source, 2 test, 1 docs, 3 asset) | available |
| 4 | #2844 | 24.756% | unit: 173, snapshot: 9, e2e: 71, untagged: 1 (254 total) | 1026 | 21 (3 source, 2 test, 5 docs, 11 asset) | available |

This spans four orders of magnitude in selection size (1 → 173 unit tests), matches the mission's evidence of both very small and very large (#2844 is 24.8% selected, the closest of the 14 eligible rows to the mission brief's "~770/1,031" large-selection example among `SAFE_TO_PROPOSE` rows specifically — the actual ~770/1034 row, PR #2676, is `FALLBACK` and therefore correctly excluded from the selective-execution corpus). Note #2814's base SHA equals #2844's merge SHA — these are adjacent commits in the same first-parent history, not a data error.

## 3. #2760: predeclared mutation-unavailability, stated up front

PR #2760's only changed file is categorized `test` (its subject, "fix/continuation-cleanup-temp-handles", is a leaf test-file edit — exactly the kind of change the directly-modified-test self-selection fix exists for). **No `source`-category file changed**, so Phase 3's deterministic mutation rule ("first candidate lexicographically, excluding generated/lockfile/manifest/config/snapshot/test files") has no valid target for this merge.

Per the mission's explicit rule ("if the deterministic rule produces no valid target, mark mutation validation unavailable for that merge without replacing it with a favorable hand-picked mutation"), **this is declared now, before any execution, not discovered after an inconvenient result**: PR #2760 will report `mutationValidationAvailable: false` in Phase 3/8, and is *not* swapped for a different PR. Its selective-execution and economics results (runtime-selection honoring, timing) remain fully valid and reported normally — only mutation-recall is inapplicable for this one merge.

## Next

Report 03: cheap Cloudflare argument-forwarding and structured-reporting probe (Phase 4) — whether `corepack pnpm test <reporterArgv> <files>` actually honors file filters, using PR #2808 (small, real `source` change, real mutation target) as the probe target. No live full-suite run begins before this is confirmed.
