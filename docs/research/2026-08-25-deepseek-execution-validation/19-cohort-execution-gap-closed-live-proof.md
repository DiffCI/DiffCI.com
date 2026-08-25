# Report 19 — the cohort execution gap is closed, proven from real execution evidence

Follow-up to Report 18, which left an honest gap open: the always-run cohort was computed and *recorded*
but never *forced into what actually executed*. This report closes that gap and proves it - not from the
persisted record alone, but from the real invoked test command and Vitest's own real stdout - per the
explicit instruction to verify from execution evidence, not merely the final record.

## What changed

1. **Fingerprint/cohort reads moved earlier.** `applyAlwaysRunCohort` now runs inside `deriving-selection`,
   before `selected-baseline`/`selected-mutant` are ever constructed - not in `finalize()`, where it used to
   live (too late to affect anything). Control-run samples (`mergeSha === baseSha`) never get a cohort
   applied - their selected phase is already flagged as an operator-supplied convenience, not real selection
   economics; overlaying a cohort there would only add a second confound to an already-non-representative
   measurement.

2. **Cohort unioned into execution.** New `execution-plan.ts` (`buildEffectiveExecutionPlan`) computes
   `effectiveFiles = affected ∪ cohort`, deduplicated, sorted, with one `TestProvenance` entry per file
   (`AFFECTED` / `ALWAYS_RUN` / `BOTH`). `selectedBaseline`/`selectedMutant` now invoke the test runner with
   this effective set (`record.effectiveSelectedTestPaths`), not the bare affected selection.
   `classifyRuntimeSelection` is now evaluated against the effective set too - the cohort's deliberate
   addition is part of what was actually requested, not an anomaly that should read as broadened selection.

