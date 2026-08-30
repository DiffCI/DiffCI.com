# Addressability survey — pre-registration

**Written before any repository is named.** That ordering is the whole protection here: after seeing
Fastify, date-fns, Chalk and Axios fail, it would be very easy — without intending to — to assemble a
corpus disproportionately compatible with the apparatus.

## The question

> **How often can DiffCI currently reach the economic assessment at all, and why does it fail when it
> cannot?**

The endpoint is **assessability, not savings.** No observation, no mutation, no economics, no prediction.

This measures the apparatus, not the predictor. The predictor's one out-of-sample result stands
separately at [external-validation-conclusion.md](external-validation-conclusion.md) and is not
revisited here.

## Sampling frame, fixed in advance

**Frame:** the **npm "most depended upon" packages**, in rank order, resolved to their GitHub
repositories.

**Why an external, enumerable, rank-ordered list:** it is not curated by me, the order is determined by
someone else, and it can be reproduced by a third party. Any frame I assembled by judgement would carry
exactly the bias this document exists to prevent.

**Sample size: N = 40.** Fixed now. Within the 30–50 range agreed, and chosen so that a single failure
category of ~10% is still visible above sampling noise, without the cost of 50.

**Selection rule:** the frame is **ranks 1–40**, in source order. Exclusions come out of that 40, so
the eligible N is smaller than 40. There is no judgement at any point — the ranks are taken as they come.

*(This supersedes an earlier reading, "take ranks until 40 are admitted". The two rules differ and the
discrepancy is settled in [addressability-survey-frame.md](addressability-survey-frame.md), before any
inspection. The concrete source is fixed there too.)*

### Exclusions, and their strict definitions

A rank is skipped **only** for the reasons below, each recorded with the repository name so the
exclusion list is auditable:

1. **Already examined by this project** — hono, zod, vue, TanStack/query, fastify, date-fns, chalk,
   axios, immer. Including them would recycle known answers.
2. **No public GitHub repository**, or the repository is archived or deleted.
3. **No test suite at all** — no test script and no test files. Such a repository is outside the product's
   scope entirely, not a failure of the apparatus.
4. **Not primarily JavaScript/TypeScript.**

**Monorepos are NOT excluded.** Neither are unsupported runners, red suites, or anything else the survey
is trying to measure. Those are outcomes, not exclusions. Excluding them would be measuring a
population defined by the answer.

Exclusions are reported as a separate count alongside the 40, never folded into the denominator.

### Known bias of this frame, stated before it can be convenient

The npm most-depended-upon list skews toward **old, small, single-purpose packages**. Many predate
vitest and jest, and many are maintained by individuals rather than teams.

Directionally this likely **understates** apparatus compatibility relative to modern application
repositories, which more often use vitest or jest. Whichever way it errs, the estimate describes *this
frame* and no other, and every reported number must say so.

The frame may be changed **only before the first repository is inspected**, and only by explicit
decision recorded here. After that it is fixed, whatever the early results look like.

## Failure taxonomy

Each repository is evaluated against the gates **in order** and assigned the **first** gate it fails.
Exactly one category per repository. No repository gets two labels, and no gate is evaluated out of
order — that ordering is what makes the categories mutually exclusive.

| # | Gate | Category if it fails |
|---|---|---|
| 1 | Single execution scope — the real test surface is reachable from the repository root | `MONOREPO_SCOPE_UNSUPPORTED` |
| 2 | Runner readable — this harness can parse a failure count **and** a test-file count | `RUNNER_UNSUPPORTED` |
| 3 | Documented root command — a repository-authored script runs the suite from the root without a browser, a foreign runtime, or a service | `NO_ROOT_COMMAND` |
| 4 | Explicit-file addressability — the runner accepts named test files and runs exactly those | `SELECTION_SURFACE_UNADDRESSABLE` |
| 5 | Canonical green baseline — two consecutive green runs in the Linux container | `BASELINE_RED` |
| 6 | Calibration readable — a test-file count and CPU are obtainable from that run | `CALIBRATION_UNREADABLE` |
| — | all gates passed | **`ASSESSABLE`** |

