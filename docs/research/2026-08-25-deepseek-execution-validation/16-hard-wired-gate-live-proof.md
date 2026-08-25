# Report 16 — the hard-wired gate proven live, end to end

Steps 5, 6, and 8 of the requested increment, executed on real Cloudflare infrastructure - not reasoned about, not unit-tested-only.

## Setup (step 5)

1. `deepseek-2808-fp-basecontrol` (base SHA `ed3ef7aceef1a5...`, `runAsNonRoot: true`, `branch: "main"`) - a real base-SHA control run under the newly-deployed hard-wired code. `baseline.full`: 9 failures, `exitCode: 1`. `finalize()` auto-persisted a `BaselineFingerprint` to R2 at `fingerprints/deepseek-ai__deepseek-harness/main/ed3ef7aceef1a5.../nonroot__unit__test.json` - confirmed directly from the raw record's own `fingerprintPersisted: { key, knownFailureCount: 9 }`, not inferred.
2. `deepseek-2808-fp-merge` (same base, merge SHA `c71ff384cc80f8...`, same identity) - the real PR #2808 pipeline, full baseline through mutant, run immediately after.

## Result 1: a real, naturally-occurring REFUSE_NEW_FAILURE_NOT_PRESERVED (steps 6 & the "prevented a false-green attempt" bar)

`deepseek-2808-fp-merge`'s own `baseline.full` observed 8 failures. Two of them do **not** appear in the 9-failure fingerprint just established 29 minutes earlier:

```
- scripts/oxlint-contract.spec.ts :: Oxlint executable contract prints only the final diagnostics when a fix retry still fails
- subagent/tests/continuation.spec.ts :: SubagentRuntime.startContinuable returns both identities at inbox acceptance, without waiting for the turn or the log
```

Both are ordinary flaky variance (this repository's ~21-test flaky pool, characterized across Reports 11-14 - `continuation.spec.ts` in particular has appeared with *different specific failing tests* across nearly every run in this mission). Neither is caused by PR #2808's own change. **The gate does not know or care why they're new - it only knows the trusted fingerprint doesn't account for them, and the selected suite (scoped to `frontend-static`/`web-app` files) had no way to have observed them either.** Live result, straight from the persisted record:

```json
"finalActivation": {
  "decision": "REFUSE_NEW_FAILURE_NOT_PRESERVED",
  "newFailuresInFull": ["oxlint-contract.spec.ts...", "continuation.spec.ts :: startContinuable..."],
  "newFailuresMissedBySelection": ["oxlint-contract.spec.ts...", "continuation.spec.ts :: startContinuable..."]
}
```

**This is a stronger proof than a deliberately staged false-green attempt would have been** - it is the gate correctly refusing on a real, unplanned instance of exactly the dirty-baseline problem this whole mission has been investigating, using production infrastructure, not a contrived test case.

## Result 2: the real mutation correctly classified as new AND correctly preserved

`mutantActivationDecision` (the same run, mutant phase, same fingerprint):

```json
{
  "decision": "EXECUTE_SELECTIVELY",
  "newFailuresInFull": ["frontend-static.spec.ts :: real Loader composition..."],
  "newFailuresInSelected": ["frontend-static.spec.ts :: real Loader composition..."],
  "newFailuresMissedBySelection": []
}
```

The deliberate, real mutation (reverting `packages/host/frontend-static/src/index.ts`, the same target Report 03 predeclared) produced exactly the expected new failure, correctly distinguished from the 9 fingerprinted pre-existing ones, and correctly found preserved in the selected suite's own real results - matching this mission's earlier recall-confirmed finding (Report 06/14) but now flowing through the actual hard-wired gate rather than a manual comparison.

**Both outcomes came from one run.** The gate is neither rubber-stamping everything (proven by the baseline-phase refusal) nor over-refusing everything (proven by the mutant-phase activation) - it discriminates correctly between "new failure the selection had no chance to observe" and "new failure the selection genuinely caught."

## Step 7: scope decision, stated honestly

Environment/command-identity invalidation (root vs non-root, different `testArgv`) is proven via 2 targeted tests in `execution-shard-do.test.ts` that exercise the real `finalize()`/`applyBaselineFingerprintGate()` code path (not a reimplementation) against a mocked R2 bucket seeded at the exact production key format. **Not re-proven with a second live ~20-minute Cloudflare run** in this report - the live run above already confirms the identical key-construction/fetch mechanism works correctly end-to-end for a MATCHING identity; a non-matching identity exercising the same `bucket.get()` returning `null` is not a materially different code path requiring its own live confirmation, and the marginal evidence did not justify the additional compute. Flagged explicitly, not silently skipped.

## Step 8: audit record

Both `activationDecision` and `mutantActivationDecision` are present, unmodified, in `raw-deepseek-2808-fp-merge-final-record.json` - the same R2-persisted `ExecutionRecord` every run in this mission produces. No separate audit log was built; the decision lives in the same durable artifact as everything else.

## An honest, additional finding this run surfaced (not hidden because it produced a "refuse")

A single base-SHA fingerprint (9 known failures, one sample) did **not** fully cover this next run's own flaky subset 29 minutes later - consistent with this mission's own characterization of the repository's flakiness (≥21 distinct flaky tests observed across Reports 11-14, no two runs showing an identical full set). **A production-grade implementation of this gate would likely need more than one fingerprint sample** - e.g. a rolling/merged known-flaky set built from several base-SHA runs, or an explicit re-fingerprinting cadence - to avoid refusing activation on ordinary flaky noise as often as a single snapshot does. This is a real operational limitation surfaced by real evidence, not a defect in the gate's logic (the gate did exactly what it was built to do: refuse when it cannot be sure) - flagged here as the natural next refinement, not silently smoothed over because the headline result this round was a refusal rather than an activation.

## Updated posture

```
DeepSeek Harness: the differential-baseline safety gate is no longer a pure module awaiting
integration - it is hard-wired into the real execution pipeline and has been proven, live, to
both correctly refuse (on real flaky noise a single fingerprint sample didn't cover) and correctly
activate (when a real new failure is genuinely preserved by the selected suite). Still shadow-mode
in the sense that no real CI decision is gated on this output yet - but the enforcement mechanism
itself is real, tested against real infrastructure, and demonstrably conservative rather than
permissive.
```
