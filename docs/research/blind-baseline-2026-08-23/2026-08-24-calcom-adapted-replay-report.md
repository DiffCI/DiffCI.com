# DiffCI ADAPTED REPLAY — calcom/cal.diy (2026-08-24)

Adapted engine (`engineChecksum` `c6cf10e6b047a19527ba04c5da20019eba7ffeef4b28d6f795591f88fe15bd76`),
same 30 merges as the original blind baseline. Run on `diffci-analysis-fanout`, `standard-4`, 6/6
shards, all `done`, zero errors. Raw rows: `2026-08-24-calcom-adapted-replay-rows.jsonl`. Original blind
baseline (`2026-08-23-calcom-blind-baseline-rows.jsonl`, `.../2026-08-24-calcom-blind-baseline-report.md`)
unmodified.

## Headline: both original findings fully resolved for this repository

| | Blind baseline (original engine) | Adapted replay (fixed engine) |
|---|---|---|
| `ok: true` | **0 / 30** (25 tsconfig crash, 5 git-lock checkout failure) | **30 / 30** |
| `SAFE_TO_PROPOSE` | n/a | **29 / 30** |
| `totalTestsInGraph` | n/a | **~250, real unit-test family found** |
| Checkout failures | 5 | **0** |

Unlike biome, **cal.com's fix is complete for the unit-test surface**: `discoverSourceRoots()` found
`apps/` at the repository root (a conventional name it already recognizes - cal.com's Next.js/Turbo
layout happens to match), so the nested per-package `tsconfig.json` discovery (`graph.ts`) combined with
an already-working source-root list produced a real, non-vacuous 250-test unit universe and genuine
per-merge selections (median 0.8%, range 1-5 of 250). The `recoverStaleGitLock()` harness fix also
worked as intended: zero checkout failures this run, versus 5/30 originally.

This is the single largest change in the whole exercise: **0 usable verdicts to 29 authorized
selections**, on a large (18 MB TypeScript), real, actively-developed monorepo.

## Standard results

| Metric | Value |
|---|---|
| `SAFE_TO_PROPOSE` | 29 |
| `FALLBACK` | 1 (#config+lockfile trigger - legitimate) |
| Median recognized tests | 250 (unit family only) |
| Median selected % (SAFE merges) | 0.8% |
| Median graph-build / total wall | 7.1 s / 8.2 s |

## Test-universe completeness: still INCOMPLETE - do not overclaim

`totalTestsByFamily: {"unit": 250}` on every row - **only the Vitest unit-test family was found**,
exactly as before the fix (same limitation as every other repository in this portfolio). cal.com's real
CI surface, per the Phase 1 workflow inventory, includes separate E2E (Playwright), API integration,
and database-dependent jobs across dozens of `.github/workflows/*.yml` files - none of that is modeled.
**The crash is fixed and the unit slice is now genuinely visible and selectable; the rest of cal.com's
test surface remains exactly as unassessed as it was before.** A `SAFE_TO_PROPOSE` verdict here means
"safe within the ~250 modeled unit tests," not "safe to skip cal.com's full CI."

## Conclusion

The clearest positive validation of both engine fixes in this whole exercise. Recommended: this
repository (specifically its unit-test surface) is now the strongest candidate in the portfolio for a
next-step execution-level validation (real full-vs-selected `vitest run` timing and failure-agreement
check), once E2E/integration test-family discovery is separately addressed or explicitly scoped out.