Two further outcomes exist for honesty and must not be quietly merged into the others:

- `INSTALL_FAILED` — dependencies could not be installed in the canonical environment.
- `SURVEY_ERROR` — the survey's own machinery failed. Recorded, and the repository re-run once; if it
  fails again it stays `SURVEY_ERROR` rather than being reassigned to a substantive category.

### Note on gate 2 versus gate 6

They are different limits and were separated because the apparatus already exhibits both:
`parseTestOutput` reads node:test, vitest, jest and mocha, while `parseTestFileCount` reads only vitest
and jest. A mocha repository fails gate 2 on the file-count half. borp failed the same way; AVA failed
both halves.

## Cost control

**Structural inspection first.** Gates 1–4 are answered by reading the repository's committed
configuration — `package.json`, runner config, lockfile — and, where necessary, one local clone. No
container job.

**Canonical qualification only when gates 1–4 pass.** Gates 5–6 cost a container run, and only the
repositories that reach them pay for one.

On the sequence so far this would have spent container runs on 2 of 5 targets.

## What the survey may NOT do

- **No fixes.** No runner adapter, no monorepo scope support, no command substitution, no skipped tests,
  no environment coaxing — for any repository, at any gate, for the entire survey.
- **No repository-specific adaptation** of any kind.
- **No observation, mutation, economics, or prediction.**
- **No early stopping**, and no extending N after seeing results. 40 is 40.
- **No re-categorisation** after the fact. The first gate failed is the recorded category.

Fixing anything mid-survey destroys the denominator: repositories evaluated before a fix and after it
are no longer the same experiment, and the resulting rate describes neither apparatus.

Improvements identified during the survey are **recorded as findings and implemented afterwards**, on
their own merits, with no target waiting on them.

## Analysis, fixed in advance

Reported as counts over the 40, plus the exclusion list separately:

```
ASSESSABLE                         n / 40
BASELINE_RED                       n / 40
RUNNER_UNSUPPORTED                 n / 40
MONOREPO_SCOPE_UNSUPPORTED         n / 40
NO_ROOT_COMMAND                    n / 40
SELECTION_SURFACE_UNADDRESSABLE    n / 40
CALIBRATION_UNREADABLE             n / 40
INSTALL_FAILED                     n / 40
SURVEY_ERROR                       n / 40
```

### The denominator is reported as a chain, never collapsed

```
40 frame entries  ->  X excluded for pre-registered reasons  ->  N survey-eligible  ->  Y reached assessment
```

The original 40 is **never silently replaced** by whatever remains after exclusions. Both numbers are
always shown, and the exclusion list is itemised by repository and reason.

### The primary result is ASSESSMENT REACHABILITY, not "DiffCI addressability"

```
                          repositories reaching a valid eligibility assessment
Assessment reach rate  =  ------------------------------------------------------
                                    eligible surveyed repositories
```

The wording matters and is fixed here. Some failures — a reproducibly red canonical baseline most
obviously — **do not establish that DiffCI could not technically operate on the repository.** They
establish that *this assessment* cannot validly produce an economic eligibility verdict under its
frozen requirements. `BASELINE_RED` is a statement about the assessment's contract, not about the
selector's capability.

Reported with a binomial confidence interval and with the frame named in the same sentence. The ordered
failure taxonomy explains the complement. No subgroup analysis is pre-registered; any performed later
is labelled exploratory.

### The five external targets are NOT survey observations

fastify, date-fns, chalk, axios and immer were selected under a different mechanism — named one at a
time by a human, with knowledge of the preceding outcomes. They remain external-validation evidence and
**must not be pooled into this survey's denominator or numerator.** The 40 are the survey.

**What the survey cannot establish:** whether an assessable repository would receive a *correct*
prediction. That is the other question, and it has n = 1.

## Status

**Pre-registered and FROZEN. Apparatus and protocol boundary: `af3b355`.**

The survey measures the product and apparatus as they stand at that commit — not what they could be made
to support after seeing the corpus. Nothing in this document changes once repository #1 is inspected.

The frame, N, exclusions, taxonomy, gate order, cost rule and analysis are all fixed by this document
before any data exists.
