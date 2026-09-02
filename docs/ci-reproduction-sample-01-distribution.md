# CI_REPRODUCTION_SAMPLE_01 — sealed distribution

Five members, frozen in advance at `86ff1f2`, run in rank order with **no stopping on success and no
substitution on refusal**. The engine was never modified: the packed agent digest is
`sha512-eQGRE3ep…` for every member, which is the freeze as a checksum rather than an assurance.

## The distribution

| # | repository | outcome | engine reached? | reference arm |
|---|---|---|---|---|
| 1 | `eslint/eslint` | **`CORRECT_REFUSAL`** | yes | 38,627 passing |
| 2 | `jestjs/jest` | **`DIVERGED`** | yes | 581 passing |
| 3 | `webpack/webpack` | **`INCORRECT_REFUSAL`** | yes | 57,666 passing |
| 4 | `babel/babel` | **`ENVIRONMENT_INADEQUATE`** | **no** | died at `make: not found` |
| 5 | `babel/babel-loader` | **`REFERENCE_NON_DETERMINISTIC`** | **no** | 61 pass / 2 fail from registry drift |

```
REPRODUCED                    0
CORRECT_REFUSAL               1
INCORRECT_REFUSAL             1
DIVERGED                      1
ENVIRONMENT_INADEQUATE        1
REFERENCE_NON_DETERMINISTIC   1
```

**0 of 5 reproduced. 0 of 3 engine-reached members reproduced.**

The threshold for `CI_OPTIMIZATION_01` — at least one external repository at genuine `REPRODUCED`, with
correct job purpose, complete causal path, truthful receipts, no human command repair and no accidental
success — **is not met.**

## What the three engine-reached members say

**The safety property held everywhere.** Across all three, DiffCI executed **zero** repository operations
it had not justified. The execution boundary was never breached; `assertBoundaryHonoured` never fired.

**The semantic layer did not.** In two of three, the engine planned against **the wrong job**:

- jest — chose `issues.yml#bug-without-repro`, an issue-closing workflow, and declared it executable
- webpack — chose `test.yml#runtimes-runtimedeno`, while all **31** instances of the job that actually
  runs the suite reported `provides: ["INSTALL"]`

Only eslint's refusal was both correct and about the right pipeline.

The single sharpest number in the sample: **webpack's reference arm ran 57,666 tests while DiffCI could
not recognise its integration job as providing TEST at all.**

## Defects found, none fixed during the sample

Engine (frozen throughout):

| | |
|---|---|
| 27 | vacuous executability — a path where every step will not run is reported executable |
| 28 | operation purpose from substring match; false TEST from a URL (jest) and a patch filename (webpack) |
| 29 | `UNRESOLVED` collapsed to `FALSE` at `infer.ts:223`, contradicting `expression.ts`'s stated invariant |
| 30 | requirement labels that do not describe what they check — `"a resolved package manager" := command.length > 0` |
| 31 | a compound `run:` line erases a job's TEST purpose entirely |
| — | capability gap: action inputs (`nick-fields/retry`) are never read |
| — | capability gap: cross-job artifact dependencies are not modelled |

Harness (fixed as found, because they corrupt measurement rather than being measured):

| | |
|---|---|
| 32 | R3 qualified an arm that exited 127 and never ran a suite |
| 33 | a missing toolchain charged to the repository instead of the environment |
| — | `countsOf` was jest-only, then ANSI-blind — twice validated against invented fixtures |
| — | output tail too small to diagnose a failure |

## Three findings that are not about DiffCI

1. **The canonical container is not a GitHub ubuntu runner.** It lacks `make`. Member 4 never reached the
   question.
2. **A pinned commit does not pin a pipeline.** Member 5's CI passed on 2026-08-04 and its suite fails
   today because `webpack@5` resolved to a version published 2026-09-01.
3. **R1–R4 never checked whether a candidate's pipeline is deterministic.** It should have, and any
   future sample must.

## Calibration — my predictions against results

Recorded because the estimates were stated publicly and should be scored:

- I called webpack and babel-loader "the realistic substrates for a first `REPRODUCED`". **Both failed**,
  and webpack failed badly — its real test job was never a candidate.
- I pre-registered three acceptable observations for babel from the frozen engine. **None was tested**;
  the engine never saw it.
- I called babel-loader "the cleanest pipeline in the sample and the only remaining candidate for a
  pristine `REPRODUCED`". It is the cleanest, and it still could not produce a stable reference arm.

The estimate of "~5–12 focused days to a whole-CI savings proof" rested on at least one member yielding a
tractable substrate. **None did.**

## What happens next, per the frozen terminal rule

Zero `REPRODUCED`, and the refusals were not all correct — so this is neither the "≥1 reproduced" branch
nor the clean "all refusals correct" branch. One member produced an `INCORRECT_REFUSAL` and one a
`DIVERGED`, both of which the frozen rule classifies as **engine defects to be fixed before any
optimisation claim**.

Repair order, frozen before any fixing began:

```
workflow evidence → semantic operations → causal dependencies → executability → purpose planning → receipts
```

Then re-run **these same five repositories** as the evaluation set — plus, now, a determinism check and
an adequate build environment, without which members 4 and 5 cannot answer the question at all.
