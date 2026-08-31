# COMPUTE_PROOF_V1 — setup correction J1

```
COMPUTE_PROOF_V1 setup correction J1

Discovered after jest-qualify-01, before any DiffCI observation.

Observed failure:
  packages/jest-cli/build/index.js absent
  baseline exited after 49 ms  (cpu 0.05 s)
  no tests executed

Cause:
  registered corpus entry omitted Jest's required build step.

Independent evidence:
  repository defines a documented `build` script
    build: yarn build:js && yarn build:ts && yarn bundle:ts
  repository CI builds before tests
    .github/workflows/nodejs.yml:47  run: yarn build
  frozen corpus schema already supports `build`
  existing corpus entries use it for the same purpose
    colinhacks/zod  build: ["corepack","pnpm","build"]

Correction:
  add the documented Jest build command.

Classification:
  registration / harness setup defect;
  NOT a repository qualification failure.

Previous run:
  jest-qualify-01 retained, not overwritten.
```

## Why this is not the typescript-eslint case

The two failures are not equivalent, and the distinction is what keeps this from being an accommodation:

| | typescript-eslint | jest |
|---|---|---|
| install | **failed** — its own `postinstall` could not load 3 Nx plugins | succeeded, 35.8 s |
| what failed | the repository's own installation | our registration, which omitted a documented prerequisite |
| tests reached | none | none |
| verdict | **disqualified under the sealed rules** | **qualification was never exercised** |

Jest did not fail a test baseline. `49 ms`, `0.05` CPU-seconds and a missing `build/index.js` is proof
that nothing ran. Jest is self-hosting — `packages/jest-cli/bin/jest.js` requires `../build/index.js`,
which Jest's own build produces — so the registered environment never reached a runnable checkout.

The correction supplies an omitted piece of the repository's **documented environment reconstruction**,
which is the standard already applied to zod: documented scripts are environment reconstruction, not
accommodation. No Jest-specific behaviour is introduced.

## The frozen build semantics were checked, not changed

`scripts/dogfood-qualify.ts` runs:

```
clone → install → build (ONCE) → baseline 1 → baseline 2
```

The build is outside the baseline loop already. Nothing is cached, reused or optimised for Jest; the
existing order is simply followed. Had the semantics rebuilt per baseline, that is what would have run.

## The build must not enter the economics denominator

Recorded now, before any measurement exists, so it cannot be decided later in a convenient direction.

Jest's build is **necessary environment preparation** and is required identically by normal CI and by
DiffCI. It is therefore **not** savings attributable to test selection. The compute proof compares the
differential test path only:

```
C_analysis + C_selected-tests     vs     C_full-tests
```

with common unavoidable work — install, build — reported **separately** rather than folded in. If DiffCI
ever changes build compute, that is a different claim and does not belong in this one.

## What still closes V1

If the corrected run fails install or build, produces a non-green or dirty baseline, yields
contradictory execution evidence, or otherwise fails the existing criteria — **COMPUTE_PROOF_V1 closes
with its qualifying pool exhausted.** No third repository, no further accommodation, no lowering of the
≥100-test or ≥30%-mapping criteria.
