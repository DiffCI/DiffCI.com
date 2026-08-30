# External validation target #4: `axios/axios` — `NOT_QUALIFIED`

**Outcome: `NOT_QUALIFIED`.** Structural checks 1–4 passed; the canonical green baseline did not.

> `axios/axios@fede1d15` did not satisfy the frozen qualification requirement in the canonical
> environment: two consecutive baselines exited 1 and each reported two failures, in
> `tests/unit/adapters/fetch.test.js`.

**Deterministically red under the tested canonical environment.** The cause is not established and no
run was spent establishing it.

## The run

`axios-qualify-01`, 2026-08-30, `docker.io/cloudflare/sandbox:0.12.5`, node v22.23.2, agent generation B.

```
axios/axios            [stage] clone        0.1s
                       [stage] install      6.5s
                       [stage] baseline 1  87.8s
                       [stage] baseline 2  87.5s
not qualified  (182s)
  2 test(s) failing at HEAD on every run (2, 2)
  run 1: exit=1 parsedFailures=2 cpu=23.85s wall=87807ms
    | ❯  unit  tests/unit/adapters/fetch.test.js (69 tests | 2 failed) 29366ms
    | Test Files  1 failed | 57 passed (58)
    | Tests  2 failed | 1060 passed (1062)
  run 2: identical
```

## The coverage check held, and that is the good news here

The universe was established at **58 files** three independent ways *before* the job existed — git tree
at the pinned sha, working tree after clone, and `vitest list --project unit`. The canonical run
reported **58**.

So unlike `datefns-qualify-01`, this verdict describes the repository it names. The manual guard
introduced after defect #13 did exactly what it was for: it made a red result *trustworthy*, which is
the same mechanism that would have made a green one trustworthy.

Also worth recording: `Tests 2 failed | 1060 passed (1062)` matches the local run's 1062 exactly. The
canonical environment ran the same suite, not a smaller one.

## Green locally, red canonically

A full local run of the identical command on an unbuilt tree was **58 files, 1062 tests, all passing**.
The canonical container fails two tests in the fetch adapter suite, reproducibly.

That divergence is real and is **not** explained here. The failing file is named because the harness's
own captured summary named it; no additional run was spent, no test was inspected, and no cause is
claimed. Investigating would lead directly to deciding whether these two failures are "reasonable to
ignore" — the judgment the protocol exists to remove.

It does establish one thing worth carrying forward: **a developer-host green is not evidence of a
canonical green.** Fastify and axios both looked different in the two environments, in axios's case in
the direction that would have been most tempting to trust.

## What was deliberately not done

No test skipped, excluded, retried, or re-run under different commands. No `--project` change, no
substitution of `test:vitest` for `test:vitest:unit`, no environment variable added to coax the fetch
tests. The criteria were not adjusted.

## Four targets, four refusals

| # | Repository | Outcome | Cause | Reached |
|---|---|---|---|---|
| 1 | `fastify/fastify` | `NOT_QUALIFIED` | baseline red in canonical env | step 5 |
| 2 | `date-fns/date-fns` | `NOT_ADDRESSABLE` | monorepo; surface only reachable from a subdirectory | step 4 |
| 3 | `chalk/chalk` | `NOT_ADDRESSABLE` | runner unsupported (AVA) | step 3 |
| 4 | `axios/axios` | `NOT_QUALIFIED` | baseline red in canonical env | step 5 |

**The eligibility rule has still not run once out of sample.** Four selections, four stops, and none of
them is evidence about the predictor's accuracy.

## The finding, updated

Target #4 changes the shape of the coverage problem rather than merely extending it. The first three
suggested the bottleneck was *addressability* — runners and repository layout. axios cleared all of that
and still stopped, on a different gate:

> Two of four targets were **structurally addressable and still not assessable**, because their suites
> are not green in the canonical Linux container.

So there are at least two independent constraints, and fixing the apparatus limits (runner adapters,
monorepo scope) would not have admitted fastify or axios. A **red baseline is not an apparatus defect at
all** — it is a property of the repository-plus-environment pair, and the assessment genuinely requires
a green suite, since a suite that was never green cannot serve as a cost baseline.

Whether these baselines are red because of the repositories or because of the canonical container is
**unknown and unmeasured**. That question is worth answering and is not answered here.

### Which makes the survey more valuable, not less

The addressability survey already recorded in
[external-target-04-selection.md](external-target-04-selection.md) should measure **both** classes, and
its categories already anticipate this: *runner unsupported*, *monorepo scope unsupported*, *baseline
red*, *non-addressable selection surface*, *calibration unreadable*, *qualified*.

On four externally selected targets the split is 2 addressability / 2 baseline-red. Four is far too few
to be a rate, and the selection was not random. **Not started.**

## Status

`axios/axios` — **`NOT_QUALIFIED`**. Permanent. Target #5 is the user's to name.
