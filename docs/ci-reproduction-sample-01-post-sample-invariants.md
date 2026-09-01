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
