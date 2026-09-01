# FROZEN — CI_REPRODUCTION_05 eligibility and target selection

**Written before any candidate was evaluated against these criteria.** Nothing below was chosen after
seeing which repository it would produce. That is the entire point of writing it first.

Attempts 1–4 ran against `jantimon/html-webpack-plugin @ cf9c7012`, a target that turned out to be
structurally incapable of settling the reproduction question — real CI cancelled all 27 test cells, so
there was no result to reproduce, and the canonical container could not execute the suite inside jest's
per-test budget. Neither failure was DiffCI's. Both were the experiment's, and both were mine.

The fix is not to iterate on that target. It is to state, in advance, what makes a target *capable* of
settling the question at all.

## The frame — unchanged, external, already frozen

`npm-high-impact@1.13.0`, export `topDependent`, published **2026-06-08**. The same third-party ordering
every prior draw used. Ascending rank. I do not control it and it predates this document.

## Eligibility criteria

Applied in ascending rank order. All four must hold.

| | criterion | why it is independent of DiffCI winning |
|---|---|---|
| **R1** | CI runs on GitHub Actions with at least one workflow job providing TEST | a repository with no CI cannot have its CI reproduced |
| **R2** | at the pinned head, GitHub check-runs contain **at least one in-environment cell** (`runs-on` ubuntu-\*, node major = the container's 22) whose conclusion is `success` or `failure` | this is the ground truth that attempt 4 lacked entirely |
| **R3** | in the canonical container the **reference arm alone** completes: non-null exit within the 90-minute bound, and **zero environment signals** | this is the feasibility attempt 4 lacked |
| **R4** | not previously used in any `CI_REPRODUCTION` attempt, **and not one of the six frozen RED inference-benchmark repositories** | see below — this one matters most |

`cancelled`, `skipped`, `neutral` and `timed_out` are **not results** and do not satisfy R2. A cancelled
run is precisely what made attempt 4 unanswerable.

### R4 excludes the inference benchmark, and that is not a formality

The six frozen REDs — `ant-design/ant-design`, `jantimon/html-webpack-plugin`, `lint-staged/lint-staged`,
`testing-library/jest-dom`, `vuejs/eslint-plugin-vue`, `vuejs/vue-loader` — are the corpus the inference
engine was **built against**. `INFERENCE_01` through `INFERENCE_05` were developed by looking at how they
failed. Reproducing one of them would be scoring the engine on its training data, and any result would
be uninterpretable in exactly the direction that flatters DiffCI.

## R3 must not consult the inference engine

**Qualification runs the hand-transcribed reference arm only.** The engine is not invoked, and its output
plays no part in whether a repository qualifies.

This is the safeguard that matters. If qualification ran both arms, a repository would become eligible
partly because the engine happened to handle it — selecting targets on which DiffCI already succeeds, and
converting the eventual result into a tautology. The engine sees the target for the first time *after*
it is sealed.

## Selection: first qualifier in rank order

Ascending rank, first repository satisfying R1–R4 is the target. No draw, no seed.

Earlier draws used a commit-hash-derived seed because the population was small and pre-computed. Here R3
costs up to 90 minutes per candidate, so qualifying a pool of five to then discard four is not defensible
spending. First-in-rank-order is equally unpickable by me: the order is external and the criteria are
fixed above.

**The bias this introduces, stated plainly:** "first suite that completes inside the budget" favours
*faster* suites, which likely means *smaller* ones. Smaller suites plausibly offer DiffCI **less** to
save, so the bias runs against a flattering result rather than toward one. It is still a bias, it is
recorded here, and it must be repeated in the result.

## The pinned head, chosen mechanically

The most recent commit on the default branch, **as of the moment R2 is evaluated**, whose in-environment
cell concluded `success` or `failure`. Not the newest commit, not a commit chosen for its content — the
newest one that produced a result to reproduce.

Recorded with its SHA and the check-run conclusion, so the ground truth travels with the target.

## What is fixed before execution

- **Zero human command repair.** If the reference arm needs a command the workflow does not state, that
  is a qualification failure, not something to hand-write.
- Every candidate's R1–R4 evaluation is recorded, **including the ones that fail**. A rejected candidate
  is evidence, not waste.
- Attempts 1–4 stay preserved exactly as recorded, including attempt 2's protocol violation, attempt 3's
  incorrect `DIVERGED` and attempt 4's incorrect `REPRODUCED`.
- If no repository in ranks 1–200 qualifies, the outcome is a **recorded empty population**, as in
  `docs/generation-c-population-exhaustion.md`. It is not a licence to relax a criterion.
- `REPRODUCED` remains unreachable without usable ground truth (defect 25) and unreachable when
  environment signals are present (defect 26).
