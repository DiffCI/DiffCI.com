# Post-sample invariants — written during the sample, applied only after it

**Nothing here is implemented yet, and nothing here may be implemented until all five members have run
on the frozen engine.** Recording the intended fix while the evidence is fresh is not the same as
applying it; applying it now would mean members 1–2 ran against a different engine from members 3–5 and
the distribution would stop being a distribution.

## The three defects stay separate

They are separate future invariants, not one bug with three symptoms.

### Defect 28 — semantic false positive

> Incidental tool-name text must not establish operation purpose.

A URL containing `jest` cannot make an issue-management command a TEST operation. Purpose has to come
from the command's structure — the executable and its arguments — not from a substring appearing anywhere
in the line, including inside prose passed as a `--comment` value.

### Defect 29 — three-valued logic violation

> `UNRESOLVED ≠ FALSE`, preserved from expression evaluation through planning and execution.

`expression.ts` already returns three values correctly. The violation is at every consumer that narrows
them to two. The fix is not local to `infer.ts:223`: the third value has to survive the whole path, or
some later consumer will re-collapse it the same way.

### Defect 27 — vacuous executability

> An execution path with zero operations that can execute cannot satisfy an outcome merely because
> `blocked.length === 0`.

And the stronger form, which is the invariant to actually implement:

```
Executable TEST plan  ⇒  at least one executable operation CAUSALLY PROVIDING TEST
```

Not merely a path *containing something classified as* TEST. The causal link is the load-bearing part:
the operation that makes the plan executable must be the one that produces the outcome being asked for.
A path that contains an install and a mislabelled comment satisfies the weak reading and not this one.

## A separate capability gap — not one of the three

jest's real TEST command exists inside `nick-fields/retry`'s `with:` inputs. Nothing in the engine reads
action inputs, so the command is invisible no matter how correct defects 27–29 become.

This is a **missing capability**, not a defect: the engine is not wrong about what it saw, it simply
never looked there. Keeping it distinct matters because the two have different fixes and different
risks.

### The expected consequence, stated before the fix

Fixing defect 28 removes the false-positive issue-closing job from jest's TEST candidates. Since the real
test job provides only `INSTALL` — its command being unreachable — jest will then have **no** TEST
provider, and `planForPurpose` will refuse.

**So the correct fix should turn jest from `DIVERGED` into `REFUSED`.** That is the desired direction and
must not be read as a regression:

> A refusal is preferable to manufacturing an executable plan.

Anyone comparing before-and-after will see a member move from "produced a plan" to "produced nothing",
which looks like a loss and is a gain. Written down now so that judgement is not made after the fact by
whoever is looking at a red diff.

Whether jest can ever reach `REPRODUCED` depends on the separate capability — understanding action-input
semantics — not on defects 27–29.

## What this is already saying about the product question

The bottleneck is becoming measurable: **DiffCI does not yet understand enough real CI semantics to
safely optimise a sufficiently broad sample.**

If the remaining three reproduce, they become the substrates for `CI_OPTIMIZATION_01`. If they do not,
the response is to fix the dominant semantic and addressability failures — **not** to manufacture a
savings experiment on a convenient repository.

---

# Added during member 3, before babel runs

## Amendment 4 contains an internal contradiction, and it is NOT being resolved by weakening it

Rule 2 says the producing job's steps run **in declaration order, all of them, no selective omission**.
babel's plan selectively omits `assert-dir-git-clean`. Recording that as a disclosed deviation made it
*transparent*; it did not make the reference arm *compliant*.

The rule stands. babel's evidence carries an explicit qualifier instead:

```
REFERENCE_DEVIATION — assert-dir-git-clean not reconstructed
                      because it cannot cross the current shell-safety boundary.
```

**babel cannot become pristine `REPRODUCED` evidence under Amendment 4.** The run can still be learned
from, but it may not be promoted to clean evidence. Relaxing rule 2 the first time it binds would make it
a rule that applies only when convenient, which is not a rule — and rule 2 exists precisely to prevent
selective reconstruction.

## Future invariant — artifact producers are part of the plan

```
Outcome plan includes every causal producer of consumed artifacts
```

Concretely:

