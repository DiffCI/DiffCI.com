# CI_REPRODUCTION_01 — attempt 1

`jantimon/html-webpack-plugin` @ `cf9c7012`. Protocol frozen at `263c534`, before execution.

## Outcome: **DIVERGED**

```
reference  npm ci --legacy-peer-deps           exit 0    26.2s
reference  npm run test:coverage -- --ci       exit 1   152.1s   151 tests, 4 files, 13 failures
inference  npm ci --legacy-peer-deps           exit 0    20.4s
inference  npm run lint                        exit 1    11.0s   no suite
```

> the engine claimed executability but its graph never runs the suite: reference executed a suite
> (151 tests in 4 files) and the inference arm executed none. **Install succeeded in both arms.**

This is the outcome the protocol predicted in advance, for the reason it named in advance.

## Checkpoint 1 passed, and it is the real result here

**`npm ci --legacy-peer-deps` exited 0 in both arms.** The historical `ERESOLVE` that made this
repository a Generation C RED is gone — recovered from repository evidence by inference, and now
**confirmed by execution** rather than by argument.

That is a genuine crossing: DiffCI automatically recovered an install command that generic derivation
could not produce, and the recovery executes.

**It is not reproduction**, and the protocol forbade scoring it as such. The pipeline the engine
described is the wrong one.

## Why it diverged

`primaryJob` scores a workflow job by how many recognised operations it runs. The **lint** job runs two
(`lint`, `security`); the **build** job runs one (`test:coverage`). So the engine described the lint
pipeline and never proposed a test step at all.

Recorded by inspection *before* execution (`263c534`), which is why this reads as a confirmed prediction
rather than a discovered excuse. It is the same defect already logged against `lint-staged`: **not wrong
about the command, wrong about what the pipeline is for.**

## A limitation that is mine, not the repository's

**Attempt 1 executed on the local Windows host — `node v24.16.0`, not the canonical Linux container.**

The workflow pins `node-version: lts/*` and begins with `git config --global core.autocrlf input`, so
this repository's suite is explicitly line-ending and runtime sensitive. The reference arm's **13
failures out of 151 tests are therefore not attributable to the repository**, and nothing here should be
read as "html-webpack-plugin's tests fail". They very likely reflect Node 24 and Windows.

What survives the platform question:

- `npm ci --legacy-peer-deps` succeeding — an install outcome, and it succeeded on the *harder* platform;
- the **DIVERGED** verdict, which turns only on the inference arm containing no test operation at all.

A canonical-environment run is needed before any claim about this repository's actual suite outcome. It
cannot change DIVERGED.

## Also declared before execution

The reference arm **omits** the build job's `npm i webpack@${{ matrix.webpack }} --legacy-peer-deps` step,
because matrix expansion is not modelled. The arm therefore reproduces one matrix cell's dependency state
rather than the matrix.

## One defect found in my own harness

The first commit of this harness went in with the test suite **red**: `ci-reproduction.ts` spawned with
`shell: true` without calling `assertShellSafeArgs`. The shell-invocation invariant caught it, and it was
right to — the inference arm's argv comes from workflow `run:` lines, which are repository-derived text,
the exact input that guard exists for and that this project has mishandled four times before. Fixed at
the spawn site, suite green, and recorded rather than quietly amended.

## Attempt 1 is preserved

No engine change has been made. The `primaryJob` defect is now understood precisely — a scoring rule that
prefers *quantity* of recognised operations over the *purpose* of the job — but fixing it and re-running
this row would produce a result that never had to survive being wrong.

Any fix is **iteration 2**, recorded as a separate attempt, with this row left standing as the attempt
that needed it.

## Where this leaves the arrow

```
repository evidence  →  ExecutionGraph  →  faithful executable CI
                                            ▲
                                            partially: install recovered and executes;
                                            the graph does not yet identify the pipeline's purpose
```

The next arrow (`faithful CI → minimum safe CI`) stays untouched. Nothing was optimised.
