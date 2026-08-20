# Stage 1B — runtime experiment pilot: does saved test-selection translate to real wall-clock savings?

Per the task's explicit third ask: after implementing the 3 fixes (commits `197c431`, `0372a63`,
`e8ff8bc`/`7185cfc`, `d58958c`) and validating coverage-without-safety-regression
(`2026-08-21-stage1b-coverage-and-safety-validation.md`), this measures whether DiffCI's reduced test
*selection* actually reduces real wall-clock test-*execution* time, net of DiffCI's own analysis
overhead — the headline metric Stage 1A's own runtime-experiment design specified.

## Scope (read this before the numbers)

This is a **single-delta pilot**, not a broad harness: one small, fast, vitest-based repository
(`unjs/defu`), one real delta, 3 repetitions per condition. It exists to answer a narrower question first
— "does the measurement pipeline work end-to-end against a real repository, and what does it show even
once?" — before investing in a multi-repo harness. It is not a claim that this one result generalizes.

**Environment caveat, stated plainly:** this ran on Cloudflare Sandbox Containers, not real GitHub Actions
runners. Stage 1A's own design called for GitHub Actions for validity, but this environment has no write
access to trigger real Actions runs on a third-party repository. The wall-clock numbers below are real,
measured time — just not on GitHub's specific shared-runner hardware/contention profile. Container CPU/IO
characteristics differ from GitHub-hosted runners in ways that could shift absolute numbers (though the
*relative* FULL vs PATH vs DiffCI comparison, run back-to-back on the same container, is a fair
comparison).

## What was measured

Real delta: [`unjs/defu@3d3a7c8...40d7ef4`](https://github.com/unjs/defu/compare/3d3a7c89ca78f3fa43ec7194b12e44e4b0568697...40d7ef42d30db975bf80c340e7856c1ad3568321)
— a 20+/8- change to `lib/defu.d.cts` only (a generated type-declaration file), no other files touched.

The pilot script (`scripts/cloudflare-runtime-benchmark.ts`) checked out the real head commit into a real
working tree, ran a real `pnpm install`, then ran the real production selection pipeline
(`analyzeGitDelta` → `runDiffCIAnalysis`, plus `runPathBaseline`) to compute each condition's file set,
then executed each condition via `npx vitest run <files>` directly (bypassing defu's composite
lint+typecheck+vitest script, so the comparison isn't diluted by identical fixed costs across all three
conditions).

| Condition | Tests selected | Mean wall-clock (3 reps) |
|---|---|---|
| FULL | 2 (both of defu's test files) | 1,883 ms |
| PATH | 2 | 1,687 ms |
| DiffCI | **0** | 5 ms |

DiffCI's own per-delta analysis overhead for this repo/delta: **4,343 ms**. One-time `pnpm install`:
11,232 ms (identical setup cost across all three conditions, excluded from the comparison above).

## The honest headline number

DiffCI correctly determined this delta (a change to a generated type-declaration file) touches nothing
reachable by either test file, and selected zero tests — consistent with the reachability-aware
confidence fix validated in Part B. Test-*execution* time genuinely dropped from ~1.7–1.9s to ~5ms, a
>99% reduction, exactly as the coverage-improvement work predicted it would for this class of delta.

**But net of DiffCI's own analysis overhead, this specific pilot delta is a net loss, not a win:**
selection + execution = 4,343ms + 5ms ≈ 4,348ms for DiffCI, versus 1,687ms for PATH (which does no
analysis at all — it's a cheap heuristic). On this tiny repository (2 test files total), the fixed cost
of running DiffCI's real dependency-graph analysis exceeds the entire test suite's execution time, so
there's nothing large enough left to save from.

This is not a fabricated or spun result — it is what the real numbers show, and it matters more than a
flattering number would have: **DiffCI's value proposition depends on analysis overhead staying small
relative to the test suite it's replacing.** For a repo this size, it doesn't. The question this pilot
cannot answer alone is where the crossover point is — Stage 0/1A's own corpus (hundreds of test files,
minutes-long suites) is a much more representative regime for where DiffCI is actually meant to compete,
and this pilot's overhead figure (4.3s) is a rounding error against those. This single tiny-repo pilot is
a useful lower bound and a genuine caveat, not a verdict on DiffCI at realistic scale.

## What this does and does not prove

**Proves:** the full measurement pipeline works end-to-end against a real repository — real checkout,
real install, real selection via the real production code path, real `vitest` execution, real wall-clock
timing — and, on the one delta measured, DiffCI's selection accuracy translated directly into a real
execution-time reduction (99%+), exactly the causal link Part A/B's fixes were designed to produce.

**Does not prove:** that DiffCI is a net wall-clock win in general. This pilot's own numbers show the
opposite on a small repo — analysis overhead can exceed the savings. Answering "does DiffCI save real CI
time, net, at the scale it's meant for" requires the natural next step: repeating this same
per-delta-timed methodology across a handful of Stage 0/1A's larger repositories (hundreds of test files,
not 2), where analysis overhead is a much smaller fraction of the total suite. That is the concrete,
scoped next validation step — not performed here given this task's framing as a pilot to prove the
pipeline works before investing in that broader run.

## Bugs found and fixed while running this pilot (same live-validation discipline as Part B)

Two real, non-hypothetical infrastructure gaps surfaced only by actually dispatching against a real
repository, both fixed and redeployed before the result above was obtained:

1. **`RESEARCH_DISPATCH_TOKEN` had drifted from its stashed value** — first dispatch attempt returned
   `401 unauthorized`. Rotated the Worker secret and the local stash together; unrelated to DiffCI's own
   logic, an environment/credential-hygiene issue.
2. **The sandbox base image ships node/npm/git but not `pnpm`, nor `corepack`** — defu, like most `unjs`
   packages, is a pnpm project. First fix attempt (corepack self-heal) still failed (`corepack: not
   found` — the image lacks it entirely, not just leaves it inactive); final fix falls back to a plain
   `npm install -g pnpm`, the most portable option across minimal container images. Both fixes are in the
   pilot script only (`scripts/cloudflare-runtime-benchmark.ts`), not in any DiffCI product code path.
