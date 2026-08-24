# DiffCI ADAPTED REPLAY — nrwl/nx (2026-08-24)

Adapted engine (`engineChecksum` `c6cf10e6b047a19527ba04c5da20019eba7ffeef4b28d6f795591f88fe15bd76`),
same 30 merges as the original blind baseline. Run on `diffci-analysis-fanout`, `standard-4`, 6/6
shards, all `done`, zero errors. Raw rows: `2026-08-24-nx-adapted-replay-rows.jsonl`. Original blind
baseline (`2026-08-23-nx-blind-baseline-rows.jsonl`, `.../2026-08-24-nx-blind-baseline-report.md`)
unmodified. nx has a root `tsconfig.json`, so the nested-tsconfig fix was not exercised here (as
before) - this run isolates the test-self-selection fix specifically, on the exact repository that
found it.

## Headline: the bug that motivated this fix is confirmed fixed, on the exact case that found it

**PR #36723** ("cleanup(angular): bump e2e es2015 bundle size threshold...", the single-file, test-only
change that originally exposed the bug) went from:

| | Before | After |
|---|---|---|
| Verdict | SAFE_TO_PROPOSE | SAFE_TO_PROPOSE |
| Selected | **0** / 502 | **1** / 502 |

The changed test file now correctly selects itself. Across all 30 merges: **zero verdict flips, zero
decreases** - the fix is strictly additive, exactly as designed and as already confirmed on
deepseek-harness and turborepo.

## Standard comparison

| | Blind baseline | Adapted replay |
|---|---|---|
| `SAFE_TO_PROPOSE` | 7 | 7 (same set) |
| `FALLBACK` | 23 | 23 |
| Unchanged rows | - | 21 / 30 |
| Changed rows (all small increases) | - | 9 / 30 |

9 merges changed, all small positive increases (+1 to +56 - PR #35089's config/manifest/lockfile-
blocked merge went 60->116/505, the largest jump, still FALLBACK either way since other triggers
already applied). Sample: #36636 0->1/502, #36724 0->2/502, #36711 0->1/502 - all previously-silent
test-only or test+source changes now correctly self-select.

## The remaining 3 zero-selected "SAFE" merges are legitimate, not a residual bug

#36752, #36750, #36748 still show `SAFE_TO_PROPOSE` with 0 tests selected. Checked directly: all three
touched **only `asset`-category files** (repo tooling/skill configuration, zero test or source files in
the diff) - `changedFileCategories: {"asset": N}` on each. Zero selected tests is the CORRECT answer for
a diff containing no test or source file; this is not the bug the fix addressed and is not flagged as a
new finding.

## Incidental positive refinement

A new, more precise fallback reason appeared: `"Deleted test <path>; legacy coverage/dependents cannot
be established safely"` - the new `processTestChange()` path now classifies a **deleted test file**
distinctly from a generic deleted source/asset, which is more informative provenance than before (same
conservative FALLBACK outcome, better labeled).

## Test-universe completeness: still INCOMPLETE (unchanged from the blind baseline)

Only the `unit` Jest family (502-505 tests) is modeled; nx's E2E suite and its own executor/project-
graph test model remain outside DiffCI's current discovery, exactly as reported in the original nx
blind-baseline report. Neither engine fix touched test-family discovery.

## Conclusion

This is direct confirmation, on the repository and exact merge that discovered it, that the highest-
priority engine bug from the cross-repository aggregate is fixed correctly: strictly conservative,
zero regressions, the specific false-negative case resolved.