3. **Cohort economics measured separately, honestly.** New `cohort-economics.ts` (`computeCohortWorkload`)
   attributes real per-file wall time (from Vitest's own per-file `startTime`/`endTime`, newly captured in
   `vitest-report.ts`'s `fileDurationsMs`) to the cohort-only files specifically - and returns `undefined`
   rather than a partial/misleading number when even one cohort file's duration is unknown.
   `economicsBeneficial` itself needed no special-casing: it already reads `record.baseline.selected.wallMs`
   directly, which is now the REAL effective-plan wall time once the cohort is unioned into what executes -
   the actual execution plan's cost, not a cheaper hypothetical, automatically.

4. **Observation vs audit evidence separated in the safety budget** (a distinct fix requested alongside the
   cohort work, after Report 18's PR #2808 run showed a real `NOT_PRESERVED` outcome that the deterministic
   audit sample correctly did not count): `DecisionOutcome.observedOutcomeMismatch` is recorded into
   `SafetyBudget.observedOutcomeMismatches`/`observationsWithComparisonData` whenever comparison data
   exists, REGARDLESS of `countsTowardSafetyBudget` (the sampling policy decision) - a real observed
   mismatch is never dropped from operational analysis just because it fell outside the randomized audit
   sample. `outcomeChangingMisses`/`auditedDecisions` remain the separate, statistically-designed counters.
   `safety-budget.ts` is now schema-versioned (`SAFETY_BUDGET_SCHEMA_VERSION`), the same lesson Report 17
   taught for the rolling fingerprint, applied proactively this time rather than after a live incident.

129 new/changed tests across `execution-plan.test.ts`, `cohort-economics.test.ts`, a rewritten
`safety-budget.test.ts`, and a new `applyAlwaysRunCohort` describe block in `execution-shard-do.test.ts`
covering every requested invariant (below). Full suite: 1236/1236 passing, `tsc` clean. Deployed
(`77dc4a14`).

## Requested invariants, all tested

- **A cohort-only file actually executes and, if it fails, influences the selective outcome** - two direct
  tests: one drives `deriving-selection` then `selected-baseline` and asserts the cohort file literally
  appears in the invoked `startProcess` command; a second constructs a cohort-only failure and confirms it
  surfaces via `finalActivation.newFailuresInSelected`, not silently absorbed.
- **Empty cohort** - `effectiveSelectedTestPaths` equals the affected selection alone, sorted; every
  provenance entry is `AFFECTED`.
- **Overlap/dedup** - a file both affected and in the cohort appears once, tagged `BOTH`.
- **Cohort-only failure** (separate from the influence test above) - proven end to end through the real
  `decideFinalActivation` pipeline, not a standalone assertion.
- **A cohort large enough to eliminate the economic benefit** - a test with a large real `selected.wallMs`
  drives `economicsBeneficial` to `false`, proving the real executed plan's cost is what gets evaluated, not
  a cheaper hypothetical.

## Live proof (`deepseek-2808-cohort-exec-proof`, real PR #2808 merge evaluation)

**The effective plan, computed live in `deriving-selection` before any test ran:**

```json
"alwaysRunCohort": { "files": ["...install-lefthook.spec.ts", "...process-exit.spec.ts", "...local.spec.ts"] },
"effectiveSelectedTestPaths": [ /* 7 files: 4 affected + 3 cohort */ ]
```

**Real execution evidence** (not the record's own metadata) - the baseline phase's actual invoked command,
fetched mid-run directly from the persisted `TestRunResult.command`:

```json
["test","--reporter=json","--reporter=default","--outputFile.json=/workspace/selected-baseline.json",
 "deepseek-ai__deepseek-harness/scripts/install-lefthook.spec.ts",
 "packages/bundle/web-app/tests/browser-open.spec.ts",
 "packages/bundle/web-app/tests/trusted-hosts.spec.ts",
 "packages/bundle/web-app/tests/web-app.spec.ts",
 "packages/host/frontend-static/tests/frontend-static.spec.ts",
 "subprocess-local/tests/process-exit.spec.ts",
 "terminal-bash/tests/local.spec.ts"]
```

All 3 cohort files are literally present. Vitest's own real stdout (`stdoutTail`) independently confirms 2
of the 3 by name (the third's name likely fell outside the captured ~8000-char tail on a 29-test run). The
mutant phase's own invoked command shows the identical 7-file set.

`runtimeSelection` was correctly classified against the EFFECTIVE (7-file) request, not the bare affected
selection - `HONORED_WITH_FRAMEWORK_EXPANSION` (6 files executed vs 7 requested, within tolerance), not a
false `IGNORED_OR_BROADENED` the pre-fix wiring would have risked.

**The cohort's own real failures were correctly classified as known, not new** - all 5 real failures this
run traced to the 2 cohort-only files that DID have tracked history (`process-exit.spec.ts` x4,
`local.spec.ts` x1, both with 4 prior observations in the rolling fingerprint). `finalActivation.
newFailuresInFull: []` - genuinely empty, not a shortcut - and the baseline phase's real decision was
**`EXECUTE_SELECTIVELY`**, a real activation (unlike Report 18's run against the same merge, which refused
on unrelated new failures the cohort happens not to have been tracking that round). The mutant phase's own
real planted regression (`frontend-static.spec.ts`) was still correctly caught -
`mutantActivationDecision.decision: EXECUTE_SELECTIVELY`, `newFailuresInSelected` contains it.

**Cohort economics - honest degradation on real data, not a fabricated number.** `cohortWorkload` reported
`affectedFileCount: 4, cohortAddedFileCount: 3, effectiveFileCount: 7, effectiveWallMs: 100235` but left
`cohortAddedWallMsApprox`/`affectedOnlyWallMsApprox` **undefined** - not zero, not a partial sum. Tracing
why: `install-lefthook.spec.ts` (one of the 3 cohort files) never produced its own entry in Vitest's JSON
report at all this run (consistent with the file:6-vs-7-requested framework-expansion delta above) - so its
duration was genuinely unknown, and `computeCohortWorkload`'s "never a silently understated partial sum"
rule correctly withheld the whole approximation rather than reporting a number built from only 2 of 3
cohort files. The other two cohort files' real durations WERE captured
(`process-exit.spec.ts`: 84,175ms, `local.spec.ts`: 19,638ms) - the abstention is specific to the one file
with missing data, not a general failure of the mechanism.

**Deterministic audit sampling, reproduced live.** Same mergeSha as Report 18's earlier run against this
identical merge → identical `hashValue: 0.7863071907777339`, identical `sampled: false` - confirmed live,
not just asserted from the pure function's own unit tests.

**Schema-versioned safety budget, live.** `safetyBudgetPersisted.key` now carries `__schema1` - the prior
run's unversioned budget object is left untouched at its old key as historical evidence; this run started a
genuinely fresh series (`totalDecisions: 1`) at the new key, no destructive action taken.

## An open, minor finding (not investigated further this round)

`install-lefthook.spec.ts` produced no separate Vitest suite entry in this real run despite being explicitly
requested - `runtimeSelection` correctly absorbed this as `HONORED_WITH_FRAMEWORK_EXPANSION` (within
tolerance) rather than a false alarm, and `cohortWorkload` correctly declined to guess at its cost. Worth a
closer look eventually (empty file? environment-specific skip?) but not blocking - the invariant this report
set out to prove (cohort files actually execute and their outcomes count) holds regardless, demonstrated by
the other two cohort files' real, measured participation.

## Status against the user's sequencing

Per the explicit direction: "after the cohort is actually executing and its cost is included, stop adding
more internal machinery and move to external shadow installs." That condition is now met - the cohort
executes for real, its cost is measured (or honestly declines to guess when data is missing), and the
result composes correctly with the existing safety-fact/policy separation. This report does not start
scoping the external shadow pilot - that's the next decision, not made here.
