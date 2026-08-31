# MECHANISM_PROOF_01 — observation result

`tsjest-observe-01`, canonical Linux container, 67 seconds. Five sealed candidates from `07bc3d1`,
observed verbatim. **No mutation. No suite executed.**

## The stop gate is passed

```
SELECTIVE-nonempty:  4 of 5
```

| # | head | classification | selected/total | direct | **impact** | comparator | analysis CPU |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | `06c79d4ce` | SELECTIVE-nonempty | **7/40** | **0** | **7** | 40 | 1.84s |
| 2 | `394181875` | SELECTIVE-nonempty | 7/38 | 1 | 6 | 2 | 1.99s |
| 3 | `a82a2b32c` | SELECTIVE-nonempty | 7/38 | 1 | 6 | 2 | 1.81s |
| 4 | `8a8fd2fb8` | **FULL** | — | — | — | 1 | 1.86s |
| 5 | `96d025dd9` | SELECTIVE-nonempty | **2/38** | 1 | 1 | 38 | 1.77s |

**This is the first time in this programme that DiffCI has produced actionable selective work on an
externally selected repository under a sealed protocol.**

## Candidate 1 is the one that matters

`06c79d4c` changes **one implementation file and no test file**. Every one of its 7 selections was
therefore reached **through the dependency graph**, not because the test was edited:

```
src/index.spec.ts
src/legacy/compiler/ts-compiler.spec.ts
src/legacy/compiler/ts-jest-compiler.spec.ts
src/legacy/config/config-set.spec.ts
src/legacy/ts-jest-transformer.spec.ts
src/transformers/hoist-jest.spec.ts
src/utils/importer.spec.ts
```

`0 direct, 7 impact` is the split the pre-registration existed to preserve, and it lands on the side
that supports the mechanism. **The comparator selected all 40** on this candidate — it had no path-based
narrowing available at all, while DiffCI proposed 7.

Candidate 5 is the narrowest: **2 of 38**, one direct and one through impact.

## The FULL is correct, and worth reading

Candidate 4 returned FULL for a stated reason:

```
Unknown changed file: src/transformers/__snapshots__/hoist-jest.spec.ts.snap
```

The change touches a Jest **snapshot** file, which is not a node in the dependency graph. The analyser
declined to narrow rather than guess at what a file it cannot model might affect. That is the
conservative direction the safety policy is supposed to take, and it is recorded as a legitimate
outcome, not a failure.

## Where DiffCI beats the comparator, and where it does not

| candidate | DiffCI | comparator |
|---|---:|---:|
| 1 | **7** | 40 |
| 2 | 7 | **2** |
| 3 | 7 | **2** |
| 4 | 40 (FULL) | **1** |
| 5 | **2** | 38 |

**The comparator is narrower on candidates 2, 3 and 4.** This is not a clean sweep and must not be
reported as one: the path-rule baseline selects the co-located `.spec.ts` beside a changed source file,
which is cheap and often right. DiffCI's advantage appears where no such co-location exists — candidate
1, where the comparator fell back to all 40, and candidate 5, where it selected 38.

Whether DiffCI's broader selections on 2 and 3 are *justified* breadth or over-selection is **not
established by observation**. That is a recall question, and no mutation has run.

## Cost

Analysis is **1.77–1.99 CPU-seconds** per candidate against a full suite measured at **260.22 CPU-s**.
So the overhead is roughly **0.7% of one full run** — the first time in this programme the analysis cost
has been small relative to the workload it is trying to reduce, rather than several multiples of it.

## What this does and does not establish

**Does:** the mechanism produces non-empty, graph-derived selections on a real external repository,
cheaply. The stop condition is cleared, and mutation becomes a decision worth making.

**Does not:** that those selections are *safe*. Recall is unmeasured. A 7-of-40 selection that misses
the test which would have caught a regression is worse than useless, and nothing here rules that out.

**Does not:** any economics. `C_analysis + C_selected < C_full` needs the selected-suite execution,
which has not run.

**Does not:** anything about large repositories. ts-jest has 40 test files, and this was pre-registered
as an existence claim. It must not later be converted into evidence about scale.

## Status

Observation complete. **Mutation is a separate decision and has not been taken.**
