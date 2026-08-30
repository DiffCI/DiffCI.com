# External validation target #5: `immerjs/immer` — and the last of this sequence

**Recorded before the repository's configuration was inspected.** No facts about immer's runner, test
command, or layout appear here.

> **External validation target #5: `immerjs/immer`. Selected by ChatGPT after targets #1–4 were closed,
> before inspecting Immer's current test configuration or producing any repository-specific DiffCI
> observation, comparator selection, calibration, eligibility prediction, or economics data. Selection
> does not imply addressability or qualification; the frozen criteria determine those independently.**

## This is the final target in the initial external sequence

Fixed **now**, before the outcome is known, which is the only time it can be fixed honestly:

- **If immer reaches prediction** — freeze the prediction before economics, and the eligibility rule
  finally gets its first genuine out-of-sample test.
- **If immer stops before prediction** — preserve the outcome and **stop the sequence.** Do not select
  target #6.

In the second case the higher-value next experiment is the pre-registered **addressability/assessability
survey**, not more selections until one happens to pass.

## Why stopping matters more than it looks

The reason is a real methodological hazard, and it is worth stating in full because it would be easy to
walk into without noticing:

> Otherwise we risk eventually saying *"the first assessable external repository validated the
> predictor"* while quietly accumulating an arbitrary number of rejected repositories beforehand.

An unbounded search for a repository that passes the gates is a search with a hidden denominator. The
headline sentence stays literally true no matter how many refusals precede it, which is exactly the
property that makes it misleading.

Two distinct effects, which should not be conflated:

1. **On the prediction test itself — none.** Every refusal so far occurred before any DiffCI data
   existed for that repository, on criteria (runner support, repository layout, baseline green) that
   were fixed in advance. No refusal was influenced by how DiffCI would perform, so a prediction made on
   target #5 is genuinely out of sample.

2. **On the population the result generalises to — real, and unmeasured.** Repositories that are
   single-package, vitest/jest, root-executable and green in a Linux container are not a random sample
   of repositories. A correct prediction on immer would be evidence about *that* population, not about
   repositories in general. **Any eventual success must be reported with the four refusals attached**,
   and with their causes, or the claim overstates its reach.

## The sequence, unchanged

```
single package -> root execution -> supported runner -> explicit-file addressability
  -> canonical green qualification -> calibration -> 25 observations
  -> FREEZE prediction -> economics -> compare
```

No apparatus change to admit this target. No new runner adapter, no monorepo support, no substituted
commands, no relaxed criterion. Coverage is verified against an independently established file count
before any verdict is believed, per defect #13.

## Standing rules

- The assessment implementation remains `910969f`; the protocol remains `04750a3` plus `NOT_ADDRESSABLE`.
- Observation ratios are **not** reported before the prediction is frozen. The report is either a
  refusal outcome or exactly `immer qualified; prediction frozen: POSITIVE/NEGATIVE`.
- If the outcome is `FALSE_POSITIVE_ELIGIBILITY`, immer becomes development-set evidence and the
  corrected predictor faces a new target — which would be a new sequence, deliberately begun, not a
  continuation of this one.
- `0/4` so far is a signal, not a rate. Five is still not a rate.
