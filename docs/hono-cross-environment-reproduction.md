# honojs/hono: cross-environment reproduction (2026-08-29)

The frozen developer-host evidence for `honojs/hono` was reproduced in the canonical Linux validation
environment. **13 of 13** host-measurable candidates kept their safety classification. **Zero false
greens** in either environment.

This upgrades the hono evidence from *developer-host evidence* to *cross-environment reproduced
evidence*.

## What was held constant

| | |
|---|---|
| Repository | `honojs/hono`, pinned at `e2740d5a1bd0b4254e517e3af8b60789284bc7bd` |
| Agent | `sha512-mj4GQJ…7Kw==`, the exact tarball bytes that produced the host evidence, verified in-container before anything was measured |
| Commands | `npm install --no-audit --no-fund --silent`, `node_modules/vitest/vitest.mjs run`, maxAttempts 2, timeout 900000 — read from the host run's manifest |
| Corpus | 25 observations → 22 SELECTIVE candidates, identical on both sides |

## The comparison

Candidate level, keyed on `commit + mutation identity`. Funnel agreement alone would not have been
sufficient: two runs can report the same totals while disagreeing about which commits were measurable
and which file was mutated.

```
FUNNEL                    host    canonical
  candidates                22       22
  environment-dirty          3        0
  invalid runs               4        0
  recall-unmeasurable        2        2
  recall-MEASURABLE         13       20
    recall confirmed        13       20
    FALSE GREEN              0        0
  efficient/comparable/overbroad   2/3/8   4/4/12

VERDICTS
  REPRODUCED           13
  COVERAGE_GAINED       7
  BOTH_UNMEASURABLE     2
```

All 13 came back `REPRODUCED`, not `REPRODUCED_OTHER_MUTATION` — each confirmed via the **same mutated
file**. The same finding, not a matching count.

The 7 gains are the environment doing what it was built for:

- 4 host `INVALID_RUN`, all "could not check out `<sha>`" — the host's shallow clone lacked those
  commits. The full clone reaches them.
- 3 host `ENVIRONMENT_DIRTY`, "1–2 test(s) already failing before mutation". Every baseline in the
  canonical environment was green: `baselineFailures` is `[0]` across all 22.

## Within-environment stability

Two independent canonical runs (`hono-linux-05`, `hono-linux-06`) produced **identical funnels** and
agreed on **20/20** candidates with the same mutated files. The result is not a single lucky run.

## Environment identity

Recorded from inside the container and carried into the run manifest:

    docker.io/cloudflare/sandbox:0.12.5  node=v22.23.2
    Ubuntu 22.04.5 LTS, x86_64, kernel 6.18.36-cloudflare-firecracker
    npm 10.9.8, git 2.34.1

Frozen bundle `2026-08-29T04-35-28-954Z-honojs-hono-f6352d`, 6/6 checksums verified,
`insideValidationImage: true`.

## What this does NOT establish

1. **Not an OS causal experiment.** The host ran Node v24.16.0; the canonical environment runs
   v22.23.2. Operating system and Node version changed together. Any difference is
   environment-attributable, not Linux-attributable.

2. **The test surface is larger here.** The canonical environment runs **147 test files / 4961 tests**
   across four projects including `fastly`, because hono's `runtime-tests/*` glob resolves on Linux and
   evidently did not on Windows. The mutations were detected against a bigger suite than the host
   evidence used. This makes the confirmations stronger in one sense, but the two runs are not
   like-for-like.

3. **The harness is not byte-identical to the host run.** An ANSI-stripping defect was fixed mid-
   experiment (see below). The fix is a no-op on uncoloured output, so the frozen host numbers are
   unchanged — but the canonical runs used a later harness.

4. **hono's dependency tree is not reproducible.** At this commit hono has **no lockfile of any kind**
   (`package-lock.json`, `pnpm-lock.yaml`, `bun.lockb`, `yarn.lock` all absent) and declares
   `packageManager: bun@1.2.20` while the harness installs with npm. Two installs a week apart may not
   resolve the same versions. The corpus registry previously described hono as having "a committed
   lockfile"; that was wrong and has been corrected.

## Defects this experiment found

It took six runs. Four of them failed, and each failure was a defect worth having found:

1. **Empty run reported as success.** The corpus was labelled with the pinned clone's *path*, because
   `dogfood-observe` records `identity.repository` as the entry's `source` verbatim. The mutation
   pass's `--repository` filter then matched nothing and wrote a `COMPLETE` run with zero rows in 30
   seconds. Pinning now uses a git `insteadOf` rewrite, so identity stays honest and history stays
   fixed. Guards added at three layers: the shard refuses a corpus whose rows carry the wrong
   repository, `collect` refuses zero rows, and `dogfood-freeze` refuses to freeze an empty run.

2. **A parser that could not read its own runner in colour.** All 22 candidates returned
   `INVALID_RUN` — "could not parse the baseline run's failure count" — while every suite was
   *passing* (exit 0, 4961 tests). The summary line was present and correct, wrapped in ANSI codes, so
   every adapter's `^\s*` anchor failed. `FORCE_COLOR=0` is set by the harness and does not help,
   because `CI=1` is set alongside and vitest colourises under CI. The dangerous direction is a
   *failing* summary hidden by colour, which would make a caught mutation look uncaught; there is now a
   test for exactly that.

3. **No diagnostics on an unparseable run.** The harness recorded the parse failure and discarded the
   output, so four container runs were needed to identify something the first would have shown. It now
   records exit status, summary-shaped lines extracted by content, and an output tail — on the failure
   path only, where it cannot influence a classification.

4. **A bundle that misreported its own provenance.** The first successful canonical run froze carrying
   the caveat *"Produced on a developer host, NOT the canonical validation image"*. The shard never set
   `DIFFCI_VALIDATION_IMAGE`. A bundle that lies about where it came from is worse than no bundle.

## The economics, unchanged

Safety is strong; the economics are not. **12 of 20** measurable candidates are
`SELECTION_OVERBROAD` — for example selecting 83 of 136 tests where 3 detect the mutation. Against the
path-rule comparator DiffCI frequently selects *more*, not less. That remains the weak result and is
not improved by this reproduction.
