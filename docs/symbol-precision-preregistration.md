# Pre-registration: does symbol precision through barrel re-exports have economic upside?

**Written before the diagnostic exists and before any result. Nothing here has been run.**

A new experiment, separate from the Vue bucket investigation, which is closed at `8f7261f`. The
existing selector and the frozen Vue economics (`−1163.33` CPU-s incremental,
`2026-08-30T08-01-32-113Z-vuejs-core-9f5cf3`) remain untouched as the baseline.

## What this decides

Whether symbol-aware re-export resolution has **enough economic upside to justify building it**. It is
not a decision to build it, and it produces no selector change.

The mechanism is established: Vue's over-selection is barrel-mediated file-level closure, with every
edge real. The open question is whether removing that imprecision would actually recover meaningful
compute, or whether most barrel-reached tests genuinely depend on the changed symbol anyway.

## The question, narrowed

> Of the tests reached **through a barrel**, how many actually consume a symbol whose dependency chain
> includes the changed exported symbol?

## Classification, with the conservative direction fixed in advance

Each barrel-reached selection is classified:

```
selected through barrel
  ├─ symbol dependency DEMONSTRATED   the test's usage traces to the changed export
  ├─ symbol dependency ABSENT         no usage path to the changed export could be constructed
  └─ UNRESOLVED / AMBIGUOUS           dynamic access, re-export chains, type-only, wildcard, etc.
```

**UNRESOLVED STAYS SELECTED.** That is the whole point of the classification: it makes the result a
*conservative upper bound* on safely removable barrel-induced work, and it means the estimate cannot
overstate the opportunity by quietly assuming away what the analysis could not resolve. Fail-closed
behaviour is preserved in the estimate exactly as it is in the selector.

The reportable quantity is therefore:

```
removableUpperBound = Σ CPU of selections classified ABSENT
```

Never `ABSENT + UNRESOLVED`.

## First case, and why

`ef82a2677` — `packages/shared/src/looseEqual.ts`, 183 of 196 files selected, 125.34 CPU-s, 100% of
chains via `shared/src/index.ts`. It is the strongest falsification opportunity because it is the most
extreme case: if symbol precision cannot help here, it is unlikely to rescue Vue anywhere.

## Interpretation thresholds, fixed now

- **~160+ of 183 remain DEMONSTRATED or UNRESOLVED** → symbol precision probably cannot rescue Vue's
  economics. The topology, not the granularity, is the binding constraint. That would strengthen the
  eligibility-gate direction over the build-it direction.
- **Only ~20–40 DEMONSTRATED, most ABSENT** → a potentially large source of additionality, and symbol
  precision becomes a serious product candidate.
- **Mostly UNRESOLVED** → the diagnostic itself is too weak to answer the question, and the honest
  report is that the experiment failed rather than that the opportunity is small.

## Method constraints

- **Offline diagnostic only.** No production selector change, no agent generation C, no modification to
  how anything is selected.
- The frozen Vue economics are the baseline and are not re-run.
- Same pinned commit, same environment discipline, same freeze-then-interpret order.
- If the diagnostic cannot construct a usage path for a case, that case is UNRESOLVED — never ABSENT by
  default. Absence of evidence is not evidence of absence, and here the two differ in the direction
  that would flatter the opportunity.

## What a positive result would and would not mean

It would establish that **an upper bound** of removable work exists on one repository, at one commit,
under one diagnostic. It would not establish that a symbol-aware selector can realise that bound, that
it would preserve the safety property, or that the effect generalises. Those are three further
experiments, and the recall evidence would have to be re-established for any selector that changed.

**Not started.**
