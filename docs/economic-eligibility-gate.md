# The economic eligibility gate

`npm run eligibility -- --bundle <frozen run> --test-files <N> [--label <name>]`

The pre-registered predictor from `e12c207`, made reproducible. It adds nothing to that rule and
introduces no thresholds.

```
cpuPerFile    = fullCpu(one calibration run) / test files the runner executed
avoidedFiles  = Σ comparatorSelected − Σ diffciSelected
predictedIncr = avoidedFiles × cpuPerFile − Σ analysisCpu

predictedIncr > 0 → POSITIVE       predictedIncr < 0 → NEGATIVE
```

## Reproduction of the three known repositories

| Repository | Predicted | Measured | Prediction | Measured sign | Match |
|---|---:|---:|---|---|---|
| honojs/hono | −206.82 | −80.90 | NEGATIVE | NEGATIVE | ✔ |
| colinhacks/zod | +138.19 | +183.20 | POSITIVE | POSITIVE | ✔ |
| vuejs/core | −972.20 | −1163.33 | NEGATIVE | NEGATIVE | ✔ |

**Sign agreement 3/3.** Magnitudes are rough — hono is out by a factor of 2.5 — which is expected and
was never claimed. The sign is the whole rule.

## Why Vue's number here differs from the frozen prediction

The frozen Vue prediction was **−1092.54**; this gate emits **−972.20** for the same repository. Neither
is wrong and the difference is worth understanding:

| | frozen prediction | gate |
|---|---:|---:|
| `fullCpu` | 148.12 (qualification run) | 133.30 (first economics candidate) |
| `analysisCpu` | 76.74 (observation run) | 58.04 (economics run) |

Same rule, same repository, calibration inputs drawn from different runs. The **sign is stable across
that variation**, which is the property the rule claims; the magnitude is not, which is why no threshold
is applied to it.

## What the gate needs, and what it does not

Every input is obtainable **without executing the comparator or DiffCI arms at all**:

- `comparatorSelected` / `diffciSelected` — selection counts, from observation
- `analysisCpu` — measured during observation
- `fullCpu` — one full-suite run, for calibration

So the gate costs **one clone, one install, one full-suite execution, and N observations** — about five
minutes of container time for vuejs/core. It never has to run the optimised path to predict whether the
optimised path is worth running.

*(The three reproductions above read their inputs from the frozen economics bundles purely because those
bundles already contain them. The gate does not require an economics run.)*

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

Internal phase complete. The rule reproduces all three known signs through a single reproducible
command. **No external outreach has been started.**
