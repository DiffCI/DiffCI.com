# GENERATION_C_01 — observation of the sealed target

Run `genc-observe-01`. Manifest bundle `9e17e314…`. Target sealed at `b6f1bda`, **before** any DiffCI
output existed.

```
repository   jest-community/eslint-plugin-jest @ c7bf004e
pair         3629019d8 .. 58e487fec
subject      fix(prefer-to-have-been-called): don't crash on matcher without an argument (#2016)
changed      src/rules/prefer-to-have-been-called.ts
             src/rules/__tests__/prefer-to-have-been-called.test.ts
```

## The result as measured

| | |
|---|---|
| classification | `SELECTIVE-nonempty` |
| decision | `OBSERVED` · mode `SELECTIVE` · `SAFE_TO_PROPOSE` |
| selected / universe | **2 / 174** |
| path-rule comparator | **164 / 174** |
| graph | 176 nodes, 250 edges, confidence `COMPLETE` |
| analysis cost | 2.80 CPU-s, 1592 ms wall |
| apparatus guard | `declared: true, executed: true, PASS` |
| receipt layer | `REPOSITORY` |

Selected:

```
src/rules/__tests__/prefer-to-have-been-called.test.ts
src/rules/prefer-to-have-been-called.ts
```

## The headline is NOT 2/174

**Both selected entries are files this commit changed. Nothing was reached through the dependency
graph.** A trivial "run the files this commit touched" rule would have produced the identical selection.

So on this candidate the graph contributed **nothing measurable**. The 2-versus-164 gap is real and
large, but it is a gap against DiffCI's own path-rule comparator, not evidence that dependency analysis
did any work here.

### A correction to my own field

The corpus row reports `selectedThroughProductionImpact: 1`, and that number is **misleading**. It
classifies any selected path not listed in `changedTestFiles` as graph-derived — and
`prefer-to-have-been-called.ts` is not a changed *test* file, so it was counted as impact. It is a
changed *implementation* file: directly changed, not reached.

The correct split for this candidate is **2 direct, 0 graph-derived.** The frozen row is left exactly as
emitted; this is recorded as an interpretation defect in the classifier, not edited away.

The classifier was written against ts-jest, where implementation files are never test files. Here they
are, which is the next point.

## Why the universe is 174, and why that is right

`jest.config.ts` declares two projects:

- a **`test`** project (jest defaults, minus `lib/`, fixtures and test-utils);
- a **`lint`** project using `jest-runner-eslint` with `testMatch: ['<rootDir>/**/*.{js,ts}']`.

174 is **exactly** the count of tracked `.js`/`.ts` files at this tree — verified independently:
75 are `__tests__/*.test.ts`, 80 are `src/rules/*.ts` implementation files, the rest config and support.

So under this repository's own configuration **every source file genuinely is a test**, because
`jest-runner-eslint` lints it as one. DiffCI selecting the changed implementation file is correct
behaviour, not over-selection: that file *is* executed by the lint project.

This is the defect-17 fix doing its job. Generation B would have reported a universe of test-suffixed
files only and would have modelled this repository wrongly.

## What this observation does and does not establish

**Does:** DiffCI produced a safe-to-propose selective decision on a repository drawn at random from a
third-party ordering, under a target sealed before any DiffCI output existed, in 2.80 CPU-s. The
apparatus guard is proven to have executed. The universe matches the runner's own configuration.

**Does not:** show the dependency graph contributing anything on this candidate — both selections are
direct. It measures no compute saving, because nothing was executed. And it says nothing about recall:
whether these 2 files would catch a regression in `prefer-to-have-been-called.ts` is a mutation
question, not an observation one.

**Not run:** mutation, economics arms, suite execution. The other four candidates remain unobserved.

## The obvious next question, and its trap

The natural follow-up is whether 2 files detect a defect that 164 would. That is a mutation experiment
and needs its own protocol frozen **before** it runs.

Worth stating now, before any mutation result exists: on this candidate DiffCI selects the changed test
alongside the changed implementation, so a mutation that reverts the implementation would almost
certainly be caught — and that would demonstrate very little, because the *comparator and any path rule
would catch it too*. Candidates 3 and 5 in the sealed universe, which change no test file, are where the
graph would actually be under test. They were not drawn, and are not substituted now.
