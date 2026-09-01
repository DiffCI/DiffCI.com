# GENERATION_C_01 — mutation result

Run `genc-mutate-02`. Protocol frozen at `517baea`'s parent, **before any mutation result existed**.
Target sealed at `b6f1bda`, before any DiffCI output existed.

```
repository  jest-community/eslint-plugin-jest @ c7bf004e
target      3629019d8 .. 58e487fec   (sealed, index 0 of 5)
mutation    revert src/rules/prefer-to-have-been-called.ts to its base content
apparatus   generation C, agent sha512-eQGRE3ep…
```

## The three arms

| arm | files | detected the defect? | CPU |
|---|---|---|---|
| full suite | 174 | **YES** | 84.59 s |
| path-rule comparator | 164 | **YES** | 77.97 s |
| **DiffCI** | **2** | **YES** | 3.60 s |

**`RECALL_CONFIRMED`. No false green.** DiffCI's 2-file selection caught a defect the full suite catches.
Of its 2 selected files, **1 detected** the mutation.

## The prediction I wrote before the run was correct

The frozen protocol said, in advance:

> DiffCI selected the changed test file. The mutation reverts the implementation that this very test
> exercises. So the DiffCI arm will almost certainly detect it — **and so will the comparator**. If that
> is what happens, the honest result is: safe selection, no unique mechanism advantage on this target.

That is exactly what happened. **The comparator caught it too.** On *detection*, DiffCI demonstrated no
advantage over a path rule on this candidate.

## But on COST the picture is different, and this is the real finding

```
incremental vs comparator = 77.23 − (3.60 + 2.15) = +71.48 CPU-s
gross versus FULL         = 84.59 − 5.75          = +78.84 CPU-s
comparator ÷ DiffCI                                =  13.4×
```

Same detection outcome, **13.4× less compute**. Joint analysis (2.15 CPU-s) is charged entirely to
DiffCI, as always. Install (15.0 s wall) is common unavoidable work and is **not** counted as a saving.

This is the first measured incremental saving in this project on a repository **drawn blind** from a
third-party ordering, against a target sealed before any DiffCI output, with recall confirmed by
mutation in the same run.

## The caveat that keeps this honest

**The graph contributed nothing.** Both selected files are files the commit touched — 2 `DIRECT_CHANGED`,
0 `GRAPH_REACHED`. A trivial "run only the files this commit changed" selector would have produced the
identical 2 files, the identical detection, and the identical 3.60 CPU-s.

So the 71.48 CPU-s is a win **over DiffCI's own path-rule comparator**, which selected 164 of 174 files
here — not over a naive changed-files rule, which would have tied exactly.

Why the comparator is so wide on this repository: `jest-runner-eslint` lints every `.js`/`.ts` file, so
the test universe is all 174 source files, and a path-similarity rule expands enormously. That is a real
property of the repository, and it is also what makes the comparator weak here.

**Stated plainly: this measures narrowness, not intelligence.** The saving is real and measured; the
mechanism that produced it is not the dependency graph.

## What this establishes and does not

**Establishes**, on one blind-drawn external repository, one sealed target, one mutation:

- a selective decision that was safe (`RECALL_CONFIRMED`, no false green);
- 71.48 CPU-s incremental against the comparator, measured within a single run;
- the whole chain — population, draw, candidate universe, target, protocol — sealed before any DiffCI
  output, with the apparatus guard proven to have executed.

**Does not establish:**

- **any value from dependency analysis** — 0 graph-reached selections;
- superiority over a trivial changed-file selector, which would have matched it exactly;
- generality — n = 1 mutation, on 1 candidate, in 1 repository;
- that the comparator is a fair opponent on repositories where a path rule behaves better.

## What I would test next, and why not now

The open question is whether the graph ever earns its cost. Candidates **3 and 5** in the sealed universe
change no test file, so a selection for them must be graph-reached or empty — the only shape that can
answer it. They were **not drawn and are not substituted**; doing so now would spend the sealed draw's
value to get a more interesting answer.

The clean way to ask is a new sealed experiment whose target rule draws from candidates that edit no
test file — declared as such **before** drawing, not selected after seeing this result.
