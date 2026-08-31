# Test-to-production connectivity across the frozen 40

`density-01`, canonical Linux container, 3m 42s. Frame `npm-high-impact@1.13.0` ranks 1–40 — the same
file the addressability survey used, so both describe the same forty repositories.

## The chain

```
40 frame entries
  →  3 excluded (already examined)
  →  8 ANALYZER_INELIGIBLE (no tsconfig.json)
  →  1 NO_TESTS_DISCOVERED
  →  0 failed
  →  28 measured
```

## Mapping-density bands, measured repositories only

| band | repositories |
|---|---:|
| 80–100% | **2** |
| 60–80% | 1 |
| 40–60% | 3 |
| 20–40% | 2 |
| **0–20%** | **20** |

`mappingDensity` = test nodes that can reach a non-test node through the static import graph, over test
nodes. **20 of 28 measured repositories sit under 20%.**

## The headline is real, but it is not one cause

**The 0% band conflates at least four distinct mechanisms, and at least two of them are DiffCI's
limitations rather than properties of the repository.** Reporting "20 of 28 repositories are
structurally unmappable" would blame repositories for gaps that are ours.

| mechanism | example | confirmed? | whose limitation |
|---|---|---|---|
| Tests import **nothing** — runner injected as a global through framework setup | `prettier`: 1,419 of 1,464 files, 7% import density | **confirmed** | repository architecture |
| Tests import a **build artifact absent from source** | `chai`: `import … from '../index.js'`, and `index.js` is generated, not committed | **confirmed** | repository architecture |
| Tests import their subject **by package name** | `react`: 2,406 tests, 48% import density, 13 edges total | indicated | **DiffCI** — workspace self-reference unresolved |
| **Monorepo** package layout | `typescript-eslint`: 308 tests, 100% import density, 0 production edges; `babel` likewise | indicated | **DiffCI** — already recorded as `MONOREPO_SCOPE_UNSUPPORTED` |

Rows three and four are the commercially important ones: they are **fixable**, and they cover much of
the band — react/react-dom (2 entries), babel (5), typescript-eslint (2), DefinitelyTyped (3).

## What was ruled out

**Basic module resolution is not the problem.** A synthetic probe confirms both modern TypeScript forms
resolve to the `.ts` source:

```
tests/math.test.ts   imports "../src/math.js"   (TS ESM convention)  →  ["src/math.ts"]
tests/math2.test.ts  imports "../src/math"      (extensionless)      →  ["src/math.ts"]
```

That was the first thing worth eliminating, and it is eliminated.

## Import density is not a proxy for mapping density

Measuring both was the right call, and the gap is the finding:

| repository | import density | mapping density |
|---|---:|---:|
| `chai` | 100% | 0% |
| `rollup` | 100% | 0% |
| `@typescript-eslint/*` | 100% | 0% |
| `webpack-cli` | 100% | 0% |
| `webpack` | 80% | 0% |
| `react` | 48% | 0% |
| `prettier` | 7% | 0% |

**Four repositories where every test file contains an import still map none of them to production
code.** A test importing its framework and a fixture is not a test connected to its subject.

## The repositories that do map

| repository | tests | import | mapping | test→production edges |
|---|---:|---:|---:|---:|
| `kentcdodds/cross-env` | 5 | 100% | **100%** | 9 |
| `kulshekhar/ts-jest` | 40 | 93% | **85%** | 77 |
| `TypeStrong/ts-node` | 29 | 97% | **76%** | 79 |
| `isaacs/rimraf` | 24 | 71% | 54% | 19 |
| `Microsoft/tslib` | 2 | 100% | 50% | 1 |
| `microsoft/TypeScript` | 14 | 100% | 43% | 13 |
| `jestjs/jest` | 1195 | 63% | 38% | 730 |
| `eslint/eslint` | 7 | 71% | 29% | 9 |

**`jestjs/jest` is the only large repository in the set with meaningful connectivity** — 1,195 tests,
38% mapping, 730 test→production edges. Everything else above 40% has fewer than 30 test files, which
matters: high density over 5 tests is not evidence of a workload worth optimising.

## What this does and does not establish

**Does:** on this frame, static test-to-production connectivity is low for most high-impact npm
packages, and the analyser-eligibility gate removes 8 of 40 before connectivity is even measurable.

**Does not:** that the low band is irreducible. Two of four mechanisms are DiffCI's own gaps, and
fixing workspace package-name resolution and monorepo scope would move an unknown but plausibly large
share of the 20.

**Does not:** anything about savings, recall or safety. This is a structural measurement only.

**Frame caveat, unchanged:** npm most-depended-upon skews toward old, small, single-purpose packages.
It describes this frame and no other.

## Flagged, not implemented

`SELECTIVE → 0` on a repository where almost no test is structurally mappable is arguably not a
trustworthy selective result, even when logically derived — graph incompleteness is itself evidence. An
applicability/confidence gate returning FULL or REFUSED in that situation deserves consideration. **No
threshold is proposed and nothing is implemented.** This survey is the input that would inform one.
