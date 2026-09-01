# CI_REPRODUCTION_05 — REFUSED, and correctly

Target: `eslint/eslint @ 2417cad5`, the first qualifier in rank order under the criteria frozen at
`01cae76`. The engine had never seen this repository before this run.

## Outcome

```
REFUSED — the engine did not mark the path executable, so the inference arm executed nothing:
1 operation(s) in the TEST path are not executable:
test_on_node-osubuntu-latest-node22.x-NODE_OPTIONS-install-0
  (a pinned dependency basis (lockfile or packageManager field))
```

**The refusal is correct on the facts.** Checked against the repository, not taken on trust:

| | |
|---|---|
| `package-lock.json` at the pinned head | **404 — not committed** |
| `packageManager` field in `package.json` | **absent** |
| the workflow's install step | `npm install` — not `npm ci` |

So `npm install` genuinely has no pinned dependency basis: it resolves against the registry at run time
and can produce a different tree on each execution. The engine declined to claim it could account for
that path. That is the hard boundary working — *incomplete causal execution path ⇒ refuse to optimise* —
firing on a real repository, on first exposure, without any per-repository patching.

**The execution boundary held.** `inferenceArm.steps` is empty and `assertBoundaryHonoured` passed. A
refused plan executed zero operations, which is exactly what attempt 2 violated.

## The reference arm, for contrast

| step | exit | wall | cpu |
|---|---|---|---|
| `npm install` | 0 | 58.9s | 52s |
| `node Makefile mocha` (`NODE_OPTIONS=""`) | 0 | 121.0s | 164s |

**38627 passing, 11 pending, 0 failing**, matching the CI ground truth (`Test (ubuntu-latest, 22.x)` =
`success`). The target is sound; the engine simply refused to plan against an unpinned basis.

## A parser defect, and how it was validated wrongly

`countsOf` reported `tests: undefined` for the mocha step even though I had added mocha support hours
earlier and tested it.

The mocha branch was written against a hand-typed `"  38627 passing"`. The real output is
`"\x1b[32m 38627 passing\x1b[0m"` — ANSI-wrapped — where a `^\s*` anchor cannot match. **The regex was
validated against my assumption rather than against reality**, and its test passed on a fixture I had
invented. `parseTestOutput` had been stripping ANSI since it was written, which is why *failures* parsed
and *counts* did not.

Fixed by stripping ANSI first. The regression test now uses the **byte-for-byte tail captured from this
run**, not a hand-typed approximation. No synthetic proof that the fix matters is needed: the deployed
code without it produced `tests: undefined` on exactly this output.

It changed no verdict here — `REFUSED` is decided before any suite comparison — but on a run that
reached the comparison it would have produced a **false `DIVERGED` against the engine**.

## What this run does and does not establish

**Does:** the engine's epistemic control is real and fires correctly on an unseen repository; the
execution boundary holds; the target selection protocol produced a sound target with genuine ground
truth and an adequate environment — everything attempt 4 lacked.

**Does not:** reproduction. `REFUSED` is a legitimate frozen outcome, not a reproduction.

Also **not** established: whether the engine distinguishes `DEFINED_EMPTY` from `UNDEFINED_CONTEXT` on
`matrix.NODE_OPTIONS`. I flagged before the run that agreeing commands would not confirm the
distinction — and in the event the inference arm never rendered a command at all, so this run says
nothing about it either way.

## The decision this forces, which I am not making quietly

Four more qualifiers remain: `jest` (6), `webpack` (8), `babel` (10), `babel-loader` (11).

Moving to `jest` *because we did not like `REFUSED`* would be target-shopping — running candidates until
DiffCI succeeds, which is precisely the tautology this protocol exists to prevent. The frozen rule said
"first qualifier in rank order"; it did not say what happens on a refusal.

The principled repair is to **pre-register the whole sample now**: commit, before seeing any further
result, to running all five qualifiers and reporting the full distribution of outcomes. Then a `REFUSED`
is a data point rather than a discard. That is a change to a frozen protocol and is the user's call, not
mine.
