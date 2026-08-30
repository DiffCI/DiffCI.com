# External validation target #1: `fastify/fastify`

**Recorded before the repository was cloned, and before any Fastify-specific data of any kind existed.**

## The selection

`fastify/fastify`, selected by ChatGPT and relayed by the user, after the external-validation protocol
was frozen at [`04750a3`](external-validation-protocol.md), and before the repository was cloned or any
repository-specific DiffCI observation, calibration, comparator selection, eligibility prediction, or
economics data was inspected.

**Selection does not imply eligibility.** The frozen criteria determine that independently.

## Reasons given, recorded verbatim in substance

1. A mature, substantial Node.js/JavaScript project rather than another Vue-family repository.
2. Its architecture differs meaningfully from hono, zod, and vue.
3. A substantial test suite, and dependency relationships where selective execution is economically
   relevant.
4. It deliberately avoids resembling zod — we now know which repository characteristics have correlated
   with a positive result, and choosing for that resemblance would manufacture the outcome.
5. Named without any Fastify DiffCI observation, comparator selection, calibration result, eligibility
   prediction, or economics result in view. **No prediction has been offered for which sign it will
   produce.**

Reason 4 is the one that makes this a real test. The cheapest way to fake an out-of-sample success is to
pick a target that looks like the case that already worked.

## The caveat the selector attached, kept

> I am not attesting that Fastify satisfies your frozen execution/runner criteria. That determination
> belongs to the eligibility check. I am selecting the target, not pre-screening it to make it
> admissible.

This is the correct division. A selector who pre-screens for admissibility has already done a form of
tuning.

## State at the moment of recording

- Nothing cloned. No Fastify commit examined. No `package.json` read.
- No calibration, no observation, no prediction, no economics.
- The assessment implementation remains `910969f`, unchanged.
- The protocol remains `04750a3`, unchanged.

## What happens next, and what will not

Mechanical application of the frozen protocol:

```
QUALIFY -> CALIBRATE (once) -> 25 OBSERVATIONS -> ELIGIBILITY OUTPUT
        -> commit/freeze the predicted sign -> ECONOMICS -> freeze -> COMPARE
```

Instructed explicitly, and recorded here so it cannot be quietly softened later:

- **If Fastify is ineligible, that result is preserved** and target #2 is named. The criteria are not
  modified to admit it.
- **If calibration returns `NO_ASSESSMENT`, that is the result.** The missing denominator is not derived
  by hand.
- **If observation yields fewer than 15 of 25 usable candidates, that is insufficient evidence.** The
  threshold is not changed.
- **If the outcome is `FALSE_POSITIVE_ELIGIBILITY`** — predicted POSITIVE, measured NEGATIVE — the
  predictor is **not** repaired against Fastify and re-run on Fastify. Under the frozen protocol Fastify
  becomes development-set evidence, and the corrected predictor must face a new target.

The last one is the rule that costs something. It is written down before the result is known, which is
the only time it can be written down honestly.

## Adding the job is not adding functionality

Executing the protocol requires a `fastify-*` entry in the allowlisted validation jobs, because a caller
names a job and never supplies commands. That is target registration, not new capability: the gate, the
predictor, `effectiveSelection()`, and the parsers are untouched at `910969f`.
