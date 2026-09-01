# CI_REPRODUCTION_02 — attempt 2, canonical Linux

> **RECORDED OUTCOME: `REFUSED`, with APPARATUS PROTOCOL VIOLATION — inference operations executed
> despite refusal.** The inference arm outcome and CPU numbers from this attempt are NOT reproduction
> evidence and must not be cited as such. The reference-arm Linux result (GREEN, 161 tests / 4 files /
> 0 failures) and the execution-confirmed `npm ci --legacy-peer-deps` recovery remain independently
> useful.

Run `ci-repro-02-linux-b`, container `sandbox:0.12.5`, node `v22.23.2`, npm `10.9.8`.

## Recorded outcome: `REFUSED` — and the recorded reason is FALSE

```
OUTCOME  REFUSED
reason   "the engine did not mark this pipeline executable, so no inference arm was run"
```

**The inference arm did run.** The receipts show it:

```
reference   npm ci --legacy-peer-deps            exit 0   20.7 CPU-s
reference   npm run test:coverage -- --ci        exit 0   83.4 CPU-s   161 tests / 4 files / 0 fail

inference   git config --global core.autocrlf input   exit 0    0.0 CPU-s
inference   npm ci --legacy-peer-deps                 exit 0   12.5 CPU-s
inference   npm run test:coverage -- --ci             exit 0   80.3 CPU-s   161 tests / 4 files / 0 fail
```

## The defect: the harness executed a plan the engine had refused

`plan.executable` was **false** — the TEST path contains
`npm i webpack@${{ matrix.webpack }}`, which has no resolved command. The engine correctly refused.

The harness then built its step list with
`plan.operations.filter(o => o.command.length > 0)`, which **silently dropped the very operation that
caused the refusal** and ran the remainder.

That is a violation of the hard boundary this whole design rests on:

```
incomplete causal execution path  ⇒  REFUSE TO OPTIMISE
```

The engine held the line. **My harness walked through it**, and then reported a sentence that was not
true. Both are mine, and the second is worse: a false receipt is more dangerous than a failed run,
because it reads as evidence.

## Why the two arms agreeing proves less than it appears to

The arms match exactly — 161 tests, 4 files, 0 failures, 83.4 vs 80.3 CPU-s. That is **not** evidence of
reproduction fidelity.

- The **reference** arm omits the matrix step by a deviation I declared in writing beforehand.
- The **inference** arm omits the same step by an unintended filter.

Two plans that drop the same unresolved step behave identically almost by construction. The agreement is
close to tautological, and calling it `REPRODUCED` would be reporting my own filter back to myself as a
finding.

**No reproduction claim is made from this run.**

## What this run does legitimately establish

**The reference arm is GREEN on Linux: 161 tests, 4 files, 0 failures.**

That settles the open question from attempt 1. The 13 failures seen on Windows under node 24 were
platform artefacts, exactly as suspected, and **nothing about `html-webpack-plugin`'s suite was ever
wrong**. Attempt 1's caveat is now resolved rather than merely stated.

It also confirms, on the canonical platform, that `npm ci --legacy-peer-deps` — recovered from repository
evidence by inference — installs cleanly where the generic `npm ci` produced `ERESOLVE`. That recovery
now has an execution receipt in the environment that matters.

## Attempt 2 is preserved

The harness defect is understood precisely and is **not** repaired inside this row. Fixing it and
re-running would produce an attempt that never had to survive being wrong.

The fix — refuse to execute when `plan.executable` is false, and never drop a blocking operation — lands
as a separate commit, and any re-run is **attempt 3**.

## The honest state of the arrow

```
repository evidence  →  ExecutionGraph  →  faithful executable CI
                        ▲                   ▲
                        job semantics       NOT established: the only path that
                        correct             executed was one the engine refused
```

What is now solid: install recovery, execution-confirmed on Linux; job-purpose selection choosing the
build job; the engine refusing a path it cannot fully resolve.

What is not: a faithful reproduction. Reaching it requires **matrix expansion**, which is the next
pipeline-semantics capability, not parser broadening.

**Nothing was optimised.**
