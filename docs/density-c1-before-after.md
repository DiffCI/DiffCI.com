# Coverage gained through resolver correctness alone

`density-01` (analyser `a20b77d`) against `density-02` (analyser `645c0eb`). **Same frozen 40, same
exclusions, same density calculation, no threshold changes.** The only difference is the C1 fix.

## Chain — unchanged, as it should be

| | before | after |
|---|---:|---:|
| frame entries | 40 | 40 |
| excluded | 3 | 3 |
| analyzer-ineligible | 8 | 8 |
| no tests discovered | 1 | 1 |
| failed | 0 | 0 |
| **measured** | **28** | **28** |

C1 touches graph construction, not eligibility, so nothing moved across the gates. Correct.

## Bands

| band | before | after |
|---|---:|---:|
| 80–100% | 2 | **4** |
| 60–80% | 1 | 1 |
| 40–60% | 3 | 3 |
| 20–40% | 2 | 2 |
| **0–20%** | **20** | **18** |

**Two of the twenty moved, and both are the same repository** (`typescript-eslint`, entered twice as
`@typescript-eslint/eslint-plugin` and `@typescript-eslint/parser`). In distinct-repository terms:
**one repository moved, from 0% to 99.7%.**

## The seven potentially affected entries, measured

| rank | package | repository | nodes before/after | non-test before/after | mapping before → after |
|---:|---|---|---|---|---|
| 23 | `@typescript-eslint/eslint-plugin` | typescript-eslint | 310 → **1389** | 2 → **1081** | 0% → **99.7%** |
| 24 | `@typescript-eslint/parser` | typescript-eslint | 310 → **1389** | 2 → **1081** | 0% → **99.7%** |
| 10 | `@babel/core` | babel | 511 → 623 | 491 → 603 | 0% → **0%** |
| 17 | `@babel/preset-env` | babel | 511 → 623 | 491 → 603 | 0% → **0%** |
| 19 | `babel-core` | babel | 511 → 623 | 491 → 603 | 0% → **0%** |
| 35 | `babel-cli` | babel | 511 → 623 | 491 → 603 | 0% → **0%** |
| 39 | `babel-preset-es2015` | babel | 511 → 623 | 491 → 603 | 0% → **0%** |

One further row changed that was not on the predicted list: **`webpack`**, 1083 → 1085 nodes, 902 → 904
non-test, mapping unchanged at 0%. Two files, no effect.

## Source coverage moved; connectivity mostly did not

This is the distinction that matters, and the data separates it cleanly:

- **typescript-eslint** — source coverage went from 2 non-test nodes to 1,081, and connectivity followed:
  **99.7%**, 470 test→production edges. Both first-order and downstream effects landed.
- **babel** — source coverage rose (491 → 603 non-test nodes, +23%) and connectivity **did not move at
  all**. This is exactly the *"TS project completeness ≠ test→production connectivity"* case.

Babel's cause is separate and was not touched: it discovers only **20 tests**, because its root
`include` covers `packages/*/test/*.tst.ts` while its real tests are plain JavaScript. Adding sources
cannot connect tests that are not in the graph.

## What C1 bought, stated plainly

**One repository of the twenty in the 0% band.** The honest pre-estimate was "up to 7 frame entries,
actual gain unknown"; the realised gain is **7 entries examined, 2 entries / 1 repository moved.**

That is a real correction — typescript-eslint went from an unusable graph to a fully connected one, and
the measurement was contaminated before — but it does **not** widen the applicable population much.

## The updated picture

| repository | tests | mapping | test→production edges |
|---|---:|---:|---:|
| `kentcdodds/cross-env` | 5 | 100.0% | 9 |
| **`typescript-eslint`** | **308** | **99.7%** | **470** |
| `kulshekhar/ts-jest` | 40 | 85.0% | 77 |
| `TypeStrong/ts-node` | 29 | 75.9% | 79 |
| `isaacs/rimraf` | 24 | 54.2% | 19 |
| `Microsoft/tslib` | 2 | 50.0% | 1 |
| `microsoft/TypeScript` | 14 | 42.9% | 13 |
| `jestjs/jest` | 1195 | 38.3% | 730 |
| `eslint/eslint` | 7 | 28.6% | 9 |

**The candidate pool for a compute proof went from one substantial repository to two.** `jestjs/jest`
(1,195 tests, 38.3%, 730 edges) and now `typescript-eslint` (308 tests, 99.7%, 470 edges). Everything
else above 40% has fewer than 30 test files.

## Cost, recorded and not acted on

Graph construction got slower — locally, typescript-eslint 10.2 s and babel 12.9 s. The survey's total
was 210 s before and 213 s after, so at survey scale the difference is negligible; the per-repository
cost is where it shows. **Not optimised**, by instruction: a more complete graph becoming expensive is a
separate finding.

## What this does not say

Nothing about savings, recall or safety. Mapping density is a structural precondition, not a prediction
that selection will be non-empty or useful. `typescript-eslint` at 99.7% has not been observed once.
