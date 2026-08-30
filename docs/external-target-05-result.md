# External validation target #5: `immerjs/immer` — `CONFIRMED_POSITIVE`

## The result

| | |
|---|---|
| **Predicted** (frozen at `bae2d00`, before any economics) | **POSITIVE**, +129.67 CPU-s |
| **Measured** (frozen at `6c34819`, before any comparison) | **POSITIVE**, +46.97 CPU-s |
| **Outcome** | **`CONFIRMED_POSITIVE`** — sign match |

The first out-of-sample sign match the eligibility rule has ever produced.

```
incrementalCpu = 79.51 − (21.61 + 10.93) = +46.97 CPU-s
grossCpu       = 79.02 − (21.61 + 10.93) = +46.48 CPU-s
```

Joint analysis charged entirely to DiffCI. All 7 compute-measurable candidates were individually
positive; none was near zero. No noise band was applied and none was needed.

## The sentence this belongs in

> The frozen eligibility rule made its first out-of-sample prediction on immer after four independently
> selected external repositories failed pre-registered assessability gates. The prediction **matched**
> subsequently measured economics.

Not "4/4 repositories predicted correctly" — hono, zod and vue are development evidence and cannot be
added to this. Not "the predictor works on repositories." **n = 1**, on a repository drawn from the
population of single-package vitest repositories that are green in a Linux container.

## The caveat that must travel with the number

**The prediction was computed over 25 observations. The measurement covers 7.**

The mutation pass found only 7 of the 25 candidates recall-measurable, so the economics arms ran on
those 7. This is a larger denominator gap than any previous target — vue predicted over 16 and measured
16; hono measured 22 of 25.

So `+129.67` and `+46.97` are **not two estimates of the same quantity**, and the magnitude comparison
between them is meaningless as stated. The sign comparison is not affected: the rule predicts a sign,
the measurement produced a sign, and they agree.

### The like-for-like diagnostic, clearly labelled as post-hoc

Restricting the frozen rule's inputs to exactly the 7 measured candidates — **computed after the
measurement, and not the prediction**:

```
comparator selected  155        DiffCI selected  8        avoided  147
147 × 0.6539 − 10.93  =  +85.19 CPU-s   (post-hoc)
measured                 +46.97 CPU-s
```

The rule over-predicts the saving by a factor of **1.8**. Same sign, wrong size.

## Why the magnitude was wrong, which is the useful finding

**The uniform per-file cost model breaks down at small selections.**

Calibration says 0.6539 CPU-s per file (15.04 CPU-s ÷ 23 files). But the DiffCI arm actually cost
**21.61 CPU-s for 8 files — about 2.7 CPU-s per file**, four times the modelled rate.

Per candidate the DiffCI arm ran 1–2 files and cost 1.72–4.42 CPU-s. A vitest invocation has a fixed
startup cost that does not shrink with the selection, so at these sizes **the fixed overhead dominates
the per-file term entirely**. The model charges a one-file run 0.65 CPU-s; it really costs roughly 2–4.

This is the fixed-overhead problem this project has already recorded as a known gap, now with a
measurement attached: it was not invented as a constant, it was observed per repository from a selected
run, which is the only defensible way to obtain it.

**Direction matters:** the error inflates predicted savings. On immer it did not flip the sign, because
the comparator was running nearly the entire suite anyway. On a repository where the comparator is
genuinely narrow, the same error is exactly what would manufacture a `FALSE_POSITIVE_ELIGIBILITY`. The
sign survived here partly on the size of the margin, not because the model was right.

## Why DiffCI won on immer

**The path-rule comparator is nearly useless on this repository.** It selected **22–23 of 23 files** on
every candidate — 96–100% of the suite — and cost 79.51 CPU-s against 79.02 for simply running
everything. It is not merely worse than DiffCI here; it is *worse than no selection at all*.

DiffCI selected **1–2 files** per candidate and was scored `EFFICIENT` on all 4 candidates where
efficiency was measurable, with **0 false greens** across 4 recall-measurable cases.

That is the zod shape, more extreme. It is also the honest reading of the win: the comparator's failure
contributes at least as much as DiffCI's precision.

## Safety, reported at its real strength

| | |
|---|---|
| RECALL_CONFIRMED | 4 |
| FALSE_GREEN | **0** |
| RECALL_UNMEASURABLE | 2 |
| INVALID_RUN | 1 |

The bundle's own caveat stands and is not softened: **only 4 measurable safety cases — too few to
support a reliability estimate.** The `INVALID_RUN` is `061c2425e`, where every changed source file was
newly added and therefore none could be reverted. Compute-measurability is independent of recall by
design, which is why that candidate still contributes economics: its arms ran on the unmutated tree.

## What this does and does not establish

**Does:**

- The frozen rule predicted the correct sign on a repository that took no part in developing it, from
  observation alone, with the prediction committed to version control before the measurement existed.
- The measured incremental saving on immer is **+46.97 CPU-s over 7 candidates**, real and measured, not
  estimated.

**Does not:**

- Any reliability rate. n = 1 out-of-sample.
- Any claim about magnitude. The rule over-predicted by 1.8× on the like-for-like comparison, and its
  error direction inflates savings.
- Any currency figure. Everything here is CPU-seconds.
- Anything about repositories the assessment cannot reach — four of five external targets.

## Status

`immerjs/immer` — **`CONFIRMED_POSITIVE`**. The initial external sequence closes here as pre-committed.

The next experiment is the **addressability survey**, not target #6.
