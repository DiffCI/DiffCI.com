# Report — default-isolation controlled run: confirmed positive economics and recall

**Run:** `exec-calcom-29940-isolated1` (`testArgvOverride: ["test"]` - default isolation, no `--no-isolate`, no `--`; harness commit `c3d9706`, deployed `2c862770`; `engineChecksum` unchanged, harness-only). Raw record: `raw-exec-calcom-29940-isolated1-final-record.json`. **Completed cleanly, `step: "done"`, no error** - the max-step-duration safeguard was never triggered (full-baseline finished in 320.9s, well inside the 10-minute cap).

This is the first run in the entire mission where every prior open question resolves at once: real economics, confirmed recall, and exact mutation attribution - all backed by a genuinely parsed structured report, not console-scraping.

## Runtime selection: `HONORED_EXACTLY`, structurally confirmed

```json
{ "requestedTestFiles": [2 files], "testFilesExecuted": 2, "totalTestsExecuted": 20, "status": "HONORED_EXACTLY" }
```

For the first time, this classification comes from a genuinely parsed JSON report (`observabilityStatus: "complete"` on all four test-run steps), not inferred from console text.

## Timings

| Step | Duration |
|---|---:|
| Bootstrap | 11.6s |
| Clone | 90.8s |
| Install | 319.7s |
| Pretest | 17.1s |
| **Full baseline** (406 files, 4,126 tests) | **320.9s** |
| **Selected baseline** (2 files, 20 tests) | **20.0s** |
| Full mutant (406 files) | 301.8s |
| Selected mutant (2 files) | 20.0s |

Two things worth noting precisely:
1. **Full-suite duration under default isolation (~320s) is real and finite** - confirms Report 9's hypothesis: the ~1,231s/20.5-minute hang was specific to `--no-isolate` at full-suite scale, not a general infrastructure problem. Default isolation ran to completion normally, on the first attempt, well inside the new safeguard's 10-minute cap.
2. **Selected-run duration (20.0s for 2 files) is meaningfully slower than the `--no-isolate` probe's 3.4-3.7s for the same 2 files** (Report 8). This is expected and correct, not a regression: default isolation spins up a separate process per file, so even 2 files pay real per-file isolation overhead that `--no-isolate` avoids. The economics below are computed honestly against this real, isolated-mode selected time - not the faster `--no-isolate` number, which was never validated at full-suite scale.

## Economics: real, positive, and substantial

```
analysisOverheadMs: 10,089
fullTestMs:        320,853
selectedTestMs:      20,045
grossSavedMs:       300,808
netSavedMs:         290,719
reductionPct:            90.6%
```

**This is the first genuinely positive, trustworthy economics result in this entire mission.** Net of DiffCI's own analysis overhead, selective execution saves ~4 minutes 51 seconds of the ~5 minute 21 second full-suite run - a 90.6% reduction - for this one real historical merge, under default isolation, with a confirmed-honored selection.

Run through `decideActivation()`:

```
correctnessSafe: true
samples: [{ fullMs: 320853, selectedMs: 20045 }]
analysisOverheadMs: 10089
uncertaintyMarginFraction: 0.05 (illustrative)
-> predictedGrossSavingsMs: 300808
-> requiredSavingsMs: 10089 + 0 + 16043 (5% margin) = 26132
-> netSavingsMs: 274676 (still deeply positive)
-> decision: EXECUTE_SELECTIVELY
-> lowConfidence: true (1 sample - see "what's still needed" below)
```

**For the first time in this mission, the gate resolves to `EXECUTE_SELECTIVELY`, not `SAFE_TO_PROPOSE`.** It remains labeled `lowConfidence` pending more samples (see below) - the mission's own discipline against overfitting from one data point still applies - but the direction and magnitude here are unambiguous.

## Recall: confirmed, with exact mutation attribution

```json
{ "fullSuiteCaughtMutant": true, "selectedSuiteCaughtMutant": true, "recallMeasurable": true }
```

Both `mutant.full` and `mutant.selected` independently report the identical single failing test, verbatim:

> `packages/lib/getReplyToHeader.test.ts :: getReplyToHeader with hideOrganizerEmail and customReplyToEmail uses customReplyToEmail even when hideOrganizerEmail is true`

This is an **exact, unambiguous match** to the merge's own subject line - *"fix(emails): customReplyToEmail no longer dropped when hideOrganizerEmail is true"*. The mutation (reverting `packages/lib/getReplyToHeader.ts` to its pre-merge content) broke precisely the behavior the PR fixed, and precisely one test - the test written for that exact behavior - caught it, in **both** the full suite and DiffCI's 2-file selection. Mutation attribution is fully confirmed, not circumstantial - the failing test's own name states the exact regression.

## Answering the mission's core questions, with real evidence

- **Did Vitest execute only the two selected tests?** Yes - confirmed via a genuinely parsed structured report, not console inference.
- **Which test failed under mutation, and was it caused by the reverted fix?** `getReplyToHeader ... uses customReplyToEmail even when hideOrganizerEmail is true` - yes, exactly and unambiguously the behavior this merge's own fix addresses.
- **Is recall confirmed?** Yes, for both full and selected suites, on a structurally sound (`observabilityStatus: "complete"`) basis.
- **Does file-level selection reduce median wall time?** For this one merge: yes, dramatically (90.6% net reduction). "Median" still requires more than one sample (see below) - this is one real, positive data point, not yet a median.
- **Does it remain beneficial after DiffCI's own overhead?** Yes - net savings of 290.7 seconds after subtracting 10.1 seconds of analysis overhead.
- **Should DiffCI activate selective execution for this exact command shape?** The evidence from this one merge says yes. Before generalizing, the sample count needs to grow past one (below) and the JSON-reporter fix should be re-confirmed as reliable across more than a single run.

## What's still needed before this generalizes

Per the mission's own "do not optimize the numbers" and anti-overfitting discipline:
1. **More than one timing sample.** This report is exactly one full/selected pair - real numbers, not guessed, but a single point estimate. `decideActivation()` correctly flags `lowConfidence: true` for exactly this reason. 2-3 more repeats (of the full and selected baseline runs specifically, not necessarily the mutation pass again) would let the activation gate report a genuine median with dispersion, per the original mission's Phase 5 protocol.
2. **A second, different cal.com merge**, chosen by a predeclared rule (not favorable-savings bias, per the mission's own earlier instruction) - this run and every prior one in this mission are all PR #29940. No claim is made here about cal.com's savings in general, only about this one merge under this one confirmed-working command shape.
3. **This positive result is specific to the corrected, `--`-free, default-isolation command.** It does not retroactively validate `--no-isolate` at full-suite scale, which remains the open, unresolved anomaly from Report 9.
