# Product finding — test count is the wrong optimisation target

From the MECHANISM_PROOF_01 mutation result. **Recorded, not acted on:** changing the selector to use
this would contaminate the evidence it came from.

## The observation

```
candidate 2, comparator:  2 test files  ->  246.82 CPU-s
candidate 5, DiffCI:      2 test files  ->   46.72 CPU-s
```

Identical selection size, **5.3x the cost.** On this repository `src/legacy/compiler/ts-compiler.spec.ts`
is most of the suite's cost by itself. Selecting it costs nearly a full run no matter how much else is
pruned; avoiding it is where candidate 5's entire +213.20 CPU-s saving comes from.

A selector that cuts 20 test files to 2 can still be economically worthless if one of those 2 is the
expensive one. **Reducing test count is not equivalent to reducing compute**, and this project has been
treating the first as a proxy for the second.

## The direction it implies

DiffCI is dependency-aware. It should also become **cost-aware**:

- The graph answers *which tests could matter* — a safety question, and it must stay the gate.
- Historical per-test cost answers *what a safe selection is worth* — an economics question.

Cost must never widen a selection below what safety requires. It informs whether a safe selection is
worth proposing at all, and which safe alternative to prefer.

## The commercial thesis this sharpens

> DiffCI saves CI compute where dependency-aware selection can safely avoid **expensive** tests that
> coarse path heuristics cannot exclude.

Not "where it selects fewer tests." Candidates 2 and 3 selected few tests and still lost to the
comparator, because what they selected was expensive.

**Untested.** It rests on candidate 5, n=1. The open question is whether that is a repeatable class of
workload or a property of one repository, and the honest answer today is that this is unknown.

## What must NOT happen next

Collecting repositories until the percentages look good. The test is whether candidate 5's shape
repeats on independently selected repositories under the same hostile discipline — and a finding that
it does not repeat is a real result, not a failed run.
