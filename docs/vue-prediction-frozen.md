# Frozen prediction: vuejs/core incremental CPU

**Committed before any economics arm was executed against vuejs/core.**

Rule from `docs/stabiliser-hypothesis-preregistration.md` (frozen at `e12c207`), applied mechanically.

## Inputs

All from the canonical Linux environment, agent generation B, `vuejs/core@d63616ca`.

| Input | Value | Source |
|---|---|---|
| `fullCpu` | 148.12 CPU-s | `vue-qualify-01` baseline run 1 |
| test files | 183 | same run, `Test Files 182 passed (183)` |
| **`cpuPerTest`** | **0.8094 CPU-s/file** | 148.12 / 183 |
| Σ comparator selected | 591 | `vue-observe-01`, 16 candidates |
| Σ DiffCI selected | 1846 | same |
| **`avoidedTests`** | **−1255** | 591 − 1846 |
| Σ analysis CPU | 76.74 CPU-s | measured per candidate |

## The calculation

```
predictedIncr = avoidedTests × cpuPerTest − Σ analysisCpu
              = (−1255) × 0.8094 − 76.74
              = −1015.80 − 76.74
              = −1092.54
```

## PREDICTED SIGN: **NEGATIVE**

DiffCI is predicted to consume substantially **more** compute than the path-rule comparator on
vuejs/core, before its analysis overhead is even charged.

## Why, in one line

**DiffCI selects 3.1× MORE than the comparator here.** 1846 files against 591 across 16 candidates.
This is the inverse of zod, where DiffCI selected fewer (629 vs 761).

Per-candidate, the comparator is consistently tight while DiffCI is broad:

```
commit       diffci  comparator  total
ef82a2677      183         10      196
b8543dcf0      162         20      196
a2b40db9a      183         23      196
f8d42e1cf       97         44      196
4e467d7ae      183         95      196
246846479       57         60      196   <- the only candidate where DiffCI selects fewer
```

## This is the adverse reading the pre-registration warned about

The pre-registration recorded two competing explanations for DiffCI's stable selection sizes, and said
repository #3 was the first evidence that could separate them. It does.

**DiffCI's Vue selections take only four distinct values across sixteen candidates:**

```
 57  ×4      97  ×5      162 ×3      183 ×3
```

Sixteen different commits, four distinct selection sizes, in a 196-file universe. That is not
fine-grained per-commit discrimination; it is bucket-like behaviour, and it favours **reading 2 — a
coarse selection floor** — over reading 1, bounded impact analysis.

On zod that bucketing was economically harmless because the comparator was usually *larger*. On Vue the
comparator is usually far smaller, so the same behaviour is expensive. The hypothesis survives as a
*predictor* while the benign interpretation of the underlying mechanism weakens.

## Known weakness in this prediction, recorded before the measurement

`cpuPerTest` is derived from 183 files that vitest actually ran under `--project unit*`, while DiffCI's
universe is **196** files. The extra 13 are presumably files the unit projects exclude. So a few
DiffCI-selected files may not execute at all, which would make the true cost of DiffCI's arm slightly
lower than this estimate.

That error is in the direction that would *soften* the prediction. It cannot plausibly flip it:
−1255 files at ~0.81 CPU-s is roughly −1016 CPU-s, and closing that gap would require nearly the entire
selection to be non-executing.

## What each outcome would mean

- **Measured negative** → the rule predicted correctly out of sample, in the opposite direction from
  zod. Two correct predictions with opposite signs is considerably stronger than the zod result alone.
- **Measured positive** → the rule is wrong, or per-test cost is so non-uniform on Vue that file counts
  do not track compute. Either way the hypothesis fails out of sample and must be reported as failed.
- **Measured near zero** → the magnitude model is poor even if the sign logic is sound.

No verdict labels, no noise threshold. The prediction is the sign.
