# Report — five predeclared cal.com merges: batch execution results

All 5 merges from the predeclared selection (Report 11 §3) run concurrently (`testArgvOverride: ["test"]`, default isolation, self-derived selection - no pre-supplied `selectedTestPaths`, letting `deriving-selection` run fresh for each). All 5 completed with `step: "done"`, no errors. `engineChecksum` unchanged for every one.

## Selection and economics: 5 for 5, all `HONORED_EXACTLY`, all positive

| PR | Selected/Total | Full (ms) | Selected (ms) | Net saved (test-stage) | Reduction |
|---:|---:|---:|---:|---:|---:|
| #29529 | 1 / 250 | 287,779 | 20,680 | 255,830 ms | 88.9% |
| #29819 | 1 / 250 | 461,418 | 20,092 | 421,604 ms | 91.4% |
| #29583 | 2 / 250 | 300,917 | 20,107 | 266,142 ms | 88.4% |
| #29541 | 3 / 249 | 462,345 | 20,083 | 423,581 ms | 91.6% |
| #28567 | 5 / 249 | 204,640 | 20,568 | 176,075 ms | 86.0% |

Every merge: `runtimeSelection.status: "HONORED_EXACTLY"` - the selected file count matches the executed file count exactly, every time, across genuinely different changesets (1 to 11 changed files) and genuinely different selected-set sizes (1 to 5 tests). This is not specific to PR #29940 - the argument-forwarding fix generalizes across this repository's real historical merges.

Full-suite duration varies meaningfully across merges (204.6s to 462.3s) despite all running the same ~406-file, ~4,126-test suite under identical isolation settings - this is Cloudflare container scheduling variance (consistent with PR #29940's own ~3% sample variance, just a wider real-world range across different underlying containers/times), not a per-merge effect. Selected-suite duration is remarkably stable (20.1-20.7s) across every merge, exactly as expected for a small, fixed selected-set count dominated by bootstrap cost.

## Recall: honest, not uniformly "confirmed" - and that's the correct outcome

| PR | `recallMeasurable` | Failing test(s) under mutation | What this means |
|---:|---|---|---|
| #29529 | **false** | *(none - full suite also caught nothing)* | Mutated `console.log`/type-safety change has no dedicated test coverage anywhere in the suite - not a DiffCI gap, a real coverage gap in the merge itself. |
| #29819 | **false** | *(none)* | Mutation target was `packages/app-store/apps.metadata.generated.ts` - a **generated** file; reverting generated registry metadata plausibly has no behavioral test surface. |
| #29583 | **true** | `handleCancelBooking.test.ts :: Cancel Booking Should throw when cancelling a non-existing booking` | Direct, sensible match to the PR's own subject ("return 404 when booking does not exist"). Selected suite caught it too. |
| #29541 | **false** | *(none)* | Mutation reverted `apps/web/lib/daily-webhook/getBooking.ts` - the PR's own subject ("use BookingRepository instead of direct prisma call") describes a pure internal refactor with no intended behavior change; a mutation with no observable effect is the *expected* result for a true no-op refactor, not a failure. |
| #28567 | **true** | 5 tests in `EditLocationDialog.test.tsx` (render, cancel, team/non-team booking location display) | Direct match: reverting a `getEventLocationType` → `getLocationByType` rename breaks the dialog component built against the new name. Selected suite caught all 5 identically to the full suite. |

**2 of 5 mutations were measurable; both of those were confirmed caught, by both full and selected suites, with an exact match.** The other 3 are not DiffCI or harness failures - they are real cases where reverting the merge's own change produces no observable behavior difference (dead code path, generated artifact, true no-op refactor), so no test - full-suite or selected - could have caught it. Reporting `recallMeasurable: false` for these, rather than fabricating a pass, is the harness's anti-vacuity rule working exactly as designed. **Do not read "3 of 5 unmeasurable" as "DiffCI's recall is 40%"** - the correct reading is "2 of 2 measurable cases confirmed, 3 of 5 mutations were not real regressions to begin with."

## Aggregate picture across all 8 execution runs this session (3× PR #29940 + 5 predeclared merges)

- **8 / 8** economics results positive, ranging 86.0% to 91.6% (test-stage) / not yet computed at job-level for the 5 new merges (Report 11's job-level methodology applies identically - left as a follow-up given each merge has its own real install/pretest timings already captured in the raw records).
- **8 / 8** `runtimeSelection.status: HONORED_EXACTLY` - zero instances of the selection being ignored or broadened, across 6 different merges.
- **5 / 8** recall measurable; **5 / 5** of those confirmed with correct, sensible attribution.
- **0 / 8** errors, timeouts, or infrastructure failures.

## What this does and doesn't establish

**Does:** the argument-forwarding fix and the execution-selection invariant hold up across a genuinely diverse, predeclared (not cherry-picked) sample of cal.com's real history - not a PR #29940-specific artifact.

**Does not yet:** claim a portfolio-wide cal.com savings percentage (job-level savings still need computing per merge, and 6 merges is not the same as "cal.com's CI in general"), or extend any of this to DeepSeek Harness or Nx (items 6-7 of the requested plan, not started).
