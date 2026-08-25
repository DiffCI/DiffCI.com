# Report 17 — rolling multi-sample fingerprint: a real bug found live, fixed, and the corrected model proven end to end

Continuation of the rolling-fingerprint work (design in the mission's prior exchange, code in `rolling-fingerprint.ts`/`baseline-fingerprint-gate.ts`/`execution-shard-do.ts`). This report covers: (1) a real defect found live during the first 2 validation samples, (2) its fix and the schema-versioning safeguard built around it, and (3) the corrected model proven end to end on real Cloudflare infrastructure - 3 base-SHA control samples plus the real PR #2808 merge evaluation against the resulting fingerprint.

## Part A: the bug (found live, samples 1-2, pre-fix)

`deepseek-2808-roll-s1` and `-s2` (raw records preserved: `raw-deepseek-2808-roll-s1-final-record.json`, `-s2-final-record.json`) were both base-SHA control runs for `ed3ef7aceef1a5...`, run sequentially. `s1` persisted 8 tracked failures. `s2` should have added at most 1-2 genuinely new entries (its own failures largely overlapped `s1`'s) - it added **5**, taking `knownFailureCount` to 13.

Cause: `process-exit.spec.ts`'s "managed pid \<N\> is still alive" failure - one of the most consistently recurring failures in this whole mission - carries a live process PID in its message. `s1` saw `managed pid 669`; `s2` saw `managed pid 667`. `normalizeFailureSignature()` stripped ANSI codes, paths, line:col, timestamps, UUIDs, and durations, but not bare numbers in this context, so the 4 process-exit failures produced a **different signature every run** - the compound `(testId, signature)` key `mergeObservation` tracks by never matched itself twice. The rolling fingerprint's entire purpose is recognizing recurring baseline failures; this defeated it for its own best-fit case.

## Part B: the fix

Per explicit direction: normalize *only* contextual process identifiers (`pid 669`, `PID: 669`, `process 669`), not numbers in general - `expected 200, received 500`, `1 worker` vs `10 workers`, and port/config numbers must stay distinct.

- `normalizeFailureSignature()` (`vitest-report.ts`) gained a keyword-adjacent regex: `/\b(pid|process)\s*[:=]?\s*\d+\b/gi` → `"<keyword> <pid>"`. 6 new regression tests pin both directions (the real collapse case, and 4 "must NOT collapse" cases: status codes, worker counts, port numbers, and `processTicksAndRejections`-style Node internals with no adjacent number).
- `NORMALIZE_FAILURE_SIGNATURE_VERSION = 2`, and `ROLLING_FINGERPRINT_SCHEMA_VERSION` (`rolling-fingerprint.ts`) is defined *as* that same constant so the two can never drift apart.
- `RollingFingerprint` gained a `schemaVersion` field. `decideRollingBaselineSafety` refuses (`REFUSE_SCHEMA_VERSION_MISMATCH`) when a stored fingerprint's version doesn't match current. `mergeObservation` independently treats an incompatible `existing` as absent (defense-in-depth if the key-partitioning safeguard below is ever bypassed).
- **Primary safeguard**: the R2 store key gained a `__schema<N>` suffix. The v1 object (built under the buggy normalizer) sits at its own, now-unversioned key - untouched, never read or written again, preserved as invalidated evidence. Schema v2 starts a fresh series at its own key automatically - "reset the DeepSeek identity" required *zero* destructive action (no delete, no overwrite).

1151/1151 tests passing, `tsc` clean, deployed (`c7640eb6-229f-4c14-a1dd-acd357506f7d`), committed (`0987f6c`).

## Part C: the corrected model, proven live (schema v2, 3 fresh samples)

All 3 samples reused PR #2808's real merge selection (`packages/host/frontend-static/tests/frontend-static.spec.ts`) for the selected-phase path, since a base-SHA control run (`mergeSha === baseSha`) has no real diff for the engine to derive a selection from. **This is an operator-supplied convenience, not an engine-derived no-op selection** - recorded explicitly in each run's own `subject` field this time, per the open item to not let this timing be read as genuine selection economics without its origin being on record.

| Sample | Full baseline | Selected | `knownFailureCount` after merge | New entries added |
|---|---|---|---|---|
| 1 (`v2-s1`) | 428,950 ms, 7 failed | 20,549 ms | 7 | 7 (first sample, trivially all new) |
| 2 (`v2-s2b`, retry) | 521,193 ms, 8 failed | 20,068 ms | 9 | +2 (2 genuinely different `continuation.spec.ts` sub-tests; the 4 process-exit + install-lefthook + terminal-bash all correctly matched existing entries) |
| 3 (`v2-s3`) | 812,298 ms, 8 failed | 20,045 ms | 11 | +2 (`subagent-acp.spec.ts`, `oxlint-contract.spec.ts`, both new) |

**Direct proof against the persisted R2 object** (`raw-rolling-fingerprint-schema2-after-s3.json`), not inferred from the count alone:

```
totalBaseRunsSampled: 3
tracked.length: 11
- process-exit.spec.ts (direct)                    | observations: 3
- process-exit.spec.ts (uncaught-exception)         | observations: 3
- process-exit.spec.ts (unhandled-rejection)        | observations: 3
- process-exit.spec.ts (terminal root+descendant)   | observations: 3
- install-lefthook.spec.ts                          | observations: 3
- terminal-bash/local.spec.ts                       | observations: 3
- continuation.spec.ts (3 distinct sub-tests)        | observations: 1 each
- subagent-acp.spec.ts                               | observations: 1
- oxlint-contract.spec.ts                            | observations: 1
```

This is the item the user explicitly asked to be verified: **the 4 recurring process-exit failures each reached 3 observations, not 12 separate identities.** Confirmed directly against the real stored object. The genuinely flaky, non-recurring failures (`continuation.spec.ts` variants, `subagent-acp`, `oxlint-contract`) correctly sit at 1 observation each - not enough to be trusted, exactly as designed.

### An honest infrastructure finding along the way (unrelated to the fingerprint logic)

The first attempt at sample 2 (`v2-s2`, raw record preserved as `raw-deepseek-2808-roll-v2-s2-TIMEOUT-record.json`) hit `step-timeout`: its test process ran 915,616 ms against the repo's 900,000 ms (`maxTestRunMs`) cap and was correctly killed by the existing safeguard (`execution-shard-do.ts`'s `stepTestRun`, `maxMs` check). Traced live: `bootstrapMs`/`cloneMs`/`installMs` were normal (~57s combined, matching every other sample), but there was a ~12-13 minute gap between install finishing and the actual test process starting, before the process itself then ran to the cap. This reads as transient Cloudflare sandbox/container contention, not a logic defect - retried once (`v2-s2b`) and completed normally (full-baseline in 521s, consistent with samples 1 and 3). No code change made for this; flagged here as it happened rather than silently omitted, since a timeout mid-validation is exactly the kind of thing that could otherwise get quietly re-run away.

## Part D: the real PR #2808 merge evaluation against the populated fingerprint

`deepseek-2808-roll-v2-merge` (real merge SHA `c71ff384cc80f8...`, base SHA `ed3ef7aceef1a5...` - the same base the 3 samples above sampled). No `selectedTestPaths` supplied - the real frozen selection engine ran (`deriveSelection`), returning the same 4 files as this mission's earlier PR #2808 runs: `browser-open.spec.ts`, `trusted-hosts.spec.ts`, `web-app.spec.ts`, `frontend-static.spec.ts` (`HONORED_EXACTLY`).

**Baseline phase:**

```json
"baselineSafety": { "decision": "ACTIVATE", "explanation": "rolling fingerprint has 3 samples including this exact base" },
"economicsBeneficial": true,
"finalActivation": {
  "decision": "REFUSE_NEW_FAILURE_NOT_PRESERVED",
  "newFailuresInFull": [
    "session-persistence-jsonl/tests/jsonl.spec.ts :: ...rejects an unknown event type on load...",
    "session-persistence-jsonl/tests/jsonl.spec.ts :: ...flush before init resolves uses cursor 0",
    "subagent-acp/tests/subagent-acp.spec.ts :: cwd resolution rejects a config cwd directory...",
    "subagent-acp/tests/subagent-acp.spec.ts :: ...drives child processes with parent-unique run ids..."
  ],
  "newFailuresMissedBySelection": [ /* same 4 */ ]
}
```

The rolling gate correctly reached `ACTIVATE` on sample-sufficiency (3 samples, this exact base recognized) and economics correctly fired beneficial - but `decideFinalActivation` still refused, because the real baseline for this merge had 10 failures, of which 6 matched the fingerprint's known-stable set and **4 were genuinely new**, none in files the selected suite touches. Exactly the intended behavior: sample-sufficiency and economics are necessary, not sufficient - a fresh, unvouched-for failure still blocks activation.

**Mutant phase** (mutation applied to `packages/host/frontend-static/src/index.ts`, the Report 03-predeclared target):

```json
{
  "decision": "REFUSE_NEW_FAILURE_NOT_PRESERVED",
  "newFailuresInFull": [
    "scripts/oxlint-contract.spec.ts :: ...prints only the final diagnostics when a fix retry still fails",
    "frontend-static/tests/frontend-static.spec.ts :: real Loader composition serves explicit index entries..."
  ],
  "newFailuresInSelected": [
    "frontend-static/tests/frontend-static.spec.ts :: real Loader composition serves explicit index entries..."
  ],
  "newFailuresMissedBySelection": [
    "scripts/oxlint-contract.spec.ts :: ...prints only the final diagnostics when a fix retry still fails"
  ]
}
```

The real, deliberate mutation regression (`frontend-static.spec.ts`) **was correctly caught by the selected suite** - `newFailuresInSelected` contains it. But `oxlint-contract.spec.ts` also failed in the mutant full run; it has exactly 1 prior observation (from sample 3) and is correctly still classified `insufficient_samples` (not yet "stable," not quarantined) rather than being treated as known noise just because it's technically "seen before." Since the selected suite's 4 files never touch `oxlint-contract.spec.ts`, it cannot vouch for it, and the gate correctly refuses again - **even though it also correctly preserved the real mutation.**

**Overall production decision for this merge: REFUSE**, on both the baseline and mutant phases independently, each for a demonstrably correct reason. This is the gate discriminating correctly between "known and stable" (the 6-entry quarantine-eligible core), "known but not yet stable" (`oxlint-contract`, 1 sample), and "genuinely new" (`session-persistence-jsonl`, `subagent-acp`'s specific failures, `frontend-static`'s real regression) - never conflating a correctly-caught deliberate regression with blanket permission to ignore an unrelated, unvouched-for failure.

## Honest limitations carried forward (not fixed this round, explicitly not hidden)

1. **Concurrent-write race, still unfixed.** `applyBaselineFingerprintGate`'s R2 read-merge-write remains non-atomic across concurrent writers. All 4 runs in Part C/D were run strictly sequentially specifically to avoid this - a genuine limitation for any future concurrent base-SHA sampling, not addressed by the schema-versioning fix (which solves a different problem: *what* gets merged, not *how safely* concurrent merges compose).
2. **No-op selected-phase path is operator-supplied, not engine-derived**, for every base-SHA control sample in this report - now recorded in-band (each run's `subject` field) rather than left implicit, per the explicit request to track this origin before any control-run timing is read as selection economics.
3. **The step-timeout on the first `v2-s2` attempt** (Part C) is unexplained beyond "the actual test process took an unusually long time to even start" - not investigated further as it did not recur on retry and is orthogonal to the fingerprint logic under test this round.

## Bottom line

The bug the user caught was real and load-bearing: it would have permanently prevented this repository's single most consistently-recurring failure from ever being recognized as recurring. The fix is narrow (keyword-adjacent PID stripping only, verified not to collapse materially different numeric failures), defended in two independent layers (versioned storage key as primary, in-memory schema check as backstop), and the corrected model is now proven - not just unit-tested - against real Cloudflare infrastructure: 3 sequential base-SHA samples correctly converging the process-exit family to 3 observations each (not 12 new identities), followed by a real merge evaluation that correctly refused activation for well-justified, independently-verifiable reasons on both its baseline and mutant phases.
