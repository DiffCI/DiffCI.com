# External validation target #3: `chalk/chalk`

**Recorded before the repository was cloned and before anything about its configuration was inspected.**
This file deliberately contains **no** facts about chalk's runner, scripts, or test layout. Those are
established by the mechanical check that follows, and recording them here first would blur the line
between selecting a target and pre-qualifying one.

> **External target #3: `chalk/chalk`. No claim of eligibility. The frozen criteria decide.**

## What the selector considered, and explicitly declined to do

Two candidates were raised and rejected *before* chalk, and the reasons are the useful part of this
record:

- **`colinhacks/zod`** — rejected by the selector as soon as it was named: zod is already in the
  development corpus, so it is not unseen and cannot serve as an out-of-sample test.
- **`sindresorhus/p-map`** — rejected on the concern that it might use a runner the apparatus cannot
  address, which would end the assessment immediately.

The second rejection carries a risk worth naming plainly, because it is the mirror image of the mistake
that produced date-fns's failure. Choosing a target for its *expected* compatibility edges toward
pre-qualification. The selector addressed this directly:

> I want to avoid repeating the mistake of implicitly pre-qualifying a repository based on what I think
> its current tooling looks like… **eligibility is not asserted.**

So chalk is chosen for **expected structural fit** — a single package rather than a monorepo — and not
for any expectation about how DiffCI would perform on it. The distinction that preserves the experiment
is that no DiffCI observation, comparator selection, analysis CPU, or economics figure has ever been
seen for chalk. **No sign has been predicted.**

## The mechanical check, in order

Each step is pass/fail. **If any one fails, the target closes.** No command is substituted, no support
is added, no criterion is relaxed.

1. **Single package** — not a monorepo whose real test surface lives in a subdirectory.
2. **Root runner** — the documented test command is runnable with the clone root as working directory.
3. **Supported runner** — the apparatus can read the runner's failure count, and can read a test-**file**
   count for calibration.
4. **Explicit-file addressability** — the runner accepts named test files and runs exactly those.
5. **Canonical green qualification** — two consecutive green baselines in the Linux container.

Step 3 is where the two known apparatus limits bite, and they are not the same limit:
`parseTestOutput` reads node:test, vitest, jest and mocha; `parseTestFileCount` reads **only vitest and
jest**. A repository can therefore qualify and still return `NO_ASSESSMENT` at calibration.

Step 4 is a **direct lesson from date-fns**, where the invocation collected 14 files while the real
surface was 262, and where repo-relative paths matched zero. It is now checked deliberately rather than
assumed.

## The corrected statement of what the assessment currently covers

Two refusals have measured the boundary, and it is narrower than "repositories with CI":

> **A green Linux test suite, executable from the repository root, with a runner the apparatus can
> address by explicit test-file paths.**

## What the sequence is already worth

```
Fastify   -> NOT_QUALIFIED
date-fns  -> NOT_ADDRESSABLE
chalk     -> unknown
```

Two refusals must not become pressure to make target #3 easier after inspection. The record above is
already external evidence about assessment coverage, and it stands whether or not chalk reaches the
rule.

If chalk reaches the eligibility rule, the predictor finally gets an out-of-sample test. If it does not,
that is commercially informative in a different way: **the assessment's addressable surface may be the
bottleneck before prediction accuracy matters at all.** A predictor that is never reached cannot be sold
on its accuracy.

## Rules carried forward unchanged

- Selection does not imply eligibility.
- The assessment implementation remains `910969f`; the protocol remains `04750a3` plus the
  `NOT_ADDRESSABLE` outcome added after date-fns.
- No apparatus modification to admit this target. If it needs one, it closes.
- If the outcome is `FALSE_POSITIVE_ELIGIBILITY`, chalk becomes development-set evidence and the
  corrected predictor faces a new target.
- Observation ratios are not reported before the prediction is frozen.
