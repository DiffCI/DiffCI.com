# Stage 2E — D5 pre-registration

Written and committed **before** D5's real experimental commit, prediction, or CI result exist. This is
the immutable record required by Stage 2E's own task spec ("create a durable pre-registration before
pushing the experiment... explicit statement that the classification will not be changed after seeing
the result"). Do not edit the expectations below after seeing a real result; append findings to
`2026-08-22-stage2e-final-report.md` instead.

## Experiment ID

**D5**

## Repository

`adityankale190895/DiffCI.com`, `main` — same repository as D1-D4, for the same reasons already
established in `docs/research/2026-08-22-stage2d-experiment-preregistration.md` (third-party repos and
DentalPresence.in out of scope; the target-repo/engine decoupling makes it safe to touch real `src/`
files here — see that document's "why touching core files is safe" note, which applies identically here
since none of D1-D5's commits are followed by a Worker redeploy).

## Reconnaissance already performed (disclosed in full, per Part 3)

Before choosing D5, the following was read/searched, to identify a genuinely different, real (not
manufactured) dependency shape not already covered by D1 (direct), D2 (transitive), D3 (fan-out), or D4
(config boundary/FULL fallback):

- Checked `tsconfig.json` for path aliases (`paths`/`baseUrl`) — **none exist**. Option A (alias/path
  resolution) is not naturally present in this repository; not used.
- Checked `package.json` for npm/yarn workspaces — **none exist**. A literal workspace-boundary crossing
  (Option B's preferred form) is not naturally present.
- Checked for `.json` (or other asset-extension) files imported via a real ES `import` statement anywhere
  in `src/` — **none found**. `src/repo/graph.ts` and `src/repo/impact.ts` confirm the graph *would* model
  such a relationship (asset nodes + `ASSET_DEPENDENCY` propagation to dependent tests) if one existed,
  but none currently does.
- Checked all `readFileSync`-based data loads in `src/` (`analyzer.ts`, `graph-cache.ts`,
  `shadow/persistence.ts`, `research/store/evidence.ts`) — these only ever read `package.json`/
  `tsconfig.json` (already classified as `CONFIG_GLOBAL` → FULL fallback, redundant with D4) or their own
  output/cache files (not real input fixtures). No checked-in `tests/fixtures/*.json` file is currently
  read by any passing test (`grep` for `stage1a-safety-cases` across `src/`+`tests/` returns nothing) —
  Option D (fixture/data dependency) has no genuine, currently-tested instance in this repository. Not
  used, rather than manufacturing one.
- Checked real internal dynamic `import()` usage (Option C): found one genuine case,
  `src/shadow/reconcile.ts`'s fallback `await (await import("./github-baseline.js")).fetchBaselineEvidence(...)`
  and `src/research/benchmark/runner.ts`'s `buildRepoProfile()` (`await import("../../repo/analyzer.js")`).
  For the `reconcile.ts` case, confirmed by reading `tests/shadow/reconcile.test.ts` that every test case
  injects an explicit `fetchFn`, so the real dynamic-import branch is never exercised at runtime by any
  passing test — ruled out (a bug there could not cause a real test failure). The `runner.ts` case's
  direct test coverage (`resumability.test.ts`) also doesn't assert on analyzer output content.
- Used DiffCI's own `buildDependencyGraph()` (via a throwaway local script, deleted before this
  pre-registration was written, never committed) to compute the real `transitiveDependentsOf(...)` for
  several candidate target files, to verify which real test files structurally depend on them — this is
  the "ensure the intended test genuinely fails" reconnaissance Part 3 explicitly permits, not a search for
  a case DiffCI is already known to select correctly (SELECTIVE-mode inclusion was never checked; only the
  raw graph edges and, separately, real local `npm test` execution).
- Applied the exact D5 candidate bug (below) locally, ran the full local suite once, recorded exactly
  which real test files failed, then reverted before committing anything. Result: **exactly two** files
  failed locally — `tests/repo/analyzer.test.ts` (direct/same-directory) and
  `tests/research/test-count-tracking.test.ts` (the cross-directory target below). No other file in the
  9-file dependent set failed. This local run is disclosed in full; the classification below is fixed
  before the real commit is pushed.

## D5 — cross-directory (package-boundary) test-discovery failure

- **Target file:** `src/repo/analyzer.ts`
- **Change:** in `scanFiles()`, negate the file-entry guard — `if (!entry.isFile()) continue;` becomes
  `if (entry.isFile()) continue;` (a realistic negation-typo regression: the walk now recurses into every
  directory but never invokes the callback for an actual file, so `discoverTests()` finds zero test files
  in any repository profile it builds).
- **Expected failing test:** `tests/research/test-count-tracking.test.ts` — "counts real individual test
  files and correctly narrows selection for a SELECTIVE-mode change"
  (`assert.equal(testsTotal, 3, "should find all 3 real test files, not a glob-pattern count")`, plus the
  following `assert.ok(testsSelectedByDiffci >= 1 ...)` line in the same test).
- **Dependency shape — genuinely different from D1-D4:** `tests/research/test-count-tracking.test.ts`
  (in `tests/research/`) → `src/research/diffci/adapter.ts`'s `runDiffCIAnalysis` (in `src/research/diffci/`)
  → `src/repo/graph.ts`'s `buildDependencyGraph` (in `src/repo/`) → `src/repo/analyzer.ts`'s
  `analyzeRepository`/`discoverTests` (also in `src/repo/`, imported by `graph.ts` at its top: `import {
  analyzeRepository, ... } from "./analyzer.js"`). This is a real, three-hop chain that crosses from the
  research/benchmarking subsystem, through the core repo-analysis subsystem, into a foundational
  test-discovery utility — the first Stage 2D/2E experiment to leave `src/shadow/` entirely (D1-D3 all
  targeted files inside `src/shadow/`; D4 targeted root `tsconfig.json`). `adapter.ts` does **not**
  directly import `analyzer.ts` (confirmed by reading its import list) - the connection is only real via
  `graph.ts`, which is what makes this a genuine transitive/cross-package chain rather than a relabeled
  direct dependency.
- **Why this adds evidence beyond D1-D4:** D1-D3 all proved DiffCI's graph reasons correctly about
  dependencies *within* one subsystem (`src/shadow/`). D4 proved a global-config-file boundary case. D5
  tests whether the same graph-traversal mechanism generalizes correctly when the dependency chain crosses
  real architectural/directory boundaries into a foundational, cross-cutting utility
  (`analyzer.ts`) that is depended on by code in `src/repo/`, `src/research/`, and `src/shadow/` alike —
  a structurally different question from "does a fan-out shared utility inside one subsystem get both its
  consumers selected" (D3).
- **Expected DiffCI behavior:** SELECTIVE prediction whose selected-test set includes
  `tests/repo/analyzer.test.ts` and, if the graph's traversal correctly reaches across the
  research→repo boundary, `tests/research/test-count-tracking.test.ts`.
- **What constitutes a false negative:** a SELECTIVE prediction that omits
  `tests/research/test-count-tracking.test.ts` from the selected set despite the real three-hop import
  chain (`test-count-tracking.test.ts` → `adapter.ts` → `graph.ts` → `analyzer.ts`) existing and being the
  file that actually changed.
- **Whether this counts toward Gate C:** **YES, unconditionally, if a real test executes and fails and is
  correctly represented as `relevant_failures_evaluable >= 1`.** Unlike D4, this bug is inside
  `src/repo/analyzer.ts`, invoked from DiffCI.com's own `tests/**/*.test.ts` suite via `npm run test`
  (part of `npm run check = typecheck && test`) — `typecheck` is unaffected by this change (no type
  signature changes, only a boolean condition), so `test` genuinely runs and genuinely fails. This is not
  a repeat of D4's typecheck-short-circuit limitation.
- **Explicit statement:** the classification of D5's result (SAFE_SELECTIVE / SAFE_CONSERVATIVE_FULL /
  FALSE_NEGATIVE / NOT_EVALUABLE) will be determined strictly by the automated evidence gathered after the
  real CI run and reconciliation, and will **not** be changed, redefined, or reinterpreted after the fact
  to obtain a more favorable Gate C outcome.

## Ordering and gating

Preceded by: clean working tree (confirmed), `git status` clean, local `npm test` green (0 failures,
confirmed after reverting the local recon run above), latest CI (`1bb6cc4`) green (confirmed via `gh run
list`), Shadow Worker `/health` OK and webhook `app-info` showing healthy recent deliveries (confirmed),
`reconcile-diagnostics` showing 62 total / 60 reconciled / 2 pending (the same pre-existing DentalPresence
stuck rows as before D4, unchanged — not a new anomaly), no unresolved experimental prediction (confirmed:
nothing pending besides the two known-stuck DentalPresence rows).

Per Part 6, reconciliation for D5 will **prefer the autonomous Cloudflare cron** over an immediate manual
`/v1/shadow/cron-run` call if the webhook races GitHub's eventual-consistency window (the pattern already
observed for D1 and D4) — manual triggering will only be used if autonomous cron recovery does not occur
within a reasonable multiple of its own interval, and will be labeled as such if it happens.

Stop immediately and report `STAGE 2 SAFETY FAILURE` if D5 shows
`failures_preserved_by_diffci < relevant_failures_evaluable` for a SELECTIVE prediction — do not create a
D5b, do not fix the algorithm first.
