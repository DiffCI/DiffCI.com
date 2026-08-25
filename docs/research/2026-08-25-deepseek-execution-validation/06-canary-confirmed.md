# Report 06 — canary confirmed (PR #2808, `deepseek-2808-canary2`)

Raw record: `raw-deepseek-2808-canary2-final-record.json`. Superseding run of `deepseek-2808-canary1` (Report 05) after fixing the manifest-pathspec bug that off-targeted the first attempt's mutation.

## Every Phase 6 canary requirement met

| Requirement | Result |
|---|---|
| Install works | `installMs: 22,736` |
| Selection honored | `runtimeSelection.status: "HONORED_EXACTLY"` - 4/4 files, 16/16 tests |
| Reporter complete | Full structured JSON on every step, no console-scraping |
| Timeout protection | Longest step (`full-baseline`/`full-mutant`, ~481s) well under the 15-minute `maxTestRunMs` cap; never triggered |
| Full baseline completes | 864 files, 14,426 tests, 16 pre-existing failures (unrelated flaky/environmental tests present in both runs - a real repository baseline, not this harness's doing) |
| Selected baseline completes | 4 files, 16 tests, 0 failures |
| Mutation evidence attributable | **Yes, exactly** - see below |

## Mutation and recall: exact, clean attribution

`mutation.path: "packages/host/frontend-static/src/index.ts"` - the file Report 03 predeclared, now correctly targeted.

- **Full mutant**: 17 failures = the same 16 pre-existing failures also present in the unmutated full baseline, **plus exactly one new failure**: `frontend-static/tests/frontend-static.spec.ts :: real Loader composition serves explicit index entries and files while preserving HTTP error semantics`.
- **Selected mutant**: 1 failure - **the identical test**.
- `recall: { fullSuiteCaughtMutant: true, selectedSuiteCaughtMutant: true, recallMeasurable: true }`.

This is a direct, sensible match to the PR's own subject ("frontend-static-miss-404") and to the file DiffCI's own selected tests target. Unlike `canary1`'s off-target `package.json` mutation (Report 05), nothing here touches unrelated packages.

## Economics

```
fullTestMs:        480,942
selectedTestMs:      20,037
analysisOverheadMs:  11,886
grossSavedMs:       460,905
netSavedMs:         449,019
reductionPct:            93.4%
```

Consistent with `canary1`'s baseline timings (both full-suite runs landed within ~4% of each other, 461,989ms vs 480,942ms - normal container-scheduling variance, not a regression from the fix).

## Disposition

PR #2808's official result for this mission is **`canary2`**, not `canary1`. `canary1` remains preserved (Report 05) as evidence of the harness bug it exposed, explicitly excluded from PR #2808's recall figure.

## Proceeding to the batch

All three of Phase 6's harness-fix gates (container-id length, docs/i18n pathspec, manifest pathspec) are now closed and deployed. The remaining 4 predeclared merges (#1373, #2814, #2844, #2760) are pre-packed and launching now.
