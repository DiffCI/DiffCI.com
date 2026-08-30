# External validation #1 — frozen conclusion

**The initial external-target sequence is closed.** Five repositories, one assessment reached, one
correct out-of-sample sign prediction.

## The conclusion, as agreed

> **External validation #1:** Five repositories were selected before repository-specific DiffCI
> inspection. Four failed preregistered assessability gates: Fastify and Axios because their canonical
> baselines were red, date-fns because the current apparatus could not preserve its monorepo execution
> scope without altering the measured decision, and Chalk because AVA was unsupported. Immer was the
> first assessable target. The eligibility rule predicted POSITIVE before economics were run;
> subsequently frozen economics measured +46.97 CPU-s incremental savings, confirming the predicted
> sign. This is one out-of-sample sign confirmation, not evidence of a general prediction accuracy rate.
> The prediction's magnitude is not validated; post-hoc matched-candidate analysis exposed substantial
> fixed execution overhead omitted by the current per-file model.

## The result is the sequence, not the number

The strongest claim available is **not** "+46.97 CPU-s". It is:

> A predictor frozen before economics made a POSITIVE prediction on the first externally selected
> repository that passed the pre-registered assessability gates, and the subsequently frozen measurement
> was also POSITIVE.

**n = 1.** That validates the *experiment* — the freeze, the ordering, the refusal to tune — not the
predictor generally.

## The magnitude diagnostic, stated correctly

`+129.67 predicted → +46.97 measured` is **not a 64% error**, and must not be presented as one: the
denominators differ, 25 observations against 7 measured candidates. The only legitimate magnitude
comparison is explicitly post-hoc and matched:

> **Post-hoc matched subset: +85.19 predicted-equivalent vs +46.97 measured.**

That exposed something actionable rather than merely theoretical:

**The linear `CPU/file` model underprices small selective executions**, because invocation and startup
overhead remains substantial as the file count approaches 1–2. Modelled 0.6539 CPU-s/file; observed
~2.7 CPU-s/file at 1–2 files. This is now an **observed model limitation** with a measurement attached,
and its error direction **inflates** predicted savings.

## What immer's topology does and does not establish

```
FULL                79.02 CPU-s
comparator          79.51 CPU-s      <- degenerates to FULL, and slightly worse
DiffCI execution    21.61 CPU-s
joint analysis      10.93 CPU-s
DiffCI total        32.54 CPU-s
```

immer is close to an extreme topology. **DiffCI is not winning against an already-efficient cheap
heuristic here** — the comparator essentially degenerates to FULL, and costs marginally more than simply
running everything.

That is legitimate evidence, because the comparator was frozen independently and applied unchanged. But
it **limits what immer establishes about harder competitive cases**, where a path-rule selector is
genuinely narrow. Nothing here shows DiffCI beating a comparator that works.

## Two separate questions, with different amounts of evidence

| Question | Evidence |
|---|---|
| **Does the economic predictor work when reached?** | First external test: **yes, sign matched.** n = 1. |
| **How often can it be reached?** | **Unknown.** 1 of 5 in this sequence — a signal, not a population estimate. |

Conflating these would be the easiest way to overstate the programme. The headline is not "DiffCI saved
46.97 CPU-seconds on immer"; it is that a mechanism now exists for deciding **before deployment** where
DiffCI is economically useful — demonstrated once, end to end, without tuning.

## Artefact chain

| Stage | Commit |
|---|---|
| Protocol frozen, no target named | `04750a3` |
| Assessment implementation under test | `910969f` (unchanged throughout) |
| immer selected, before inspection | `c4d4f80` |
| Prediction frozen, before economics | `bae2d00` |
| Raw measurement frozen, before comparison | `6c34819` |
| Comparison and outcome | `4753ff5` |

Every stage is committed in order, and each was committed before the information that would have let it
be shaded existed.

## Next

**Not target #6.** The next experiment answers the second question:

> How often can DiffCI currently reach the economic assessment at all, and why does it fail when it
> cannot?

See [addressability-survey-preregistration.md](addressability-survey-preregistration.md).
