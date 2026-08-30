# Interpretation criteria for the five — FROZEN before economics

**Committed before any observation, mutation or economics run exists for these repositories.** The
thresholds below were set by the user without sight of any result, and are not adjusted afterwards.

The five: `prettier/prettier`, `kulshekhar/ts-jest`, `webpack/css-loader`,
`prettier/eslint-config-prettier`, `kentcdodds/cross-env`.

`webpack/webpack` stays exactly where it is — `not qualified`, killed at the 25-minute bound. **Not
diagnosed and not fixed during this experiment.** Its timeout is compatibility evidence.

## Thresholds

| Metric | Strong | Excellent |
|---|---:|---:|
| Observed false greens | **0** | **0** |
| Failure recall | ≥99% | **100% observed** |
| Measurable mutation cases | ≥80% | ≥90% |
| Selected work reduction | ≥20% | ≥30% |
| Wall-clock / CPU reduction | ≥10% | ≥20% |
| Net savings after DiffCI overhead | positive on ≥3/5 | positive on ≥4/5 |
| Large repos (prettier, ts-jest, css-loader) | positive economics | strongly positive |

## Three quantities, reported separately per repository

Never collapsed into one number:

```
gross savings   = full-suite cost − selected-suite cost
DiffCI overhead = analysis / selection cost
net savings     = gross savings − DiffCI overhead
```

The distinction is the point. Prettier saving 300 CPU-seconds against a 3-second analysis is a
compelling product result. cross-env saving 1 second against a 2.7-second analysis is economically
negative — **and that is completely acceptable evidence.**

## The boundary is a wanted result, not a failure

The experiment is expected to expose a break-even workload size. A claim of the form

> DiffCI is economically beneficial above approximately X tests / Y seconds of baseline CI

is **better** than pretending every repository benefits. Small repositories measuring negative sharpens
the ICP rather than invalidating the product.

`cross-env` (5 files, 63 tests, 3.50 CPU-s) and `eslint-config-prettier` (4 files, 463 tests, 32.41
CPU-s) are small enough that DiffCI's per-candidate analysis overhead — 2.7 CPU-s on immer — is
comparable to running their entire suites. Both are run anyway. **No exclusion on size, before or
after.**

## Reporting rules

- **Do not aggregate the five too early.** Per-repository first.
- Report **both macro averages and workload-weighted results.** Otherwise cross-env's 63 tests count as
  much as prettier's 35,278 and distort the conclusion.
- Every refusal and unmeasurable case stays in the denominator rather than disappearing.

`prettier/prettier` carries the most weight: 35,278 tests, 1,557 files, ~805 CPU-s per run. Zero false
greens while substantially reducing that workload is far more valuable evidence than doing well on
cross-env.

## The four outcomes, and what each implies

| | Safety | Economics | What to do next |
|---|---|---|---|
| **1** | strong | strong | Stop optimising the selection engine. **Attack compatibility** — monorepos and unsupported runners. |
| **2** | strong | weak | The selection idea may work; overhead or selection breadth needs optimisation. Find the break-even workload size before expanding compatibility. |
| **3** | weak | strong | **Do not sell the optimisation.** False greens dominate everything else. Work on selection safety. |
| **4** | weak | weak | The core thesis needs more work before compatibility expansion matters. |

**Hidden inside #2 is a potentially excellent outcome:** small repositories economically negative while
medium and large ones are strongly positive. That would sharpen the ICP rather than invalidate the
product.

## Context this sits in

The assessment reach rate from survey-01 is **5/34 package entries (14.7%, 95% CI 6.4–30.1%)** and
**5/26 distinct repositories (19.2%, 95% CI 8.5–37.9%)**. The compatibility envelope is narrow. That
5 of 6 qualified once a repository reached the supported surface is encouraging, and this experiment
asks the separate question of whether the engine is *valuable* inside that surface.

Nothing in the apparatus, the selector, or the accounting changes for this run.
