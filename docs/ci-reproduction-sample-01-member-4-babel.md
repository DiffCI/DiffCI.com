# Sample member 4 — `babel/babel` @ `3fbcec1cc` — **ENVIRONMENT_INADEQUATE**

```
R3_FAILED — the reference arm hit environment signals: toolchain missing

exit   0   0.1s   layer=repository   corepack enable
exit   0  36.5s   layer=repository   yarn install
exit 127   0.0s   layer=environment  make -j build-standalone-ci   ["toolchain missing"]
```

babel's build is driven by a `Makefile`. GitHub's `ubuntu-latest` runner ships `make`; the canonical
container does not. The arm stopped at step 3 of 9.

## This is not a DiffCI result

**The engine never saw babel.** R3 is a gate that runs the reference arm alone, so the run ended before
any inference happened. Member 4 occupies a slot in the denominator and says **nothing whatever** about
DiffCI's capability.

The pre-registered prediction for babel — `CORRECT_REFUSAL`, `DIVERGED`, or accidental success against
pre-existing state — was therefore **never tested**. It is not confirmed and not refuted, and recording
it as either would be false.

## Why `make` was not installed

Amendment 2 permits standing in for a `uses:` setup action only when *the tool ships with the pinned
runtime or the container image*. `make` ships with neither. Installing it would be fetching a new tool
mid-sample — outside the amendment, and an environment change during a frozen sample.

So the honest outcome is the one the vocabulary already has. `ENVIRONMENT_INADEQUATE` states exactly
what happened: this environment cannot run babel's build.

## What it does contribute

A real constraint on the evaluation environment, discovered by running rather than by assuming: **the
canonical container is not a substitute for a GitHub ubuntu runner.** It has node and corepack; it does
not have the build toolchain a large fraction of real repositories assume.

That is an infrastructure prerequisite for the post-sample work, and it belongs on the same list as the
engine defects — a repository whose build needs `make`, `python`, or a compiler cannot even reach the
question this sample exists to ask.

## Carried forward unchanged

babel's reference plan still carries `REFERENCE_DEVIATION` (assert-dir-git-clean not reconstructed). That
qualifier is now moot for this run — the arm never got far enough for it to matter — but it stays on the
plan, because the plan is what would be re-used if babel is re-run in an adequate environment later.

## Running distribution

| # | repository | outcome | engine reached? |
|---|---|---|---|
| 1 | eslint | `CORRECT_REFUSAL` | yes |
| 2 | jest | `DIVERGED` | yes |
| 3 | webpack | `INCORRECT_REFUSAL` | yes |
| 4 | babel | `ENVIRONMENT_INADEQUATE` | **no** |
| 5 | babel-loader | pending | — |

**0 of 3 engine-reached members reproduced.**
