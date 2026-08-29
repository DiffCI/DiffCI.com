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

---

# Run `zod-qualify-02`, 2026-08-29 — MUTATION-QUALIFIED

Same pinned commit, same environment, same commands. Qualifier 2.0.0: bounded clone, exit-status
invariant, recorded evidence, shared execution primitive, per-stage progress.

```
[stage] clone        0.1s
[stage] install     16.7s
[stage] build       15.9s
[stage] baseline 1  77.3s
[stage] baseline 2  55.9s
MUTATION-QUALIFIED  (166s)

run 1: exit=0 parsedFailures=0
  | Test Files  573 passed (573)
  | Tests  7808 passed (7808)
run 2: exit=0 parsedFailures=0
  | Test Files  573 passed (573)
  | Tests  7808 passed (7808)
```

## Why this green is trustworthy where TanStack's was not

**Exit status 0 on both runs**, not merely a parsed count of zero. The invariant that caught the
TanStack false green — a non-zero exit outranks any summary the parser can read — is satisfied here
rather than bypassed. zod's test command is bare `vitest run`, which emits a single summary describing
the whole run, so there is no orchestrator aggregation for the parser to misread. Both runs agree
exactly: 573 files, 7808 tests.

The evidence is in the log, so this verdict can be checked by someone who was not present.

## The unexplained discrepancy, which this run does NOT resolve

`zod-qualify-01` ran **180 minutes** and was killed by the external guard without producing a verdict.
`zod-qualify-02` completed the same work in **166 seconds** — a factor of about 65.

Nothing established here explains that. What changed between the runs was the harness's *bookkeeping* —
a bounded clone, a shared execution primitive, recorded evidence, stage logging — none of which should
alter how long an install, a build or a test run takes. The calibration suite passed 12/12 inside this
same environment, including the process-tree bounding cases, so the timeout mechanism itself is not
implicated.

The most likely remaining candidates are environmental and transient — a degraded container, a slow
package registry — but **no cause is established, and none is claimed**. `zod-qualify-01` remains
`QUALIFICATION_TIMEOUT / cause unknown`, preserved separately and not reinterpreted by this result.

That a run can consume three hours and yield nothing, while the same work elsewhere takes under three
minutes, is itself a fact worth carrying into any future claim about this laboratory's reliability.

## What it changes about the corpus

zod is the **first monorepo to qualify**. The bias that motivated building this environment — both
monorepos attempted on the developer host failed, both single-package libraries passed, so safety
evidence was accumulating only where the graph-explosion question matters least — is now broken by
evidence rather than by argument.

Mutation-qualified repositories: `honojs/hono`, `unjs/h3`, `colinhacks/zod`.
