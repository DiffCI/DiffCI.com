# FROZEN — SEMANTIC_REPAIR_01

**Written before a single line of the repair.** The predictions below are recorded now because after the
repair I would be grading my own work against the same five repositories I fixed against.

## The architecture

```
Workflow syntax
  → Declared steps
    → Semantic operation candidates
      → Causal inputs / outputs
        → Executable representation
          → Outcome-purpose graph
            → Plan
```

**The load-bearing rule: failure at one layer must not erase knowledge established by an earlier one.**

Every defect in the sample was a violation of it:

| observed | must not imply | must not imply |
|---|---|---|
| compound shell command cannot become safe argv | the step does not exist | the job does not provide TEST |
| the `if:` condition is `UNRESOLVED` | the condition is `FALSE` | the step will not run |
| `"jest"` appears somewhere in the text | this is a TEST operation | — |
| every step in a path will not run | the path is executable | — |

A layer may only ever *add* uncertainty markers to what an earlier layer established. It may never
delete the earlier layer's finding.

## No repository-specific fixes

Not "handle `nick-fields/retry`", not "special-case `cover:integration`". Each repair must be a rule
about GitHub Actions semantics or about causal representation, justifiable without naming a repository.

## Two infrastructure prerequisites

**1. Environment equivalence.** The canonical container must be a sufficient substitute for the runner
being reproduced. Member 4 died on a missing `make`. The container needs the build toolchain a GitHub
`ubuntu-latest` runner provides, and the gap must be *stated* rather than discovered per repository.

**2. A historical determinism gate**, as a first-class distinction:

```
SOURCE_PINNED  ≠  EXECUTION_ENVIRONMENT_PINNED
```

A commit SHA pins source. It does not pin the dependency graph. Member 5's pinned commit installed a
floating `webpack@5` that today resolves to a version published 28 days later.

This is **not only an experiment gate**. Dependency reproducibility should become an input to DiffCI's
own confidence and refusal: a pipeline whose inputs are not pinned cannot be promised a stable outcome,
by DiffCI or by anyone.

## Pre-registered expected movements — frozen before any repair

| repository | from | expected after | what it tests |
|---|---|---|---|
| eslint | `CORRECT_REFUSAL` | **`CORRECT_REFUSAL`** | regression test for epistemic control — this must NOT move |
| jest | `DIVERGED` | `REFUSED` or `REPRODUCED` | never another executable fake TEST plan |
| webpack | `INCORRECT_REFUSAL` | `REFUSED` or `REPRODUCED` | the integration suite must become semantically visible |
| babel | `ENVIRONMENT_INADEQUATE` | qualification becomes *possible* | infrastructure, not engine |
| babel-loader | `REFERENCE_NON_DETERMINISTIC` | reproducible state established, **or** historical reproduction correctly declared unavailable | determinism gate |

**Failure conditions, stated in advance so they cannot be reinterpreted later:**

- eslint moving off `CORRECT_REFUSAL` is a **regression**, not progress — it would mean the repair
  loosened epistemic control while fixing recognition.
- jest or webpack reaching `REPRODUCED` via a plan that still names the wrong job is a **worse** result
  than refusal, however good the label looks.
- any member reaching `REPRODUCED` without a complete causal path is an **accidental success**, recorded
  as a defect under the invariant already frozen.

## The caveat that must travel with every future number

After repairing against these five, **they are no longer out-of-sample.** Improvement on them is
**regression evidence**, not evidence of generalisation. The five became training data the moment their
failures drove the design.

A claim that DiffCI understands external CI in general requires a **fresh sample, drawn under the same
frozen procedure, never inspected during the repair.** That draw is not authorised here and must not be
folded into this work.

Saying this now costs nothing. Saying it after a clean five-for-five would look like hedging.

## Sequence

```
semantic repair
  → adequate environment + determinism gate
    → same-five rerun
      → ≥1 genuine REPRODUCED
        → CI_OPTIMIZATION_01
          → same outcome with less compute
```

`CI_OPTIMIZATION_01` does not begin until the fourth step. The sample never reached the question "can
DiffCI reduce whole-CI compute?" — it established that faithfully understanding and reproducing external
CI is itself the product problem.
