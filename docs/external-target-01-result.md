# External validation target #1: `fastify/fastify` — `NOT_QUALIFIED`

**Outcome: `NOT_QUALIFIED`.** No eligibility prediction was produced, and none should have been.

## The finding, stated no wider than the evidence

> `fastify/fastify@1beaf7e72d24b2fc63a02a7f5806772a00e45454` did not satisfy the frozen qualification
> requirement in the canonical environment: two consecutive baselines exited 1 and each reported two
> failures.

That is the whole result. It is **deterministically red under the tested canonical environment** — not
"deterministically broken". Whether the cause is repository state, an environment requirement the
sandbox does not provide, or something else, has **not** been established, and no run was spent
establishing it.

## The run

`fastify-qualify-01`, 2026-08-30, `docker.io/cloudflare/sandbox:0.12.5`, node v22.23.2, npm 10.9.8,
Ubuntu 22.04.5, agent generation B.

```
fastify/fastify        [stage] clone        0.1s
                       [stage] install     23.8s
                       [stage] baseline 1  35.0s
                       [stage] baseline 2  34.8s
not qualified  (94s)
  2 test(s) failing at HEAD on every run (2, 2)
  run 1: exit=1 parsedFailures=2 cpu=71.65s wall=35006ms
  run 2: exit=1 parsedFailures=2 cpu=71.72s wall=34780ms
```

Whole run 2m 14s: bootstrap 9.7s, prepare 2.6s, qualify 120.9s, collect 0.9s.

## Why this is a clean red rather than an apparatus failure

- **Exit status and parsed count agree.** `exit=1` with `parsedFailures=2` classifies as a clean `RED`.
  No `CONTRADICTORY_EXECUTION_EVIDENCE`, which is the outcome that would indicate the harness, not the
  repository.
- **The parser read a runner it had never seen.** borp is a `node:test` runner; `parseTestOutput`'s
  `node:test` adapter read `ℹ fail 2` correctly on its first encounter with this repository.
- **Two independent baselines agreed.** Same count both times.

The apparatus worked. The suite was red.

## What was deliberately not done

**The failing test names were not retrieved.** The user directed this explicitly, and the reasoning is
worth preserving: the names do not change the outcome, and learning them creates precisely the
temptation the protocol exists to remove — deciding whether the failures are "reasonable to ignore".

Nothing was skipped, excluded, retried, or re-run under different commands. The criteria were not
adjusted to admit the target.

## The step it never reached

Calibration would have returned `NO_ASSESSMENT` on this repository for an unrelated reason: borp emits
no test-**file** count. Verified against a synthetic two-file project — the summary reports
`ℹ tests 3 / ℹ suites 0`, and nothing anywhere says "2".

That was **not** the recorded outcome, because it is not what happened. Qualification failed first.
Both would have stopped the assessment — calibration also requires exit 0, since a suite that was not
green is not a cost baseline — but the record says what occurred, not what was predicted.

Worth noting: it would not have been rescuable either. borp does not emit the number at all, so
supplying one would mean counting files matching borp's glob — files DiffCI *believes* exist rather than
files the runner *executed*. A different quantity, in a term that multiplies the entire prediction.

## Why this counts as a useful first external result

The gate **did not manufacture an assessment when its prerequisite failed.** The protocol met an
ordinary messy-repository condition on its first contact with a repository selected before inspection,
and stopped where it was designed to stop.

A pre-deployment assessment that only works on repositories whose suites are green is a real limitation,
and it is now a measured one rather than an assumed one. That limitation belongs in any customer-facing
description of the mechanism.

## Status in the external record

**Target #1: `fastify/fastify` — `NOT_QUALIFIED`. Permanent.**

It stays in the record rather than disappearing for having yielded no economics benchmark. How the
system behaves against repositories chosen before inspection *is* the evidence, and a target that
produced no number is part of that distribution.

Target #2 is [`date-fns/date-fns`](external-target-02-selection.md).
