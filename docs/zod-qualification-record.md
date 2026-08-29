# colinhacks/zod qualification record

**Run `zod-qualify-01`, 2026-08-29. Verdict: NO CONCLUSION — qualification infrastructure timeout.**

Pinned at `e6b6ab347675cd2bd54b1bdbed16f98c59be82a9`, canonical Linux environment
(`docker.io/cloudflare/sandbox:0.12.5`, node v22.23.2, Ubuntu 22.04.5).

```
step        = failed
errorClass  = run-timeout
error       = qualify exceeded maxRunMs (10800000ms, elapsed 10800429ms)
              - killed rather than polled indefinitely
timings     = { bootstrapMs: 14925, prepareMs: 4512 }
```

## What this does not say

**It says nothing about whether zod's suite is green or dirty.** No baseline completed, no failure
count was read, no verdict was produced. This is a statement about the laboratory, not about the
repository. zod is neither qualified nor disqualified on its merits; it is unmeasured.

## What it does say

**The original blocker is gone.** zod was disqualified on the developer host because its build shells
out to a bare `pnpm` that was not on PATH. Enabling corepack for the environment cleared that: the run
reached the `qualifying` stage and stayed there, rather than failing at install or build. Whatever
happened, it was not the old failure.

**The external guard works.** `maxRunMs` fired at 10,800,429 ms against a 10,800,000 ms ceiling — 429
milliseconds of overshoot on a three-hour bound. It killed the process and recorded `failed` with a
reason. Critically, **it did not emit a qualification verdict.** A laboratory whose internal timeout
did not hold still refused to produce a result rather than producing a plausible one, which is the
behaviour that matters when the alternative is silently admitting a repository to the safety corpus.

Until this run, `maxRunMs` had never fired. It is now exercised.

## The unresolved question

The harness caps each stage at 25 minutes: install, build, and two baseline runs. That is a 100-minute
ceiling. The process ran for 180.

The clone stage was unbounded at the time this run started — that defect was found and fixed during the
run — so it is the one stage that could have consumed arbitrary time without violating any bound.

**The observed 180-minute runtime is inconsistent with the expected aggregate bounds unless substantial
time was spent in the then-unbounded clone stage. The responsible stage is not established.**

One hypothesis was proposed and **refuted**: that `spawnSync`'s `timeout` fails to bound a process tree
when a grandchild inherits and holds the stdio pipe. A direct probe killed both a plain hanging child
and a child with a detached grandchild at the timeout. That probe ran on Windows / node v24, and the
hang occurred on Linux / node v22 inside a container, where signal delivery and pipe semantics differ —
so the refutation is real but local, and does not clear the container.

`tests/scripts/harness-calibration.test.ts` asserts the bounding behaviour on whatever platform runs
it. Running that suite **inside the canonical environment** is the next step, because that is the only
place the discrepancy has ever been observed.

## Provenance

This run used the harness as it stood before `QUALIFIER_VERSION` 2.0.0 — no exit-status invariant, no
recorded per-run evidence, unbounded clone. That does not affect this outcome, because no verdict was
produced to be trusted. Any future zod qualification must run under 2.0.0 or later.
