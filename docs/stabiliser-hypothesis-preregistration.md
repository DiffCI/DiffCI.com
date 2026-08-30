# Pre-registration: the comparator-volatility hypothesis

**Frozen 2026-08-30, before repository #3 was selected and before any observation was run against it.**

This document exists to be wrong in public if it is wrong. It is committed before the data that could
confirm or refute it, so the prediction cannot be adjusted after the fact.

## The hypothesis

> DiffCI's incremental compute advantage is predicted by the frequency and magnitude with which the
> cheap path-rule comparator expands beyond DiffCI's relatively stable selection. Repositories where the
> comparator usually remains tight should show weak or negative DiffCI incremental compute.
> Repositories where it frequently expands should show positive incremental compute — **provided the
> avoided execution CPU exceeds DiffCI's analysis overhead.**

The final clause is load-bearing. Test counts alone are insufficient because test costs are not uniform,
and because analysis overhead is a fixed toll that small selections cannot amortise.

## What the two existing repositories show

|  | hono | zod |
|---|---:|---:|
| gross CPU | +1408.92 (~73%) | +669.12 (~29%) |
| **incremental CPU** | **−80.90** | **+183.20** |
| positive rows | 4/22 | 9/11 |
| DiffCI selection | ~83, stable | ~125–127, stable |
| comparator selection | 1–123, volatile | 113–193, volatile |
| comparator ≥ 100 tests | 4 of 22 | 7 of 11 |

Both repositories obey the same rule: DiffCI wins exactly when the comparator over-selects and loses
when the comparator is tight. They differ only in how often that happens.

**Had we benchmarked against FULL alone, we would have reached almost exactly the wrong product
conclusion — hono would look dramatically better than zod.**

## The prediction rule, fixed now

Applied mechanically to repository #3, from observation data only:

```
cpuPerTest        = fullCpu(one commit) / totalTestCount        # measured once, calibration only
avoidedTests      = Σ comparatorSelected − Σ diffciSelected     # across observed candidates
predictedIncr     = avoidedTests × cpuPerTest − Σ analysisCpu

predict POSITIVE  if predictedIncr > 0
predict NEGATIVE  if predictedIncr < 0
```

`analysisCpu` is measured directly by the observation pass, so it is not an estimate.
`cpuPerTest` is the one modelled quantity, and it is the known weak point: per-test cost is not uniform,
so a repository whose expensive tests cluster inside or outside the avoided set could defeat the rule
without the hypothesis being wrong in spirit. That is recorded here rather than discovered later.

**The prediction is the SIGN, not the magnitude.** No claim is made about how large the effect will be.

## What would falsify this

- Predicted sign ≠ measured sign on repository #3.
- A repository where the comparator is consistently tight yet DiffCI shows positive incremental compute
  (or the reverse) — that would mean comparator volatility is not the operative mechanism.
- Incremental sign varying between two runs of the same repository, which would mean the measurement is
  noise-dominated rather than the hypothesis being wrong.

## The interpretation that is NOT yet established

DiffCI's selection sizes are strikingly stable — ~83 on hono, ~125–127 on zod, largely independent of
the commit. Two readings fit that equally well today:

1. **Bounded impact analysis.** DiffCI correctly identifies a stable affected region, and the comparator
   needlessly expands.
2. **A coarse selection floor.** DiffCI has settled on a bucket of roughly fixed size and is not
   discriminating much per commit — which happens to be advantageous whenever the comparator explodes.

The economics are identical under both readings, which is why this is not being resolved before
measuring. Repository #3 is the first evidence that could separate them: a repository where the
comparator is tight and DiffCI still selects a large stable bucket would favour reading 2.

## What must not be said yet

"DiffCI is a stabiliser that caps the blast radius" is an **empirical hypothesis explaining two
repositories**, not product positioning. It has not been tested out of sample.

The defensible statement today is:

> In initial canonical experiments, DiffCI produced positive incremental compute savings on zod and
> negative incremental savings on hono. The difference appears predictable from comparator
> over-selection, and we are testing that hypothesis out of sample.

Not: *"DiffCI saves 29% compute."* The first describes a possibly defensible economic mechanism; the
second confuses gross with incremental, which is the exact error this whole apparatus was built to
avoid.

## Selection criteria for repository #3, fixed before selection

Chosen for methodological fit, explicitly **not** for expected outcome:

- TypeScript or JavaScript, since that is what the agent analyses.
- A test runner the harness can parse and invoke with explicit file paths (vitest, jest, node:test,
  mocha) — this is what disqualified TanStack, whose nx orchestration takes project names.
- Real history, no external services or credentials, per the validation contract.
- Plausibly mutation-qualifiable, though mutation is NOT part of this experiment.
- **Not** screened by running DiffCI on it first. Choosing after seeing the selection ratios would make
  the prediction unfalsifiable.

## Procedure

1. Select repository #3 against the criteria above.
2. Observation pass only — no mutation, no economics. Record comparator and DiffCI selection counts per
   candidate, and the measured analysis CPU.
3. Calibrate `cpuPerTest` from a single FULL execution.
4. Apply the rule above. **Commit the predicted sign.**
5. Only then run the economics arms.
6. Report prediction against measurement, whichever way it falls.

If the prediction holds out of sample, the finding is not "DiffCI saves X%". It is *a measurable
repository characteristic that predicts when DiffCI creates economic value* — which could become an
eligibility mechanism: do not sell or enable optimisation where the cheap rule is already excellent.

If it holds, the next step is dollars, not repository #4.
