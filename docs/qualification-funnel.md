# Canonical qualification funnel over the frozen 40

Assembled from committed evidence — the density survey for analyser eligibility and structure, the
corpus registry for qualification outcomes already obtained. **Nothing was re-run.** No ≥100-test or
≥30%-mapping threshold is applied: those belong to the compute-proof rule, and this diagnostic asks a
narrower question.

## Where repositories stop (32 distinct repositories)

| stage | n |
|---|---:|
| analyser ineligible — no `tsconfig.json` | **8** |
| never qualified — **no evidence yet** | **17** |
| install failed | 1 |
| build failed | 0 |
| reached a baseline, not green twice | 3 |
| **green on two consecutive runs** | **3** |

**Of the 7 actually attempted, 3 went green twice.** That is 7 attempts, not 32 — the headline number
this funnel produces is still *how little we know*, not a green rate.

**Corrected 2026-08-30.** The first version of this table read 21 unattempted and 0 green, because the
gate 5–6 verdicts from the addressability survey were written to the *container's* copy of the registry
and never carried back to the committed one. Five were transcribed from their committed, checksummed
logs — `ts-jest`, `css-loader`, `eslint-config-prettier`, `prettier` green; `webpack` red. That is
transcription from logs that state the verdict, **not** inference: `vuejs/core` is still left `unknown`
precisely because it has only a narrative economics record and no qualification log.

## The 17 unattempted rows are the finding

Seventeen of thirty-two repositories in the frame have **never been through canonical qualification at
all**. Until those runs exist, "the green rate" is not a rate — it is one install failure and two red
baselines out of three attempts.

Completing the funnel costs **one container run each for the remaining 17**. That is the price of testing the
`twoGreenBaselines`-is-binding hypothesis properly, and it should be paid before any V2 is designed
rather than after.

## Three caveats that stop this being over-read

**The frame excludes three of the four repositories known to qualify.** `hono`, `zod` and `immer` are
all `mutationQualified: yes` and none appears in the frozen 40 — the frame is npm's most-depended-upon
packages, and they are not in its top 40. So "0 green twice" describes *this frame*, not DiffCI's
history: four repositories have gone green under this harness, three of them simply aren't here.

**`vuejs/core` is in the frame and is under-reported.** Its registry entry still says
`mutationQualified: unknown` while carrying a full `vue-economics-01` record — 16 candidates, 0 dirty
baselines. The registry field is stale, not the repository. It is left as recorded rather than
back-filled, because editing a qualification field from narrative evidence is exactly the kind of
tidying that makes a record untrustworthy. It should be resolved by a run, not a guess.

**A funnel-script defect was found and fixed before reporting.** The first version treated
`EXCLUDED_ALREADY_EXAMINED` as analyser-ineligible, which discarded real evidence for `chalk`, `axios`
and `vue` and reported **12** ineligible instead of **8**. Corrected: that exclusion means the density
survey skipped a known answer, not that DiffCI refused the repository.

## What this does and does not support

**Supports:** the hypothesis that canonical reproducibility is a major constraint is **weaker than it
looked**. Of 7 attempts, 3 went green twice — not the near-zero rate the stale registry implied. Seven
attempts is still not a sample. What *is* established is that 8 of 32 fail before
qualification is even reachable, on the `tsconfig.json` requirement alone.

**Does not support:** any claim about DiffCI's economics. No observation, no selection, no compute
comparison exists for any repository in this frame.

**Does not support:** relaxing `twoGreenBaselines`. A compute-savings experiment against an already-red
baseline makes recall and false-green measurement uninterpretable, which is the one thing the whole
programme has been built to preserve.

## The number worth keeping

`jestjs/jest`'s full suite costs **~1,680 CPU-seconds** against a ~179-second build. Whatever V2 turns
out to be, that is the scale of test compute available to save if a reproducible workload of that class
can be reached — and it is the reason the target-selection problem is worth solving rather than
routing around.
