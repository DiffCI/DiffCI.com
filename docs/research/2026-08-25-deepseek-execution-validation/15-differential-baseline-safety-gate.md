# Report 15 — differential-baseline safety gate

The concrete product answer to Reports 11-14's dirty-baseline finding, per explicit direction: not four more base-SHA controls, and not a repository-specific quarantine - a general, tested policy module.

## What it is

`src/analysis-fanout/baseline-fingerprint-gate.ts` - a third, independent gate alongside the existing correctness gate (the frozen engine's `SAFE_TO_PROPOSE`/runtime-selection invariant) and economic gate (`activation-gate.ts`'s `decideActivation`). Neither of those two answers the question this mission's evidence exposed: *is it safe to treat a selected suite's "0 failures" as representative of the full suite's health, when the full suite itself is not clean?*

**Policy**: selective execution may only be trusted as a full-suite proxy when a **trusted fingerprint** - a real, previously-recorded set of known-failing tests at one exact base commit - exists, matches the merge's exact base SHA, and is recent enough to still be believed.

```
decideBaselineSafety(...) ->
  REFUSE_NO_FINGERPRINT       - no fingerprint has ever been established (the ordinary starting state)
  REFUSE_WRONG_BASE           - fingerprint exists but for a different base commit, however recent
  REFUSE_STALE_FINGERPRINT    - fingerprint matches the base but exceeds the caller's trust window
  ACTIVATE                    - fingerprint is fresh and matches - observed failures may be classified against it
```

```
classifyAgainstFingerprint(observedFailures, fingerprint) ->
  { knownFailures, newFailures, clean }   - exact string match only, no fuzzy/normalized matching
```

**No silent defaults anywhere**: an absent fingerprint never means "assume clean" - `classifyAgainstFingerprint` with `fingerprint: undefined` treats every observed failure as new (maximally conservative), and is meant to be paired with a `REFUSE_*` decision from the gate, not used as a substitute for calling it.

## Real evidence used as test fixtures, not synthetic data

The test suite (`tests/analysis-fanout/baseline-fingerprint-gate.test.ts`, 9 tests) uses PR #2808's own real base SHA and the exact 6 failures Report 14 directly proved identical at base and merge under non-root execution - not invented data. One test confirms the real mutation-caused failure (`frontend-static.spec.ts`) is correctly classified as `new`, not swallowed by the fingerprint - the policy must never let a genuinely new regression hide behind a broad known-failures list.

## How this would apply to deepseek-harness today

Per this mission's own evidence: **no trusted fingerprint currently exists in any persisted form** (the base-SHA control runs in Reports 12 and 14 were one-off investigative executions, never written to a fingerprint store). Applying this gate today, honestly, yields `REFUSE_NO_FINGERPRINT` for every deepseek-harness merge - consistent with the conservative default from the prior message (*"if baseline full suite is red and no trusted quarantine/base-failure set exists: do not activate selective execution"*), now expressed as a real, callable, tested policy rather than a stated intention.

**What would need to exist for `ACTIVATE`** (not built this round, scoped deliberately): a persistence layer that runs a real base-SHA full-suite execution (exactly the mechanism already proven in Reports 12/14) on some cadence or trigger, writes the result as a `BaselineFingerprint`, and is read back by whatever decides per-merge activation. This module is the decision logic that layer would call - not the layer itself.

## Explicitly not done, per instruction

- No repository-specific quarantine list built from these five experiments.
- Not wired into the live `AnalysisExecutionShard` DO pipeline this round (mirrors `activation-gate.ts`'s own existing status - a standalone, pure, tested decision module, not yet threaded into the execution state machine. Cal.com's mission used `decideActivation` the same way throughout - invoked directly against real recorded numbers, not auto-wired).
- No claim that this makes DeepSeek "activation-ready" - it is the mechanism that would let it become so once a real fingerprint-persistence layer exists and actually runs; today it correctly refuses.

## Cross-repository posture, updated

```
Cal.com:            clean baseline throughout this mission - activation-quality proof stands as-is,
                     this gate is a no-op for it (a clean full suite trivially satisfies any reasonable
                     fingerprint, or needs none).
DeepSeek Harness:    strong economic (83.5%-94.3% net) and differential-recall (3/3 confirmed) evidence,
                     generalizing Cal.com's mechanism to a second, architecturally different repository -
                     but REFUSE_NO_FINGERPRINT today under this new, honest gate. Shadow-mode is the
                     correct characterization until a fingerprint-persistence layer is built and run.
```
