# Report 08 — mutation-recall report (Phase 8)

## Per-merge recall

| PR | Mutation target | Full mutant: new failures beyond baseline | Selected mutant: new failures | `recallMeasurable` | Outcome |
|---:|---|---|---|---|---|
| #2760 | *(none - predeclared unavailable, Report 02/03)* | N/A | N/A | N/A | not applicable, not a miss |
| #2808 | `packages/host/frontend-static/src/index.ts` | 1 (`frontend-static.spec.ts`'s Loader-composition test) | 1 (identical test) | **true** | **confirmed** |
| #1373 | `packages/typert/generator/src/cordis-catalog.ts` | 2 (`cordis-catalog.spec.ts`, both catalog-fidelity tests) | 2 (identical 2 tests) | **true** | **confirmed** |
| #2814 | `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx` | 4 (`input-bar.client.spec.tsx`, all 4 decoration/caret-edit tests) | 4 (identical 4 tests) | **true** | **confirmed** |
| #2844 | `apps/web/tests/scaffold.ts` | **0** (mutant.full's 16 failures are a strict subset of baseline.full's 17 - one flaky pre-existing failure simply didn't reproduce that run) | 0 | **false** | **unmeasurable** (corrected - see below) |

**3 unique measurable mutation cases (not 4 - PR #2808 counted once, using `canary2`; `canary1`'s off-target result is excluded per Report 05, not a second case). All 3 confirmed: full mutant caught it, selected mutant caught the identical failing test(s), zero misses.**

## #2844: corrected determination, and why

The raw `ExecutionRecord` for `deepseek-2844-batch1` was finalized using the pre-fix recall computation (`(failed ?? 0) > 0`, see the harness-bug section below) and stored `recall.fullSuiteCaughtMutant: true`. **This is superseded here.** An exact `failedTests` diff shows:

- `baseline.full.failedTests`: 17 entries (pre-existing/environmental failures - present on every run this mission, unrelated to any specific merge).
- `mutant.full.failedTests`: 16 entries, **all 16 already present in the baseline's 17** - one baseline failure (`subagent/tests/continuation.spec.ts`) simply did not reproduce, ordinary flaky-test variance.
- Zero new failures anywhere.

**Why the mutation was unobservable, not just unlucky**: `apps/web/tests/scaffold.ts` is a shared test-infrastructure helper for the `apps/web/tests/*.e2e.ts` suite (Report 03 flagged this exact tension - the deterministic rule's lexicographic pick was not the "obviously relevant" file). Both `baseline.full` and `mutant.full` in this harness execute only the **unit family** (`pnpm test` → root `vitest.config.ts`) - the same family-scope limitation that made #2844's own selective run `IGNORED_OR_BROADENED` (Report 07). The E2E family that would actually exercise `scaffold.ts` never ran in *either* the full or the selected baseline this round - not because the mutation had no effect, but because nothing in this round's executed universe could have observed one either way. This is `recallMeasurable: false` for a structural reason (Report 03's own predeclared caveat: "If the resulting mutation turns out unmeasurable... that is an honest result"), not a defect in DiffCI's selection.

**Corrected**: `recall = { fullSuiteCaughtMutant: false, selectedSuiteCaughtMutant: false, recallMeasurable: false }`.

## A fourth harness defect, found and fixed mid-batch

The recall computation itself (`computeEconomicsAndRecall`, `execution-shard-do.ts`) determined `fullSuiteCaughtMutant` via a raw `(mutant.full.failed ?? 0) > 0` check - "did the mutant run have any failures at all," not "did it have any NEW failures beyond the baseline." deepseek-harness's real baseline has 16-18 pre-existing/flaky failures on **every single run** this mission (a genuine property of this repository, never seen on Cal.com, whose baseline stayed failure-free throughout its entire mission history - which is exactly why this bug never surfaced there). The raw check would report `fullSuiteCaughtMutant: true` on essentially every merge regardless of whether the mutation did anything, purely from baseline noise.

**Fixed** (commit `89d5f1f`, deployed as `a5fbca72`) while `deepseek-2814-batch1` was still mid-execution (`full-mutant` step) - caught in time for that run's own `finalize()` to use the corrected computation natively (confirmed: its 21 `mutant.full` failures split cleanly into the 17 pre-existing + exactly 4 new, matching an independent manual diff). `#2808`'s canary and `#1373`'s batch run both completed *before* this fix, but their raw failure counts were independently, manually diffed against their own baselines (see the per-merge table above) and confirmed genuinely new in both cases - their `recallMeasurable: true` conclusions are correct, just not produced by the corrected code path. Only `#2844` needed the retroactive correction documented above.

## Run-level and unique-case recall

```
Run-level:   3 measurable executions recalled / 3 measurable executions = 100%
Unique-case: 3 unique measurable mutations recalled / 3 unique measurable mutations = 100%
```

(#2808's `canary1` off-target result is not counted as a second execution of the same mutation case - it targeted a different, incorrect file due to a harness bug, not a repeat of the real #2808 mutation case.)

**0 confirmed misses. 2 unmeasurable cases** (#2760: no valid target; #2844: unit-family-only harness scope cannot observe an E2E-scaffold mutation) **- neither counted as a recall success or a miss**, per the mission's explicit anti-vacuity rule.
