# External validation target #4: `axios/axios`

**Recorded before the repository's configuration was inspected.** As with target #3, this file contains
**no** facts about axios's runner, test command, or test layout. Those are established by the mechanical
check that follows.

> **External validation target #4: `axios/axios`. Selected by ChatGPT after targets #1–3 were closed,
> before inspecting Axios's current test configuration or producing any repository-specific DiffCI
> observation, comparator selection, calibration, eligibility prediction, or economics data. Selection
> does not imply addressability or qualification; the frozen criteria determine those independently.**

## The basis of the selection

Repository-level considerations only: a mature, widely used JavaScript/TypeScript ecosystem project,
substantial enough to be meaningful, architecturally distinct from hono, zod and vue.

**No assertion** is made about its current runner, test command, green status, file addressability, or
compatibility with the apparatus.

## The criterion that was deliberately NOT added

After chalk closed on an unreadable runner, the obvious move is to add a selection criterion requiring
vitest or jest. **That was considered and rejected**, and the reasoning belongs in the record:

> It would make reaching the predictor easier, but after chalk it would also change the target-selection
> distribution **in response to a failure**.

Filtering candidates by what the apparatus already supports would convert an honest measurement of
coverage into a demonstration that the apparatus works on repositories it was chosen to work on. The
existing record — three pre-inspection selections, three refusals, three causes — is preserved by
leaving selection unfiltered.

## The mechanical sequence, unchanged, stopping at the first failure

```
single package -> root execution -> supported runner -> explicit-file addressability
  -> canonical green qualification -> calibration -> 25 observations
  -> FREEZE prediction -> economics -> compare
```

**No apparatus change to admit this target.** No AVA adapter, no monorepo support, no substituted
commands. If axios needs one, it closes like the others.

## What comes after this sequence, and not before

An **addressability survey** is now warranted and is explicitly **not started**: a separately selected
corpus of roughly 30–50 real repositories, measuring only **which gate stops each one** — runner
unsupported, monorepo scope unsupported, baseline red, non-addressable selection surface, calibration
unreadable, or qualified. No DiffCI economics, and **no fixing failures while surveying**, since fixing
mid-survey destroys the denominator.

That would convert today's observation — *0 of 3 externally selected targets reached prediction* — into
an actual estimate of assessment coverage with failure categories. Recorded here so the idea is dated
and attributed; it begins only after this external sequence closes, and only on the user's word.

## Standing rules

- `0/3` is not a population rate. Three is small and the selection was not random.
- The assessment implementation remains `910969f`; the protocol remains `04750a3` plus `NOT_ADDRESSABLE`.
- Observation ratios are not reported before the prediction is frozen.
- If the outcome is `FALSE_POSITIVE_ELIGIBILITY`, axios becomes development-set evidence and the
  corrected predictor faces a new target.
