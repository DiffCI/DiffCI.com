# FROZEN — the generation-C eligible population

**Five repositories. Step 5.2 complete. Nothing drawn.**

## The population

| # | rank | repository | pinned tree | green baseline |
|---|---|---|---|---|
| 1 | 62 | `eslint-community/eslint-plugin-promise` | `e73585ef` | 18 suites, 564 tests |
| 2 | 75 | `webpack/postcss-loader` | `ed3e1f75` | 9 suites, 136 tests, 258 snapshots |
| 3 | 112 | `ezolenko/rollup-plugin-typescript2` | `4cff90bb` | 11 suites, 44 tests |
| 4 | 115 | `webpack-contrib/extract-text-webpack-plugin` | `bc6f9f8f` | 5 suites, 40 tests, 27 snapshots |
| 5 | 153 | `jest-community/eslint-plugin-jest` | `c7bf004e` | 240 suites, 4809 tests |

Each qualified GREEN on **two consecutive runs, exit 0, zero parsed failures**, in the canonical
environment under the generation-C apparatus, with commands derived mechanically from the repository's
own manifest.

## The complete funnel, every attempt retained

```
FRAME  npm-high-impact@1.13.0 topDependent (published 2026-06-08, external)

  ranks   1-40    40 entries →  6 E1 → 1 RED + 5 already measured →  0 eligible   EXHAUSTED
  ranks  41-140  100 entries → 10 E1 → 10 E3 → 10 E2 attempted    →  4 GREEN
  ranks 141-240  100 entries → 18 E1 → 18 E3 →  1 E2 attempted    →  1 GREEN      STOPPED AT N=5
```

### E2 verdicts, ranks 41–140

| rank | repository | outcome | reason |
|---|---|---|---|
| 46 | `lint-staged` | **RED** | 2 tests failing on both runs (2, 2). 75/77 files green. |
| 58 | `html-webpack-plugin` | **RED** | install `ERESOLVE` at 1.5s |
| 62 | `eslint-plugin-promise` | **GREEN 1** | |
| 75 | `postcss-loader` | **GREEN 2** | |
| 80 | `eslint-plugin-vue` | **RED** | install crash, no lockfile → `npm install` fallback |
| 112 | `rollup-plugin-typescript2` | **GREEN 3** | |
| 115 | `extract-text-webpack-plugin` | **GREEN 4** | |
| 116 | `jest-dom` | **RED** | `CONTRADICTORY_EXECUTION_EVIDENCE` — exit 1, 8 files failed, no tests ran |
| 119 | `ant-design` | **RED** | build OOM after 235s install |
| 120 | `vue-loader` | **RED** | 5 tests failing on both runs (5, 5) |

### E2 verdicts, ranks 141–240

| rank | repository | outcome |
|---|---|---|
| 153 | `eslint-plugin-jest` | **GREEN 5 — traversal stopped here** |

Ranks 160, 165, 176, 178, 188, 189, 191, 195, 196, 197, 209, 211, 224, 225, 229, 236 and 240 passed E1
and E3 and were **never qualified**. They remain unseen beyond addressability.

### Non-verdicts, retained rather than converted

| run | rank | label | why it is not RED |
|---|---|---|---|
| `e2-01` | 46 | `UNREGISTERED` | the registry had no entry — an apparatus gap |
| `e2-09` | 116 | `INFRASTRUCTURE` | platform updating the sandbox runtime |
| `e2-10` | 116 | `INFRASTRUCTURE` | container stopped while the operation was pending |
| `e2-11` | 116 | `INFRASTRUCTURE` | same |
| `e2-12` | 116 | `INFRASTRUCTURE` | same — receipt layer `INFRASTRUCTURE`, guard `NOT_REACHED` |

`jest-dom` accumulated **four** infrastructure failures before its single repository verdict. No
retry-count exclusion exists, and none was added: `unknown ≠ negative`.

## What this population is, and is not

**Is:** five repositories reached by traversing a third-party ordering published before this experiment
existed, under criteria frozen before the traversal, with every exclusion recorded and reproducible.

**Is not** selected for anything about DiffCI. No mapping density, test cost, selection size or commit
history was inspected. **No DiffCI observation, selection, mutation or density analysis has been run on
any of the five.**

## A finding this produced, deliberately not acted on

**Five of the six REDs in the first window failed before producing any test result** — `ERESOLVE`, an
arborist crash, a wrapper-script mismatch (`kcd-scripts test` versus a derived direct vitest call), and
a build OOM. Only `lint-staged` and `vue-loader` failed on genuine test outcomes.

Repository reproduction, not selection intelligence, is currently the binding constraint. Those RED
cases are worked examples of real CI configuration diverging from generic command derivation, each with
a derivation record showing exactly what evidence produced the wrong command — material for a future
environment/command inference system, kept rather than repaired.

## Next

Step 5.3, the reproducible random draw. **Not performed.**
