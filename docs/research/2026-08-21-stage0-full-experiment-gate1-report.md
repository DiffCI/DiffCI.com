# Stage 0 full experiment — Gate 1 report (~750 cumulative deltas)

**Result: GATE 1 PASSED.** This is an integrity gate, not a performance gate - it does not evaluate
whether DiffCI's numbers look good; it evaluates whether the orchestrator, evidence pipeline, and
safety properties are trustworthy enough to keep going.

## What was dispatched

Two live `/v1/orchestrate` calls against the real deployed Worker + Sandbox containers
(`experimentId: stage0-full-2026-08-21`, concurrency=3, batchSize=15):

1. `axios/axios`, `colinhacks/zod`, `pmndrs/jotai`
2. `unjs/defu`, `trpc/trpc`, `sindresorhus/execa`

All 6 repositories reached `status: COMPLETE` at their full 100-commit target on the first
`orchestrator_attempts` (no retries needed). Combined with repositories already banked from the medium
batch and Gate 0, **global unique deltas: 743** (target ~750).

## Independent verification (not just trusting the Worker's `ok: true`)

- **D1 uniqueness**: `COUNT(DISTINCT logical_delta_key) = COUNT(*) = 743` globally. Zero duplicate rows.
- **D1 per-repo uniqueness**: for all 6 freshly-dispatched repositories, unique-key count = total-row
  count = 100 each. Zero duplicates at the repository level either.
- **Record-level invariant checks**, run against the actual 600 records returned inline in the two
  orchestrate responses (not summary statistics - the real per-delta data): `testsSelectedByDiffci <=
  testsTotal`, `testsSelectedByPath <= testsTotal`, `diffciTasks <= fullTasks`,
  `pathBaselineTasks <= fullTasks` for every one of 600 records. **Zero violations found.**
- **Cross-repo duplicate `logicalDeltaKey` check** across the full 600-record combined set (would catch
  cross-repository contamination). **Zero duplicates found.**
- **Graph confidence / fallback distribution** (global, via D1): `sindresorhus/execa` and `trpc/trpc`
  are both 100% UNSAFE-confidence/fallback, exactly matching the medium batch's established negative
  results - neither was fixed, tuned, or excluded. No repository shows `UNSUPPORTED` confidence yet
  (expected: only TS/JS repos touched so far).
- **Safety signal on this 600-record subset** (includes both known-negative UNSAFE repos, so a
  harder-than-average sample): DiffCI unsafe misses = 0 (100% observed failure recall on this subset);
  PATH baseline had 7 unsafe misses on the same subset. Historical evidence collection (the newly wired
  GitHub token) is visibly live and contributing: 63 historical failures observed across 30 failing
  deltas in this subset, not the zero/absent values seen before the token was wired in.
- **Budget**: real measured spend so far, $0.0865 total (`budget_ledger`, wall-clock-based Container
  cost model) - consistent with the pre-Gate-1 projection's order of magnitude, nowhere near any
  threshold.

## Not a STOP condition (expected, restated per the frozen methodology)

`buildStage0Report`'s own generic verdict field on this specific 6-repo/600-record subset reads
`proceedToStage1: STOP` with `medianTaskReduction: 0`. This is the **unconditional** median across ALL
deltas including `MANDATORY_FALLBACK` ones (both `execa` and `trpc` are 100% fallback by construction,
and they make up 2 of these 6 repositories - a harder-than-average subset, not representative of the
whole 20-repo corpus). Per the frozen methodology and the task's explicit instruction, **a negative or
zero unconditional-median result is not a Gate stop condition** - only evidence corruption, duplication,
impossible counts, safety failures, or budget breach are, and none were found. The
opportunity-conditioned analysis (the actual metric of interest, matching the medium batch's 24.6%
aggregate reduction finding) will be computed once the full corpus is analyzed, not repeatedly
re-litigated at every partial gate checkpoint.

## Decision

Proceeding to Gate 2 (~1,000 cumulative deltas): dispatching `unjs/ofetch`, `unjs/h3`,
`sindresorhus/ky` next (each needs ~65 more commits to reach 100 - cheapest remaining partial-progress
repositories), followed by `pmndrs/zustand` and `unjs/unstorage`, before any of the 9 never-touched
repositories are dispatched.
