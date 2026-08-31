# COMPUTE_PROOF_V1 — pre-registration

**Frozen before any observation of the selected repository.** The rule, the thresholds, the tie-breaks,
the stop conditions and the report format are all fixed here.

```
COMPUTE_PROOF_V1

frame: density-02 (the frozen 40, measured after the C1 fix at 645c0eb)

eligibility:
  analyzerEligible              = true
  testFiles                    >= 100
  mappingDensity               >= 30%
  productionEdges              >= 100
  twoGreenBaselines             = required   (existing harness, canonical container)
  ordinaryImplementationChange  = required   (mechanically selected, see below)

selection:
  highest mappingDensity
  tie: testFiles descending
  tie: repository name ascending

DiffCI observation inspected before selection:
  NO
```

## Why 30%, and why it is not chosen to select anything

The threshold is set on reasoning, not on outcome: **below roughly one-third connectivity a static
test-impact analyser is operating with such incomplete structural information that the first proof
would be difficult to interpret.** A negative result under 30% could not be attributed — it would be
indistinguishable from the analyser simply not seeing the repository.

It is recorded here that 30% admits both serious candidates rather than isolating one. Setting it at,
say, 50% would have excluded Jest and left a single option, which is the shape of a threshold chosen for
its answer.

## Qualifying repositories under the frozen rule

From `density-02`, applied mechanically:

| repository | tests | mapping | edges | qualifies |
|---|---:|---:|---:|---|
| `typescript-eslint/typescript-eslint` | 308 | **99.7%** | 470 | ✔ |
| `jestjs/jest` | 1195 | 38.3% | 730 | ✔ |
| `kentcdodds/cross-env` | 5 | 100.0% | 9 | ✘ tests < 100, edges < 100 |
| `kulshekhar/ts-jest` | 40 | 85.0% | 77 | ✘ tests < 100, edges < 100 |
| `TypeStrong/ts-node` | 29 | 75.9% | 79 | ✘ tests < 100, edges < 100 |
| `isaacs/rimraf` | 24 | 54.2% | 19 | ✘ |
| `Microsoft/tslib` | 2 | 50.0% | 1 | ✘ |
| `microsoft/TypeScript` | 14 | 42.9% | 13 | ✘ |
| `eslint/eslint` | 7 | 28.6% | 9 | ✘ |

**Selection: `typescript-eslint/typescript-eslint`** — highest mapping density among qualifiers.

`jestjs/jest` is the pre-registered **second replication**, and its lower 38.3% connectivity is the
point: it tests whether savings survive incomplete but meaningful mapping. It is not run until this
experiment concludes.

## The baseline criterion is a gate, not an assumption

`twoGreenBaselines` is **required** and **not yet established** for typescript-eslint. The
addressability survey classified it `MONOREPO_SCOPE_UNSUPPORTED` at gate 1, on the structural heuristic
that a workspace config is present — but it also ships a root `vitest.config.mts`, so whether the
harness can run its suite from the clone root is an open question that a container run answers.

**If typescript-eslint cannot produce two green baselines, it fails eligibility and the rule selects
`jestjs/jest` instead.** That is a mechanical consequence of the frozen rule, not a substitution made
after seeing a result. It is written here so the fallback cannot later look like a choice.

## The change is selected mechanically too

Same filter as the Prettier candidate, unchanged (`scripts/select-source-candidate.ts`):

- modifies ≥1 ordinary implementation source file
- modifies no `package.json`, lockfile, tsconfig, runner config, or `.github/**`
- not dependency automation
- not test-only
- 1–5 implementation files
- **the first match in history order wins**

## Stop conditions, fixed in advance

The first observation may end the experiment. **No searching commits until one selects well.**

| observation | action |
|---|---|
| `REFUSED` or `FULL` | **stop.** Report the reason. Do not search other commits. |
| `SELECTIVE`, empty | **stop.** Investigate how 99.7% structural mapping collapses during impact analysis. |
| `SELECTIVE`, essentially everything | measure it, and **do not manufacture an economic win**. |
| `SELECTIVE`, meaningful reduction | proceed to full-vs-selected measurement, then mutation/recall. |

**One pre-registered repository, one mechanically selected change, one observation.**

## What counts as the proof

Two conditions, and no composite score:

```
economic:   C_analysis + C_selected  <  C_full
safety:     Outcome_selected  =  Outcome_full     (for the failure being tested)
```

No minimum percentage is required. A reduction that clears the inequality is the proof; its size is a
separate, reported fact.

## Report format, fixed

Raw measurements only — no HIGH/LOW, no grade:

```
full baseline compute          (CPU-seconds)
DiffCI analysis compute        (CPU-seconds)
selected-test compute          (CPU-seconds)
DiffCI total compute           (CPU-seconds)

gross reduction:  full -> DiffCI total
selected tests / total tests

full mutant outcome
selected mutant outcome
false green:  yes / no
```

**CPU-seconds is the primary compute metric; wall-clock is reported separately as an operational
metric.** Parallel execution can make a smaller amount of CPU work look similar in wall time, or the
reverse, so conflating them would let either hide the other.

## Standing constraints

- Resolver work stops here. C1 was worth fixing because it corrected an intended capability; the
  before/after also showed that hunting further resolver fixes to enlarge the pool is not warranted.
- C2 remains parked: React's Flow source outside any TS project, Jest `moduleNameMapper` relationships,
  Prettier globals, chai build artifacts.
- No other candidate's results are inspected unless this experiment says to continue.
