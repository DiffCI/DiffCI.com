# Report 18 — production-safe selective execution loop: built, hard-wired, proven live

Follow-up to Reports 17 (rolling fingerprint fix) and the atomic-persistence/safety-facts-separation work
that followed it. Covers the "production-safe selective execution loop" the user specified next, before an
external shadow pilot: always-run cohort, periodic full-suite audit sampling, a repository-level safety
budget, and keeping policy separate from these observations.

## What was built

- **always-run-cohort.ts** (`selectAlwaysRunCohort`): picks up to `maxCohortSize` distinct FILES by
  observation count among the rolling fingerprint's tracked entries meeting `minObservations` - historically
  recurring, high-signal tests that should keep being watched even when the selection engine picks a tiny
  affected set.
- **audit-sampling.ts** (`decideAuditSampling`): a deterministic (FNV-1a hash, not `Math.random()`) per-merge
  decision on whether THIS merge counts as audited evidence - same mergeSha always produces the same
  decision, reproducible and auditable.
- **safety-budget.ts** (`recordDecision`/`summarizeSafetyBudget`): accumulates real audited evidence per
  repository/identity - total decisions, audited decisions, outcome-changing misses, and real measured wall
  time (never an unmeasured hypothetical). `summarizeSafetyBudget` withholds a miss-rate percentage entirely
  below `minAuditedSampleSize` rather than computing-and-labeling-uncertain - mirrors
  `classifyStability`'s own `insufficient_samples` discipline. Workload-reduction IS reported below that
  threshold, since it's a measurement, not a statistical claim.
- **baseline-fingerprint-gate.ts**: `SafetyFacts` gains a fifth, purely informational
  `repositoryTrackRecord` field. `strictRawOutcomePolicy` does not consume it - pinned by a test that a
  300-decision, 0-miss track record does NOT override a refusal driven by the current run's own facts.
- **SafetyBudgetStore** (new Durable Object, `execution-shard-do.ts`): same atomic-per-identity pattern as
  `RollingFingerprintStore` (Report 17 follow-up) - one instance per repository/identity, Cloudflare's own
  single-threaded-per-instance guarantee makes the read-merge-write atomic, R2-mirrored for external
  inspection, seeds itself from the mirror on first read.

129 new tests (27 pure-logic, ~12 wiring, 11 direct DO-class tests across both new stores). Full suite:
1208/1208 passing, `tsc` clean. Deployed (`95d14736`).

## Honest scoping note

The always-run cohort is computed and **recorded** on every real merge run, but not yet **forced into what
actually executes**. Doing that requires reading the rolling fingerprint before `selected-baseline` runs -
earlier in the state machine than `finalize()`, where this pass's wiring lives. Flagged as a real follow-up,
not silently skipped: recording it now lets the retrospective question "would the cohort have caught
something DiffCI's own selection missed" start being answerable from already-collected data ahead of that
step-machine change.

## Live proof (`deepseek-2808-loop-smoke`, real PR #2808 merge evaluation)

Real merge run (mergeSha `c71ff384...`, base `ed3ef7a...` - the same identity 4 rolling-fingerprint samples
have now been recorded against, including Report 17's DO-atomic-persistence smoke test).

**Always-run cohort**, drawn from the real 4-sample fingerprint:

```json
"alwaysRunCohort": {
  "files": [
    "deepseek-ai__deepseek-harness/scripts/install-lefthook.spec.ts",
    "subprocess-local/tests/process-exit.spec.ts",
    "terminal-bash/tests/local.spec.ts"
  ]
}
```

All three are the exact stable-core files this mission's rolling fingerprint has tracked since Report 17
(4 observations each - present every one of the 4 samples recorded against this identity).

**Audit sampling**, deterministic on the real mergeSha:

```json
"auditSampling": { "sampled": false, "hashValue": 0.7863071907777339, "policyFraction": 0.1 }
```

**The precise nuance this design exists to get right** - this run's own facts showed a genuine
`NOT_PRESERVED` outcome:

```json
"facts": {
  "rawFullSuiteOutcomePreserved": "NOT_PRESERVED",
  "newFailuresMissedBySelection": [
    "subprocess-local/tests/process-exit.spec.ts :: ...preserves normal terminate-and-join disposal..."
  ]
}
```

but because `auditSampling.sampled` was `false`, the persisted safety budget - fetched directly from R2,
not inferred - shows this decision counted toward `totalDecisions` and `cumulativeSelectedWallMs` (real
measurements, always recorded) but explicitly NOT toward `auditedDecisions` or `outcomeChangingMisses`:

```json
{
  "totalDecisions": 1,
  "auditedDecisions": 0,
  "outcomeChangingMisses": 0,
  "cumulativeSelectedWallMs": 20648,
  "cumulativeAuditedFullWallMs": 0
}
```

This is exactly the "audited = the sampling POLICY decision, not = this validation harness happened to have
full-suite data" distinction the design calls for - proven against real persisted state, not just the pure
`recordDecision` unit tests (which already covered this same case with synthetic inputs; this confirms the
live wiring passes the real `auditSampling.sampled` flag through correctly rather than defaulting to "we
have data, so audited=true").

## What remains before external shadow installs (per the user's own sequencing)

1. Actually forcing the always-run cohort into what executes (the identified step-machine change above).
2. A second live data point to observe budget ACCUMULATION across multiple real merges (not run this round -
   the accumulation logic itself is exhaustively unit-tested; this round's live proof targeted the
   infrastructure wiring a unit test cannot cover, matching the same "prove it once, live" discipline used
   throughout this mission rather than spending further Cloudflare compute on repeated confirmation).
3. The always-run cohort's OWN economic cost (it necessarily runs some tests beyond DiffCI's own selection)
   is not yet reflected in `economicsBeneficial` - a real accounting gap to close before the cohort is wired
   into actual execution.

Per the user's explicit sequencing, external shadow installs are the next milestone after this - not
started.
