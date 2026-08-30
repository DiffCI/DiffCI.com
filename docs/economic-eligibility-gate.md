# The economic eligibility gate

```
npm run calibrate   -- --repo <clone> --install "..." [--build "..."] --out calibration.json
npm run eligibility -- --corpus <corpus.jsonl> --calibration calibration.json [--label <name>]
```

The pre-registered predictor from `e12c207`, made reproducible. It adds nothing to that rule and
introduces no thresholds.

```
cpuPerFile    = fullCpu(one calibration run) / test files the runner executed
avoidedFiles  = Σ comparatorSelected − Σ diffciSelected
predictedIncr = avoidedFiles × cpuPerFile − Σ analysisCpu

predictedIncr > 0 → POSITIVE       predictedIncr < 0 → NEGATIVE
```

## Two input paths, one rule

`--corpus` is the path that matters. It reads an **observation** run: what each side *would* have
selected, and what DiffCI's analysis cost. Nothing else was executed. This is the only path that can run
on a repository before anything is sold, and it is how the vuejs/core prediction was frozen before any
economics ran.

`--bundle` reads the same quantities out of a completed economics run. It is retained so the three
frozen bundles stay verifiable, not because it is the intended path.

## Reproduction of the three known repositories

Predicted from **observation alone** — no comparator arm, no DiffCI arm, no mutation:

| Repository | Candidates | Comparator | DiffCI | Avoided | Predicted | Measured | Match |
|---|---:|---:|---:|---:|---:|---:|:--:|
| honojs/hono | 25 | 1026 | 1248 | −222 | **−216.61** | −80.90 | ✔ |
| colinhacks/zod | 25 | 2793 | 2156 | +637 | **+162.71** | +183.20 | ✔ |
| vuejs/core | 25 | 2355 | 3414 | −1059 | **−861.01** | −1163.33 | ✔ |

And through the bundle path, unchanged from before:

| Repository | Predicted | Measured | Match |
|---|---:|---:|:--:|
| honojs/hono | −206.82 | −80.90 | ✔ |
| colinhacks/zod | +138.19 | +183.20 | ✔ |
| vuejs/core | −972.20 | −1163.33 | ✔ |

**Sign agreement 3/3 on both paths.** Magnitudes are rough — hono is out by a factor of 2.5 — which is
expected and was never claimed. The sign is the whole rule.

The observation path covers **25 candidates per repository against the bundle path's 11–22**, because
compute-measurability is a property of execution and observation does not need it. More candidates, no
execution, same three signs.

## The FULL-mode trap

A `FULL` decision records `selected: 0`. It did not select a small subset — it declined to select at all
and runs the entire universe. Summing the raw field would record DiffCI's **most** expensive outcome as
its **cheapest**.

On vuejs/core, 8 of 25 candidates are FULL. Counting them at zero would move the prediction from
−861.01 (NEGATIVE) to a positive number — a sign flip, in DiffCI's own favour, silently. So
`effectiveSelection()` is a named function with the reasoning attached, and the FULL count is printed
alongside every observation-path verdict.

## Calibration is measured, not asserted

`npm run calibrate` runs the documented install and the full suite once, measures CPU through the same
primitive as every other measurement in this project, and reads the test-file count out of the runner's
own output — `Test Files  182 passed | 1 skipped (183)` → **183**, the parenthesised total, not the
passed count.

It refuses to emit a calibration if the count cannot be parsed, if the suite did not exit 0, or if CPU
could not be measured. A guessed denominator would rescale every prediction made from it invisibly, and
a suite that was not green is not a cost baseline.

The three reproductions above still pass `--full-cpu` / `--test-files` by hand, because their
calibration runs predate this script and re-deriving them would change the frozen numbers.

## Why Vue's number here differs from the frozen prediction

The frozen Vue prediction was **−1092.54**; this gate emits **−861.01** from observation and **−972.20**
from the economics bundle. None is wrong and the spread is worth understanding:

| | frozen prediction | observation path | bundle path |
|---|---:|---:|---:|
| `fullCpu` | 148.12 (qualification run) | 133.30 | 133.30 |
| `analysisCpu` | 76.74 (observation run) | 89.62 | 58.04 |
| candidates | 16 | 25 | 16 |

Same rule, same repository, inputs drawn from different runs and different candidate sets. The **sign is
stable across all of that variation**, which is the property the rule claims; the magnitude is not,
which is why no threshold is applied to it.

## What the gate needs, and what it does not

Every input is obtainable **without executing the comparator or DiffCI arms at all**:

- `comparatorSelected` / `diffciSelected` — selection counts, from observation
- `analysisCpu` — measured during observation
- `fullCpu` and the test-file count — one full-suite run, for calibration

So the gate costs **one clone, one install, one full-suite execution, and N observations** — about five
minutes of container time for vuejs/core. It never has to run the optimised path to predict whether the
optimised path is worth running.

That is no longer an argument about what the gate *could* do — the observation table above is computed
exactly that way.

## Deliberately absent

- **No thresholds.** No minimum-percentage rule, no confidence band, no commercial floor. Any of those
  would be tuning against three repositories.
- **No directive.** The verdict is `ECONOMICALLY_UNFAVOURABLE_PREDICTION`, not "do not enable". The rule
  has exactly one out-of-sample validation, far short of what an automated production decision needs. It
  can become authoritative after external validation and not before.
- **No opaque score.** The raw inputs always print with the verdict, so a customer or investor can see
  precisely why the prediction came out as it did — and dispute the arithmetic if they wish.

## The proposition this enables

> Give DiffCI read-only access to a repository. In a short assessment it estimates whether deeper impact
> analysis is likely to save compute beyond simple path-based selection. If the predicted economics are
> not favourable, we tell you that rather than recommending deployment.

That makes the hono and vue negatives part of the product's credibility rather than something a pitch
has to avoid.

## Status

Internal phase complete. The rule reproduces all three known signs **from observation alone**, through a
reproducible command whose calibration is measured rather than supplied by hand.

**No external outreach has been started.** The end-to-end `calibrate` path has not yet run against a
repository nobody has studied — that is the first external step, and it is not taken on my initiative.
