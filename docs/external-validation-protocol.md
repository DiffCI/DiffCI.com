# External validation protocol

**Frozen before the target repository is named.** That ordering is the point: a protocol written after
seeing the candidate is a protocol shaped by it.

The assessment implementation under test is **`910969f`**, unchanged. No functionality is added to the
gate before this runs.

## The question

> Can DiffCI spend roughly minutes examining a repository it has **not** been developed against,
> predict whether deployment will produce incremental compute savings, and then have the subsequent
> measurement agree?

Everything to date is development-set evidence. hono, zod and vue produced the rule; reproducing their
signs demonstrates the rule is *implemented*, not that it *generalises*.

## Sequence

Each step completes and is committed before the next begins.

```
1. SELECT      name the repository, record why, before anything is cloned
2. QUALIFY     canonical Linux environment, documented install + build, full suite must exit 0
3. CALIBRATE   npm run calibrate -- --repo ... --out calibration.json      (exactly once)
4. OBSERVE     25 candidates, observation only, neither arm executed
5. FREEZE      npm run eligibility -- --corpus ... --calibration ...
               commit the predicted sign and every raw input
6. MEASURE     economics arms, agent generation B, unchanged
7. COMPARE     predicted sign vs measured sign
```

**Steps 5 and 6 are separated by a commit for a reason.** The prediction must be in version control,
with its inputs, before any economics number exists.

## What may change between step 5 and step 7

**Nothing in the predictor.** No threshold, no reweighting, no change to `effectiveSelection()`, no
recalibration, no dropping of candidates. If the predictor changes, the prediction is void.

If a defect is found in the **measuring apparatus** after the freeze — the kind chronicled in
[laboratory-defects.md](laboratory-defects.md) — then:

- fix it, re-run the affected step, and **preserve the original prediction verbatim** alongside the new
  one, with the defect disclosed. The target is still valid, because nothing was tuned toward it.

If a defect is found in the **predictor** after the freeze:

- the target is **burned**. Its prediction cannot count as out-of-sample, because the fix was made with
  knowledge of this repository. Validation moves to a fresh repository, and this one is recorded as a
  development-set result.

That distinction is fixed now, in advance, so it cannot be argued after the fact in whichever direction
is convenient.

## Outcomes

Exactly one is recorded. All of them are reportable results; none is a failure of the exercise.

| Outcome | Condition |
|---|---|
| `CONFIRMED_POSITIVE` | predicted POSITIVE, measured incremental > 0 |
| `CONFIRMED_NEGATIVE` | predicted NEGATIVE, measured incremental < 0 |
| **`FALSE_POSITIVE_ELIGIBILITY`** | **predicted POSITIVE, measured incremental < 0** |
| `FALSE_NEGATIVE_ELIGIBILITY` | predicted NEGATIVE, measured incremental > 0 |
| `NOT_QUALIFIED` | the repository never reached a green full suite in the canonical environment |
| `NO_ASSESSMENT` | the gate refused to produce a prediction (below) |
| `NOT_ADDRESSABLE` | the apparatus cannot execute the repository's real test surface, or cannot address the same universe for FULL and selected runs (added 2026-08-30, after `date-fns/date-fns`) |

**`FALSE_POSITIVE_ELIGIBILITY` is the outcome to watch, and it is not symmetric with its counterpart.**

A false negative costs DiffCI a customer it could have served. A false positive tells a customer *"we
expect to save you compute"* and then burns more of it than they were spending. The first is a lost
opportunity; the second is a broken promise, made by the very mechanism whose purpose is to avoid making
it. If this occurs it is reported at the top of the result document, not in a caveats section.

## When the gate must refuse

`NO_ASSESSMENT` is a successful, reportable execution of the protocol. It is **not** permission to
estimate, and it is not a reason to relax a rule and retry.

- **Calibration cannot parse a test-file count** from the runner's output. CPU-per-file is multiplicative
  in the predictor; a guessed denominator rescales the entire prediction invisibly.
