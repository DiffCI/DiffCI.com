# CI_REPRODUCTION_03 attempt 4 — the harness said REPRODUCED. It is not.

Completed in **104.5 minutes**. The 90-minute bound was enough: the reference suite ran **3106s (51.8
min)**, so attempt 3's 20-minute ceiling was indeed the whole of that failure and nothing else was wrong
with it.

The harness then reported:

> `REPRODUCED — both arms ran 161 tests with 113 failures`

**That verdict does not survive examination, and I am not banking it.** Two independent things are wrong
with it, neither of which the scorer was capable of noticing.

## 1. The environment could not run the suite (defect 26)

Every sampled failure is jest's own `Exceeded timeout of 30000 ms for a test`. The arithmetic settles it:

```
113 failures × 30s per-test ceiling ≈ 56 minutes
observed wall clock                  = 51.8 minutes
observed CPU                         = 116s   (3.7% of wall)
```

The suite did not fail. It **sat at its per-test timeout**, for essentially the entire run, on a
container that gave it 116 seconds of CPU in 52 minutes. `Test Suites: 2 failed, 2 passed`.

Yet every step was recorded as `outcomeLayer: "repository"` — blaming `html-webpack-plugin` for this
microVM's throughput. The layer was assigned binarily (bound ⇒ harness, everything else ⇒ repository)
even though the type has always carried an `environment` case that nothing ever set.

## 2. There was no CI ground truth to reproduce (defect 25)

`REPRODUCED` was decided from **arm-to-arm agreement alone**. So I went and looked at what CI actually
did at the pinned commit `cf9c7012`:

| | |
|---|---|
| `Lint - ubuntu-latest` | **failure** at 29s |
| all 27 `test` matrix cells | **cancelled**, longest survived 51s |
| our target `test Node 22.x Webpack latest ubuntu-latest` | **cancelled** after 49s |
| conclusions across 28 check runs | `{cancelled: 26, failure: 2}` |

**Real CI produced no completed test result for any cell at this commit.** The lint failure cancelled the
matrix before a single suite finished. There was never anything to reproduce.

Two arms agreeing with each other, and with nothing external, is exactly the near-tautological agreement
the attempt-3 protocol warned about when it withdrew the matrix omission — reintroduced by the scorer in
a different form. The protocol named the pattern; the scoring code then walked into it.

This is a **target-selection** defect that has been sitting under attempts 1–4 unnoticed. `cf9c7012` was
inherited as the frozen E2 RED head; nobody ever asked whether its CI produced a result.

## Corrected verdict

Re-running the fixed classifier over the preserved attempt-4 receipts:

```
stored verdict    : REPRODUCED - both arms ran 161 tests with 113 failures
real CI cell      : test Node 22.x Webpack latest ubuntu-latest = cancelled
corrected verdict : ENVIRONMENT_INADEQUATE
```

And had the environment been adequate, it would still have been `UNVERIFIABLE`, because the ground-truth
cell concluded `cancelled` and a cancelled run is not a result.

## What attempt 4 does legitimately establish

This is real and should not be lost in the correction:

| | reference | inference |
|---|---|---|
| `npm ci --legacy-peer-deps` | exit 0, 21s cpu | exit 0, 16s cpu |
| `npm i webpack@ --legacy-peer-deps` | exit 0, 5s cpu | exit 0, 5s cpu |
| `npm run test:coverage -- --ci` | exit 1, 161t/4f/113fail | exit 1, 161t/4f/113fail |

Two **independently constructed** arms — one transcribed by hand from the workflow, one generated only
from the inferred `ExecutionGraph` — produced identical commands, identical test counts, identical
failure counts, and CPU within 2%. **Arm equivalence is established.** The inference engine did its job:
the `UNDEFINED_CONTEXT` rendering, the FALSE-conditioned Windows step, and the TEST-providing job were
all derived without per-repository patching.

What is *not* established is reproduction of CI. Those are different claims and only one of them is
earned.

## Defects recorded

**Defect 25 — the scorer certified reproduction without a referent.** `classify` compared the two arms
to each other and never to CI. Fixed: `CiGroundTruth` is now required, only `success`/`failure` count as
usable, and its absence yields **`UNVERIFIABLE`** rather than a pass.

**Defect 26 — environment failures charged to the repository.** Fixed: `environmentSignalsIn` detects
per-test timeouts, disk and heap exhaustion; those set `outcomeLayer: "environment"` and yield
**`ENVIRONMENT_INADEQUATE`**, which is checked before any equivalence comparison.

Nine behavioural tests cover defects 23, 25 and 26, including controls proving genuine `DIVERGED`,
`REFUSED` and `REPRODUCED` all remain reachable. 1819/1819 green.

`reproduction.json` is preserved exactly as the run wrote it, incorrect `REPRODUCED` field included.

## What this means for the reproduction line

Attempt 4 did not fail because of DiffCI. It failed because of the **experiment**: a target commit whose
CI was cancelled, and a container that cannot execute a webpack-heavy suite inside jest's per-test
budget. Both are mine.

Reproduction cannot be demonstrated on this target at all. Continuing to iterate attempts against
`cf9c7012` would be spending time on a commit that is structurally incapable of settling the question.
The next step is a decision about the target and the environment, not another attempt — and that is a
call to put to the user rather than to make quietly, since it means revisiting a frozen selection.
