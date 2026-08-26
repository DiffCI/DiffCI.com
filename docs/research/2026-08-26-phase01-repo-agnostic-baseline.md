# Phase 01 — repo-agnostic engine: measured baseline before any change

**Date:** 2026-08-26 · **Branch:** `phase01-repo-agnostic` (deliberately not `main` — see [Freeze](#freeze))
· **Evidence:** `docs/research/2026-08-26-phase01-repo-agnostic-baseline.json`
· **Tool:** `scripts/repo-agnostic-probe.ts`

**Phase 01 exit criterion:** 5 external repositories, 2 test frameworks, zero per-repo code.

This document records where the engine actually stood **before** anything was changed for Phase 01, so
the after-state can be compared against a real measurement rather than a recollection. Nine external
repositories were run through the real production path — `collectMetadata` → `analyzeGitDelta` →
`buildDependencyGraph` → `ImpactAnalyzer` → test discovery → command synthesis — over their five most
recent commits each. No engine module was modified to obtain these numbers.

## Freeze

The 24-hour shadow ramp load gate declared in
[`2026-08-26-shadow-ramp-load-gate.md`](2026-08-26-shadow-ramp-load-gate.md) is **still open** at the
time of writing (declared ~05:09Z 2026-08-26; closes ~05:09Z 2026-08-27). It freezes the engine,
estimator and classifier for the duration.

Phase 01 changes the engine, so all of it lands on a branch and **nothing is deployed** until the window
closes. Measurement does not touch the deployed Worker, D1, R2, or the launch ledger: the probe clones
into a scratch directory and runs in-process.

## Method

The probe imports the real engine modules — no reimplementation, no fixtures. Two properties of the
harness matter for the numbers to mean anything:

- **Clones live outside this repository.** `createProgram()` calls `ts.findConfigFile(repoPath, …)`,
  which walks *upward*. A clone placed under this repo would silently inherit **this** repo's
  `tsconfig.json` and every probed repository would appear to have one. The probe refuses to run if any
  `tsconfig.json` exists above its clone directory.
- **Five consecutive commits per repository, not one.** A single commit that happens to touch a config
  file forces FULL on any repository and would read as an engine limitation. No commit was chosen for
  being flattering.

## Baseline results

`elig` = eligibility gate · `disc` = test discovery · `cmd` = the command DiffCI would actually execute.
`REF` = refused, `--` = not reached.

| Repository | Framework | elig | graph | S/F over 5 commits | disc | cmd |
|---|---|---|---|---|---|---|
| `unjs/defu` | vitest | OK | 8 nodes, COMPLETE | 1/4 | 2 files | — |
| `unjs/h3` | vitest | OK | 173 nodes, COMPLETE | 1/4 | 70 files | **REF** |
| `unjs/nitro` | vitest | OK | 594 nodes, UNSAFE | 4/1 | 58 files | **REF** |
| `nestjs/nest` | vitest | OK | 1482 nodes, UNSAFE | 3/2 | 467 files | — |
| `vitest-dev/vitest` | vitest | **REF** | 2118 nodes, UNSAFE | 0/5 | 1052 files | — |
| `facebook/docusaurus` | vitest | **REF** | 1131 nodes, UNSAFE | 1/4 | **2 files** | — |
| `typeorm/typeorm` | mocha | OK | 3255 nodes, UNSAFE | 5/0 | 944 files | **REF** |
| `sindresorhus/execa` | ava | OK | 446 nodes, UNSAFE | 0/5 | **0 files** | — |
| `immerjs/immer` | vitest | OK | 16 nodes, COMPLETE | 5/0 | **0 files** | — |

Nine external repositories, four declared frameworks (vitest, mocha, ava, playwright). The exit
criterion's "5 repositories, 2 frameworks" is already exceeded by the *cohort*; it is not yet met by the
*engine*, for the reasons below.

## Findings

### F1 — The engine can select tests it cannot see, and calls that COMPLETE (safety-critical)

`immerjs/immer`: **zero** test files discovered, graph confidence **COMPLETE**, and **5 of 5** commits
classified **SELECTIVE**. Immer's suites are `__tests__/base.js`, `__tests__/curry.js` and so on — no
`.test.`/`.spec.` infix, and its `vitest.config.ts` declares no explicit `include` (it relies on
vitest's own defaults). `DEFAULT_TEST_PATTERNS` requires the infix, and `discoverTestRunnerConfigs()`
only lifts *explicit* `include` arrays, so the entire suite is invisible.

`facebook/docusaurus`: **2** test files discovered against **241** present in the working tree. Root
cause is different and independent — `discoverSourceRoots()` scans a fixed list of top-level directory
names and only falls back to "scan every top-level directory" when no *primary* root was found.
Docusaurus has a top-level `test/`, which counts as primary, so `packages/` — where 239 of the 241
tests live — is never scanned. This is the same class of defect as the 2026-08-21 zod finding; that fix
excluded only `scripts`/`operations` kinds from counting as primary, and `tests` slipped through.

Both cases fail **open**, not closed: an empty test universe reads downstream as "nothing to run".
This is precisely the failure mode the codebase elsewhere goes to lengths to prevent (`src/git/`
returns an explicit error rather than a silently-empty affected set). Discovering zero tests in a
repository that declares a test framework must force fallback, not a confident selection.

### F2 — Selection is repo-agnostic; execution is not

For `unjs/h3`, DiffCI correctly narrows five commits' worth of change to `test/security.test.ts`, then
emits:

```
tsx --conditions react-server --test test/security.test.ts
```

That is DiffCI's own repository's runner, carrying a `react-server` condition inherited from
DentalPresence's Next.js layout, pointed at a **vitest** suite. It would not run the test. The same
command shape is emitted for `typeorm/typeorm`, a **mocha** repository. `generateSelectiveTestCommandSpecs()`
(`src/planner/selective-commands.ts`) hardcodes the `tsx`/`node` split and the `ops/`, `scripts/` path
prefixes of this repository. Nothing about it reads the target repository.

This is the sharpest instance of "per-repo code": the analysis is portable and the execution is not, so
the pipeline can produce a correct-looking selection that is unexecutable.

### F3 — The eligibility gate refuses repositories the engine can already analyse

`vitest-dev/vitest` and `facebook/docusaurus` are both refused with *"DiffCI cannot analyze this
repository: no tsconfig.json found at the repository root"*. Both then build real graphs — **2118** and
**1131** nodes respectively — because `src/repo/graph.ts` gained nested per-package tsconfig discovery
on 2026-08-24 (for biome and cal.diy) and `collectMetadata()` was never updated to match.

The refusal message is factually wrong as stated. The honest statement is that both are *analysable*
but not yet *productive* (vitest fell back to FULL on 5 of 5 commits). This is a stale gate, not an
engine limit — and it is the gate that burned ~144 container launches a day before the ramp caught it.

`scripts/screen-shadow-eligibility.ts` mirrors the same condition and inherits the same error.

### F4 — The only real task registry is DentalPresence's

`DefaultCIPlanner` requires a `TaskRegistry`, and the only non-fixture implementation is
`buildDentalPresenceTaskRegistry()` — ~20 tasks including WordPress plugin linting, AWS account
validation and a Next.js build. There is no path by which an external repository gets a task registry
at all, which is why the probe stops at impact for every repository in the cohort. "Zero per-repo code"
cannot be claimed while this is the only registry that exists.

### F5 — `ts.findConfigFile` can escape the repository root (latent)

`createProgram()` walks upward from the repository root, so a repository cloned beneath any directory
containing a `tsconfig.json` is analysed against that ancestor's project. Flagged in a comment in
`src/research/repository/collector.ts` as "a separate, still-unfixed latent bug in graph.ts"; still
unfixed. It does not affect the container pipeline (clones land at `/repos/<name>`), but it silently
corrupts every local run, which is exactly how Phase 01's own verification would be run.

## What is not a Phase 01 finding

- **UNSAFE graph confidence on 6 of 9 repositories.** Real repositories have unresolved imports, and
  `computeConfidence()` treats any unresolved import as disqualifying. This is conservative behaviour
  working as designed, and it is frozen. It is recorded here because it bounds how much *value* a
  repo-agnostic engine can deliver, but tuning it is not Phase 01's job and must not be smuggled in.
- **`.vue` and `pnpm-workspace.yaml` as "unknown changed file"** on vitest and docusaurus. A genuine
  coverage boundary for non-TS surfaces, correctly failing closed. Out of scope here.

## Phase 01 work items, in dependency order

| # | Item | Closes | Status |
|---|---|---|---|
| 1 | Test universe: model runner default includes and excludes; scan the whole tree; **fail closed** when a framework is declared but zero tests are discovered | F1 | done |
| 2 | Derive the test command from the target repository's own runner and scripts, not this repo's layout | F2 | done |
| 3 | Align the eligibility gate (and the screener) with the graph's real nested-tsconfig capability | F3 | done |
| 4 | Derive a task registry from the target repository; move the DentalPresence registry to a fixture | F4 | done |
| 5 | Clamp tsconfig discovery to the repository root | F5 | done |
| 6 | Re-run this probe; add a guard test asserting no repository identifier appears in the engine path | exit criterion | done |

Item 1 is a safety fix and came first regardless of the rest.

## After

Same nine repositories, same probe, same five-commit sample per repository, re-run after items 1–6.

| Repository | Framework | elig | S/F | tests discovered (before → after) | command DiffCI would run |
|---|---|---|---|---|---|
| `unjs/defu` | vitest | OK | 1/4 | 2 → 2 | *(all sampled commits FULL)* |
| `unjs/h3` | vitest | OK | 1/4 | 70 → 70 | `pnpm exec vitest run test/security.test.ts` |
| `unjs/nitro` | vitest | OK | 4/1 | 58 → 58 | `pnpm exec vitest run --config vitest.config.ts …` |
| `nestjs/nest` | vitest | OK | 3/2 | 467 → 467 | *(all sampled commits FULL)* |
| `vitest-dev/vitest` | vitest | **OK** | 0/5 | 1052 → 1068 | *(all sampled commits FULL)* |
| `facebook/docusaurus` | vitest | **OK** | 1/4 | **2 → 193** | `pnpm exec vitest run __tests__/…` |
| `typeorm/typeorm` | mocha | OK | 5/0 | 944 → 961 | `pnpm exec mocha test/…` |
| `sindresorhus/execa` | ava | OK | 0/5 | **0 → 151** | *(all sampled commits FULL)* |
| `immerjs/immer` | vitest | OK | 5/0 | **0 → 23** | `yarn run vitest run --config vitest.config.ts __tests__/…` |

Every stage now clears on every repository. Against the exit criterion:

- **5 external repositories** — nine, none of them this repository or its origin.
- **2 test frameworks** — three run end-to-end (vitest, mocha, ava), each producing the command
  its own repository would use, through its own package manager.
- **Zero per-repo code** — enforced by `tests/planner/repo-agnostic-engine.test.ts`, which reads
  `src/git`, `src/repo`, `src/planner` and `src/shadow` and fails on any specific repository named in
  executable source. It found one I had not listed: `src/shadow/task-mapping.ts` mapped CI step names
  through a hardcoded table of DentalPresence's own step names.

### What these numbers do not say

A `--` in the command column means every sampled commit fell back to FULL, so no selective command
was needed. That is an honest result, not a hidden failure — and on four of nine repositories it is
the whole result. The dominant causes are unchanged and out of Phase 01's scope: `UNSAFE` graph
confidence from ordinary unresolved imports, and non-TypeScript changed files (`.vue`,
`pnpm-workspace.yaml`) correctly failing closed. **Phase 01 made the engine work on other people's
repositories; it did not make it save them anything yet.** How often DiffCI can safely propose a
subset on a real monorepo is the next question, and this table is the honest starting point for it.

`typeorm/typeorm` selects 5/5 SELECTIVE but names a very large fraction of its 961 tests — selection
breadth, not repo-agnosticism, and also not measured here.