- **The calibration suite did not exit 0.** A suite that was not green is not a cost baseline.
- **CPU could not be measured** (no `/proc`). The measurement must come from the canonical environment.
- **No analysis CPU was recorded** in the corpus. Charging DiffCI nothing for its own analysis biases
  every prediction in DiffCI's favour.
- **Fewer than 15 of the 25 candidates produced a decision with recorded analysis CPU.** This threshold
  is arbitrary. It is fixed here, in advance, precisely so that it is not chosen later with the results
  in view.

## No noise band

There is no threshold on magnitude, and none is introduced here. The sign is the whole rule, exactly as
in the frozen pre-registration.

If the measured incremental figure is small relative to plausible run-to-run variation, that is recorded
as a **note on the magnitude**, and the sign comparison stands as recorded. Magnitude is not validated,
is not claimed, and is not to be sold. The internal results already show it is rough — hono's prediction
is out by a factor of 2.5.

## Repository selection criteria

Recorded before any candidate is named:

1. **Not previously examined by this project** in any capacity — not qualified, not observed, not
   discussed as a candidate. hono, zod, vue, TanStack/query and vitest are all excluded, including as
   fallbacks.
2. **Assessable with permission.** A public repository under a licence permitting local analysis, or a
   repository whose owner has agreed. Read-only. Nothing is contributed, filed, or communicated upstream.
3. **A real test suite** that runs green from documented commands in a Linux container.
4. **Enough history** for 25 candidate commits touching source.

The selection is **named by the user**, as repository #3 was, and the reason is recorded before cloning.
The criteria above are not adjusted to admit a particular candidate.

## What this protocol explicitly does not authorise

- **No outreach of any kind.** No emails, no issues, no discussions, no messages to maintainers,
  employers, or prospects. Assessment is read-only and silent.
- **No customer contact**, and no use of a customer's private repository without the user arranging it
  directly.
- **No naming of any external party** in a public artefact without the user's explicit approval.
- **No repository #5**, no carbon modelling, no selector work. One target, one result.

## What a confirmed result would and would not establish

**Would:** that a cheap, pre-deployment assessment reproduced the measured economic direction on a
repository it was not developed against. One instance.

**Would not:** a savings figure, a currency figure, a reliability rate, or a claim about repositories in
general. One correct out-of-sample prediction on top of vue's makes two. That is a finding worth
reporting to an investor with the sample size attached, and it is not a product guarantee.

## Targets so far

| # | Repository | Outcome |
|---|---|---|
| 1 | `fastify/fastify` | [`NOT_QUALIFIED`](external-target-01-result.md) — suite not green in the canonical environment |
| 2 | `date-fns/date-fns` | [`NOT_ADDRESSABLE`](external-target-02-result.md) — real test surface only reachable from a subdirectory |
| 3 | `chalk/chalk` | [`NOT_ADDRESSABLE`](external-target-03-result.md) — runner unsupported (AVA output unreadable by every adapter) |
| 4 | `axios/axios` | [`NOT_QUALIFIED`](external-target-04-result.md) — structurally addressable, baseline red in the canonical environment |
| 5 | `immerjs/immer` | **[`CONFIRMED_POSITIVE`](external-target-05-result.md)** — predicted POSITIVE, measured POSITIVE (+46.97 CPU-s). First out-of-sample sign match. |

None is a failure of the eligibility rule, which has still not run once out of sample. All three are
measured coverage limits of the apparatus. Stated as narrowly as the evidence supports, what the
external assessment currently covers is:

> **A green Linux test suite, executable from the repository root, with a runner the apparatus can
> address by explicit test-file paths.**

That is materially narrower than "repositories with CI", and it is measured rather than assumed.

Four targets selected before inspection, four stopped before the predictor. There are at least **two
independent constraints**, not one: two targets were stopped by apparatus limits (runner, monorepo
scope) and two were structurally addressable but had **red baselines in the canonical container**.
Fixing the apparatus limits would not have admitted fastify or axios. A signal rather than a rate —
four is small and the selection was not random.

## Status

**Protocol frozen.** Two targets closed without a prediction, neither by tuning anything.

The first genuinely unseen end-to-end run of `npm run calibrate` has not happened, and that unspent
state is deliberate.
