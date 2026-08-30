# Endpoint of the technical branch, and the hypothesis that replaces it

**This branch is closed at `7fd1d1c`.** No symbol-aware selection, no further Vue optimisation
experiment, no repository #4 run merely to increase `n`.

## What the branch established

| | |
|---|---|
| Safety | 39/39 canonical recall-measurable cases confirmed across hono, zod, vue. 0 observed false greens. A milestone, **not a reliability rate**. |
| Economics | Repository-dependent: **+183.20** CPU-s on zod, **−80.90** on hono, **−1163.33** on vue. |
| Prediction | A pre-registered rule predicted vue's incremental **sign** out of sample, from observation alone. |
| Causation | Vue's cost is barrel-mediated file-level closure, **every edge real**, zero unexplained selections. |
| Rescue attempt | Symbol precision tested on the strongest available case. `D=99, A=19, U=65`. It did not survive. |

The last row is the one that closes the branch. `looseEqual` genuinely reaches
`runtime-core/src/componentRenderUtils.ts`, which most of Vue's runtime test surface depends on — so
much of the expensive closure is **structurally justified by the repository's topology**, not an
artefact that finer resolution would remove.

## The hypothesis that replaces it

> DiffCI should determine whether its incremental economics are likely to be positive for a repository
> **before** enabling optimised execution.

That is materially different from trying to make every repository profitable. It converts the hono and
vue negatives from something a pitch must avoid into something **the product can detect and decline**.

**Still a hypothesis, not a product claim.** It rests on three repositories and one correct
out-of-sample prediction.

## Why this is plausible rather than merely convenient

The Vue prediction was made **before any economics ran**, from:

- observation counts (comparator vs DiffCI selection, per candidate)
- measured joint analysis CPU
- `cpuPerTest` from a single full-suite execution

Total cost for Vue: one clone, one install, one full suite run, twenty-five observations — about five
minutes of container time. **The eligibility signal is cheap enough to run on a prospect's repository
before selling them anything**, which is the property that makes it a product mechanism rather than a
research finding.

## What the customer qualification criterion may be

Not "every company with CI". Possibly:

> repositories where existing cheap path/affected selection frequently expands into broad execution,
> while DiffCI can maintain a materially narrower justified closure.

zod is that shape. hono and vue are not.

## What has NOT been established

- That the predictor works on repositories outside these three.
- That a positive prediction converts into a billable saving.
- That customers will accept a product that sometimes declines to optimise.
- Any figure in **currency**. Everything measured so far is CPU-seconds.

## The next evidence is external, not internal

Another clever internal experiment has diminishing value. The chain that matters now:

    real repository -> observation -> predicted economics -> actual economics
                    -> customer's CI bill -> dollars saved

Anything touching real customers is outward-facing and is not started on my initiative.

The protocol for the first step of that chain is frozen in
[external-validation-protocol.md](external-validation-protocol.md).
