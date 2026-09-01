# FROZEN — CI_REPRODUCTION_01

**Written before execution.** Subject: `jantimon/html-webpack-plugin` @ `cf9c7012` only. The other five
remain frozen as they are: `eslint-plugin-vue`, `jest-dom`, `vue-loader` refusals stay refusals;
`ant-design` is a resource-prediction problem; `lint-staged` is a semantic-operation problem.

## The question

We stop rewarding DiffCI for **describing** CI and require it to **reproduce** CI.

```
repository evidence  →  ExecutionGraph  →  faithful executable CI
```

Only once that arrow works do we ask the next one (`faithful CI → minimum safe CI`). **Nothing is
optimised here.**

## Two independently constructed arms

**Reference arm** — transcribed directly from `.github/workflows/main.yml`, the `build` job, by reading
the repository. It does not consult the inference engine.

```
npm ci --legacy-peer-deps
npm i webpack@<matrix.webpack> --legacy-peer-deps     ← see deviation below
npm run test:coverage -- --ci
```

**DiffCI inference arm** — generated *only* from the `ExecutionGraph` that INFERENCE_02 already produced
and froze. The engine is **not** modified before this run.

### A deviation in the reference arm, declared now

The `build` job's second step interpolates `${{ matrix.webpack }}`. Expanding a matrix is not something
this reproduction models, so the reference arm **omits that step** and tests against the webpack version
the lockfile pins. That makes the reference arm a faithful reproduction of *one* matrix cell's
dependency state, not of the matrix. Recorded as a known deviation rather than presented as equivalence.

## A defect found by inspection BEFORE execution

Reading the frozen graph, the inference arm contains:

```
checkout · install (npm ci --legacy-peer-deps) · lint (npm run lint) · security (npm run security)
```

**There is no test operation.** The engine selected the workflow's **`lint` job**, not its `build` job,
because `primaryJob` scores a job by how many recognised operations it runs — and the lint job runs two
(`lint`, `security`) against the build job's one (`test:coverage`).

So INFERENCE_02's `CORRECT_INFERENCE` for this repository was **partly luck**: the install command it
recovered, `npm ci --legacy-peer-deps`, is correct and appears in *both* jobs, but the pipeline the
engine described is the lint pipeline. This is the same defect already recorded against `lint-staged` —
*not wrong about the command, wrong about what the pipeline is for*.

This is recorded here, before execution, so it cannot later look like a post-hoc explanation of a poor
result. **The engine is not being fixed first.** Attempt 1 runs the graph exactly as INFERENCE_02 froze
it, because the point of a reproduction experiment is to find exactly this.

## Outcomes, frozen

| outcome | meaning |
|---|---|
| **REPRODUCED** | reference and inferred plans reach materially equivalent repository outcomes, no human repair |
| **PARTIAL_REPRODUCTION** | the known failure is avoided, but the causal execution path or outcome is not equivalent |
| **REFUSED** | new unresolved evidence encountered and execution correctly stops |
| **DIVERGED** | DiffCI claimed executability, and execution shows the inferred graph was wrong or incomplete |

**The first checkpoint** is whether `npm ci --legacy-peer-deps` actually eliminates the historical
`ERESOLVE`. That alone is **not** scored as reproduction: if install succeeds and the inferred path then
differs materially from reference CI, the reproduction is incomplete or incorrect.

Given the defect above, **I expect `DIVERGED`** — the inferred arm never runs the suite. Stating the
expectation in advance so the result cannot be reframed afterwards.

## Receipts compared

Command sequence · working directory · Node and package-manager context · environment · prerequisites ·
exit status · suite and test counts · CPU and wall time · artifacts · `outcome.layer`.

## Attempt 1 is preserved regardless

No engine change may be made after seeing this execution and then re-run as though it were the original
result. Any fix becomes INFERENCE/REPRODUCTION **iteration 2**, recorded as a separate attempt. This is
the discipline the learning dataset depends on: an attempt that was corrected must remain visible as an
attempt that needed correcting.