```
TEST consumes artifact A
  → identify producing job
  → reconstruct producer
  → verify artifact receipt
  → transfer A
  → execute consumer
```

A TEST job **cannot be called executable** merely because its own commands resolve, when the filesystem
state it requires comes from an unresolved upstream job. This is the CI/CD-wide dependency graph the
product needs regardless; it is not a babel-specific feature.

## Future invariant — no credit from undeclared pre-existing state

```
A plan cannot earn reproduction credit from undeclared pre-existing state.
```

This guards a failure mode the frozen engine could still produce with babel: **accidentally succeeding**
because compiled output happens to be present locally, in a stale tree, or vendored in the repository.
Success must not erase a missing causal dependency. A plan that never modelled the producer and passed
anyway has not demonstrated it understood the pipeline — it has demonstrated it was lucky, and luck is
not a capability that transfers to a customer's runner.

So there are **three** acceptable observations from the frozen engine on babel, not two:

| observation | meaning |
|---|---|
| `CORRECT_REFUSAL` | it recognised the causal path is incomplete |
| `DIVERGED` | it asserted executability while ignoring the artifact producer |
| incorrect-plan category | it *succeeded accidentally* against pre-existing state — recorded as a defect, never as success |

## Future capability — artifacts get provenance, like commands

Artifacts should eventually carry the same evidentiary structure commands already do:

```
producer · digest · transfer mechanism · consumer · execution receipt
```

An artifact with no recorded producer is an unexplained input, and an unexplained input is exactly what
the execution-receipt discipline exists to eliminate. This becomes training evidence later as well.

## Still not implemented, still after the sample

None of the above touches the running engine. Members 3, 4 and 5 execute on the frozen engine, and only
once the five-member distribution is sealed do we decide which defects and capability gaps are
prerequisites to `CI_OPTIMIZATION_01`.

---

# Added after member 3 — the repair is architectural, not a feature list

webpack changed the diagnosis. The dominant blocker is **not** "support a few more GitHub Actions
constructs". It is the semantic layer that converts workflow syntax into causal operations.

## Defect 28 — regex over command text must lose its authority

Two independent external repositories produced the same failure:

```
incidental string contains a test-framework name  →  operation classified TEST
```

A URL in an issue comment (`github.com/jestjs/jest/…`) and a patch filename
(`test/patches/jest-worker+30.4.1.patch`). Both manufactured false TEST semantics.

**Regex-over-command-text should stop being an authority for operation purpose.** It may remain *weak
evidence*; it must not license a TEST decision on its own.

## Defect 31 — the inverse collapse

```
command cannot safely become argv  →  operation disappears  →  TEST semantics disappear
```

Another unknown-as-negative. The right representation is:

```
declared step  →  semantic purpose possibly TEST  →  execution representation UNRESOLVED
```

**not** `couldn't parse the command → no operation exists`. The step was declared; the repository says
what it is for. Failing to build argv is a statement about *our executor*, not about the pipeline.

## Defect 30 — receipt integrity

Requirements must be **structured predicates carrying evidence**, not human-readable labels living
apart from their implementation:

```
PACKAGE_MANAGER_RESOLVED → expected yarn → observed packageManager + lockfile → SATISFIED
```

A shape like that makes `"a resolved package manager": command.length > 0` hard to write in the first
place, because the predicate, its expectation and its observation would have to be stated together.

## Repair order — architecture, not features

```
workflow evidence → semantic operations → causal dependencies → executability → purpose planning → receipts
```

Explicitly **not** "implement every missing GitHub Actions feature". Cluster the failures, repair the
layers in that order, then re-run **the same five repositories** as an evaluation set.

## The threshold before CI_OPTIMIZATION_01 — stronger than before

> At least one external repository must reach genuine `REPRODUCED`, with **correct job purpose**,
> **complete causal path**, **truthful receipts**, **no human command repair**, and **no accidental
> success from omitted or unresolved state**. Ideally more than one.

## The concrete engineering target

webpack states the gap in one line: **the external reference pipeline ran 57,666 tests, while DiffCI
could not recognise its integration job as providing TEST at all.**

That is not a vague research problem. It is a measurable target.
