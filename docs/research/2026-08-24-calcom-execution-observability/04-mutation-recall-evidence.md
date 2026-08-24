# Report 6/9 — Mutation-recall evidence report

Source: `exec-calcom-29940-diag2`, terminal record `runs/exec-calcom-29940-diag2/calcom__cal.diy/execution-176037d0af.json`, `step: "done"`.

## What the mutation was

Whole-file revert of `packages/lib/getReplyToHeader.ts` to its exact pre-merge (base) content — the same file this PR's own diff changed, restored byte-for-byte. Applied, verified, and reverted cleanly (working tree confirmed back at the merge state after `revert`).

## Full-mutant and selected-mutant results

| | Baseline (unmodified merge) | Mutant (`getReplyToHeader.ts` reverted) |
|---|---|---|
| Full suite | 0 failed, 401 passed, 5 skipped (406 files) | **1 failed**, 400 passed, 5 skipped (406 files) |
| "Selected" suite | 0 failed, 401 passed, 5 skipped (406 files) | **1 failed**, 400 passed, 5 skipped (406 files) |
| Full exitCode | 0 | 1 |
| Selected exitCode | 0 | 1 |

Both mutant runs are, once again, identical to each other in every count — consistent with (and further confirming) Report 3's finding that "selected" is not actually narrowed in this repository's current command shape. This mutation pass does not give a second, independent data point on whether the *selected subset specifically* catches the regression, because there was no real subset run to evaluate.

## Mutation attribution: uncertain, honestly reported

The mission requires: *"inspect the failure assertion and stack trace to determine whether it exercises the `customReplyToEmail`/`hideOrganizerEmail` behavior or the changed source path. If attribution remains uncertain, say so."*

**It remains uncertain**, and here is exactly why: this harness captures only the **last ~8000 characters** of each process's stdout (`stdoutTail`, added this session specifically to give visibility that didn't exist before). For a 406-file, 4126-test run, Vitest prints the failing test's name, assertion, and stack trace as it happens — long before the final summary block — and the retained tail contains only the summary (`Test Files 1 failed | 400 passed...`) plus the last ~40 passing test lines. **The actual `FAIL`/`✗` line naming the failing test is not present in the captured evidence.**

What *can* be said from the numbers alone: the baseline had exactly 0 failures across 401 non-skipped files; the mutant has exactly 1 new failure, with every other count unchanged. This is consistent with a single, isolated regression — plausibly `packages/lib/getReplyToHeader.test.ts` (the test file for the exact source file that was reverted) — but this is a **reasoned hypothesis from count arithmetic, not a confirmed identification** of the failing test or its assertion. No stack trace or assertion message for the actual failure was retrieved.

## Recall: formally unconfirmed, and not meaningfully testable yet regardless

`record.recall`:
```json
{ "fullSuiteCaughtMutant": false, "selectedSuiteCaughtMutant": false, "recallMeasurable": false }
```

This is the harness working exactly as designed, not a bug: `computeEconomicsAndRecall()` requires `mutant.full.observabilityStatus === "complete"` before asserting a definite caught/missed value, and both mutant runs are `"missing-report"` (the same still-open JSON-reporter gap from Report 3). A human reading the console summary can see strong circumstantial evidence of a real, caught regression (0→1 failures) — but the automated system correctly declines to convert that into a confirmed `recallMeasurable: true`, exactly per the mission's own anti-fabrication rule.

Separately and more fundamentally: **even with a working JSON report, recall is not meaningfully testable on this repository until the runtime-selection bug (Report 3) is fixed.** "Does the selected suite catch what the full suite catches" is not a real question when the "selected" suite is actually the full suite. This mutation pass is complete and correctly executed, but its result cannot yet answer the question it was designed to answer.

## Verdict

- **Full-suite recall of this mutant: circumstantially strong, not formally confirmed** (0→1 failure count, no verified failing-test identity).
- **Selected-suite recall: not evaluable** — there is no genuine selected run to evaluate yet.
- **No recall claim is made or should be inferred from this run.**
