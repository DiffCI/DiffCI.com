# FROZEN PREDICTION: `immerjs/immer` incremental CPU — **POSITIVE**

**Committed before any economics arm was executed against immerjs/immer.**

This is the **first out-of-sample prediction the eligibility rule has ever made** on a repository that
took no part in developing it.

## PREDICTED SIGN: **POSITIVE**

`ECONOMICALLY_FAVOURABLE_PREDICTION`

## The calculation, mechanically from the frozen rule

Rule from `docs/stabiliser-hypothesis-preregistration.md` (frozen at `e12c207`), implementation
`910969f`, both unchanged.

```
  Calibration
    full CPU:                 15.04 CPU-s   (one run)
    test files:                  23
    modelled CPU/file:       0.6539 CPU-s

  Observation
    candidates:                  25
    comparator selected:        441 files
    DiffCI selected:            140 files
      of which FULL:              6 candidates counted at the full universe
    avoided files:              301
    analysis CPU:             67.16 CPU-s

  Predicted incremental CPU
    301 x 0.6539 - 67.16  =  129.67 CPU-s
```

## Inputs and their provenance

| Input | Value | Source |
|---|---|---|
| `fullCpu` | 15.04 CPU-s | `immer-qualify-01` baseline **run 1** |
| test files | 23 | same run, `Test Files 23 passed (23)` |
| `cpuPerFile` | 0.6539 CPU-s | 15.04 / 23 |
| Σ comparator selected | 441 | `immer-observe-01`, 25 candidates |
| Σ DiffCI selected | 140 | same |
| `avoidedFiles` | +301 | 441 − 140 |
| Σ analysis CPU | 67.16 CPU-s | measured per candidate |

Everything is from the canonical Linux environment, agent generation B,
`immerjs/immer@061c2425e1c9dff89e4e4189d42af1b7839dfe0a`.

**Neither the comparator arm nor the DiffCI arm was executed.** Observation only.

## Evidence sufficiency, checked against the frozen threshold

**25 of 25** observations carry both a decision and a recorded analysis CPU. The frozen threshold is
≥15 of 25. `SUFFICIENT`.

That count was the *only* thing computed before the rule was run. No per-candidate selection, ratio, or
distribution was inspected first.

## Calibration: the estimator was NOT changed after seeing variance

Baseline run 1 measured **15.04** CPU-s; run 2 measured **13.99** — a **7% spread**.

`fullCpu` is taken from **run 1**, which is the value the frozen procedure has used throughout
(vue's came from `vue-qualify-01` baseline run 1 in exactly the same way). Switching to a mean, a
minimum, or any other estimator *after* seeing the spread would change the rule in the middle of the one
experiment designed to test it.

Recorded as a known weakness rather than corrected: a 7% calibration spread propagates directly into the
magnitude, because `cpuPerFile` multiplies `avoidedFiles`. Using run 2 instead would give
`301 × 0.6083 − 67.16 = +115.9`. **The sign is unchanged**, which is the only thing the rule claims.

## Why this prediction differs in character from the three internal ones

This is the first repository where DiffCI selects **substantially fewer** files than the comparator
across the corpus — 140 against 441. zod was the only internal repository with that shape (629 vs 761),
and it was the only internal positive.

**That resemblance is an observation, not a defence.** It is written here, before the measurement, so
that it cannot later be presented either as prescience or as a reason the result was inevitable.

## Known weaknesses, recorded before the measurement

1. **`cpuPerFile` assumes uniform per-file cost.** immer's 23 files carry 3,772 tests, distributed
   unevenly. If DiffCI's 140 selected files skew toward expensive ones, the true saving is smaller than
   predicted; if toward cheap ones, larger. This error is not bounded here and could be large in
   magnitude — it would have to reverse the ordering of nearly the whole corpus to flip the sign.
2. **Six candidates are FULL**, counted at the full universe of 23 by `effectiveSelection()`. Counting
   them at their recorded `selected: 0` would inflate the prediction; the correct treatment reduces it.
3. **A 23-file universe is small.** Selection differences are coarse-grained: one file is 4.3% of the
   suite. The absolute CPU numbers are correspondingly small, and 129.67 CPU-s across 25 candidates is
   roughly 5 CPU-seconds per candidate.
4. **Analysis CPU is 67.16 against a full suite of 15.04.** DiffCI's analysis costs **more than four
   times a full run of this suite** in total across 25 candidates — about 2.7 CPU-s per candidate
   against 15.04 for running everything. The prediction is positive only because the comparator is
   modelled as running so much more. If the comparator's selections are cheap in practice, this flips.

Weakness 4 is the one most likely to matter, and it is stated here in full rather than after the fact.

## What each outcome will mean

- **Measured POSITIVE** → `CONFIRMED_POSITIVE`. The rule's first correct out-of-sample prediction. **n=1**,
  on a repository reached after four independently selected external repositories failed pre-registered
  assessability gates.
- **Measured NEGATIVE** → **`FALSE_POSITIVE_ELIGIBILITY`**, the outcome the protocol names as the most
  commercially serious: the gate would have told a customer to expect savings and then burned more
  compute. It is reported at the top of the result document. **immer becomes development-set evidence,
  the predictor is not repaired against immer and re-run on immer**, and any corrected predictor faces a
  new target in a new sequence.

No noise band. The sign is the whole rule.

## The sentence this result must be reported in

Whatever the measurement says, neither half may travel alone:

> The frozen eligibility rule made its first out-of-sample prediction on immer after four independently
> selected external repositories failed pre-registered assessability gates. The prediction
> **[matched / did not match]** subsequently measured economics.

It is **not** "4/4 repositories predicted correctly" — hono, zod and vue are development evidence and
cannot be added to this. It is **not** "the predictor works on repositories." Predictive validity and
reachability are separate questions, and this programme has measured one instance of the first and four
refusals on the second.

## Status

**Prediction frozen. Economics NOT run.** `.dogfood/external/immer/corpus.jsonl` and
`prediction.txt` are committed alongside this document as the exact inputs and the exact output.
