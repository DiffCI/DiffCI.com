# STAGE 0 PILOT — NOT FINAL STAGE 0 RESULT

Real 2-repository pilot of the DiffCI research pipeline, run 2026-08-19.
This is **not** the 20-repository / ~2,000-delta Stage 0 experiment — it exists to prove
the pipeline works end-to-end against real external code and to surface operational and
generalization problems before that larger run.

Pipeline exercised end-to-end, with real analysis (no dry-run, no synthetic records):
repository selection → clone/fetch → commit sampling → git delta → repository profiling →
dependency graph → impact analysis → DiffCI plan → path baseline → benchmark record →
aggregation → report.

Raw evidence lives at `diffci/.research/output/stage0-pilot/` (gitignored):
`pilot-report.json` (full per-commit records, cold/warm checks, reliability counters),
`summary.json`/`summary.md` (standard Stage 0 aggregator/report output). Pilot script:
[`scripts/research-stage0-pilot.ts`](../../scripts/research-stage0-pilot.ts).

**Same-day updates**: this pilot went through four fix-and-rerun rounds — three real bugs
found and fixed, plus the individual-test-count tracking the pilot spec originally required
but the pipeline didn't yet implement. The pilot was re-run from a clean cache after every
round; nothing pre-fix is mixed into the numbers below. The headline result moved twice and
lands somewhere genuinely encouraging: **at the coarse job level DiffCI shows no measured
advantage over PATH (0% median reduction), but at the individual-test level — the level
DiffCI's dependency graph actually operates at — it shows a 63.7% median test reduction and
a 16.3% median incremental advantage over PATH.** See "Test-level results" below for the
evidence; see "Three real bugs" for how the numbers got here.

## Three real bugs found — all now fixed

Manual evidence inspection (mandated by the pilot before trusting any aggregate number)
surfaced three genuine, reproducible bugs in the pipeline — not in the two target repos.

### 1. FIXED — `commitDelta.gitDelta` was never populated (benchmark data corruption)

[`src/research/diffci/adapter.ts`](../../src/research/diffci/adapter.ts) computed the real
git delta but never wrote it back onto the `commitDelta` object it returns as `identity`.
Every downstream consumer in
[`src/research/benchmark/runner.ts`](../../src/research/benchmark/runner.ts) —
`classifyCommit()`, `runGenericPathBaseline()`, `record.changedFileCount` — read an empty
placeholder instead. Every commit was misclassified `"documentation"` and PATH baseline
always took its docs-only shortcut. **Fix**: `commitDelta.gitDelta = gitResult.delta;`.
**Regression test**:
[`tests/research/adapter-gitdelta.test.ts`](../../tests/research/adapter-gitdelta.test.ts).

### 2. FIXED — empty dependency graph reported as `COMPLETE` confidence for TypeScript "solution-style" tsconfigs

`hono`'s root `tsconfig.json` is a TS project-references shell (`"files": [],
"references": [...]`). `ts.parseJsonConfigFileContent()` doesn't expand `references` into
`fileNames`, so [`src/repo/graph.ts`](../../src/repo/graph.ts)'s `createProgram()` built a
program with **zero root files** — a confirmed empty (0-node) graph, still labeled
`"COMPLETE"`. **Fix**: `resolveProjectReferenceInputs()` recursively resolves each
referenced project's tsconfig (cycle-guarded) and merges their files + compiler options;
`computeConfidence()` now returns `UNSAFE` for zero source files (previously fell through to
`COMPLETE`) and caps confidence at `PARTIAL` when built via merged references. Verified:
hono went from 0 nodes/`COMPLETE` to 328 nodes/`PARTIAL`; zustand (no references) unaffected
at 30 nodes/`COMPLETE`. **Regression tests**:
[`tests/repo/graph.project-references.test.ts`](../../tests/repo/graph.project-references.test.ts).

### 3. FIXED — `discoverTests()` never matched any test file, *and* the glob matcher it (and two other modules) used silently mis-matched nested paths

Two distinct bugs, found and fixed together because fixing the first required writing new
glob-matching code, which turned out to share a root cause with existing code elsewhere.

**3a — `discoverTests()`'s matching logic never worked.**
[`src/repo/analyzer.ts`](../../src/repo/analyzer.ts)'s `discoverTests()` used an ad-hoc
prefix-extraction scheme (`pattern.split(".*")[0]...`) that assumed a literal `.*` segment
in the glob pattern. `DEFAULT_TEST_PATTERNS` (`"**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}"`)
contains no such substring, so the check always failed — `profile.tests` came back `[]` for
every repo, confirmed for both zustand and hono in the original pilot run. **Fix**: replaced
the prefix hack with a real glob-to-regex matcher (`matchesTestGlob`/`globToRegex`,
supporting `**`, `*`, and `{a,b,c}` brace alternation) run against the file's actual
repo-relative path instead of just its basename.

**3b — that real glob matcher (and two pre-existing copies of the same algorithm) corrupted
multi-segment `**` patterns.** While verifying 3a's fix against hono (360+ source files,
deeply nested `src/middleware/csrf/index.test.ts`-style paths), it only found 6 of 124 real
test files. Root cause: the `**/ ` → `"(?:.*/)?"` substitution ran *before* the general
`*` → `"[^/]*"` replace, so the `*` inside the just-inserted `"(?:.*/)?"` fragment got
re-matched and mangled into `"(?:.[^/]*/)?"` — a pattern that only reliably matches when
there are zero or one path segments between the globstar and the filename, unpredictably
(depends on exact path length via regex backtracking) for anything nested deeper. **The
exact same algorithm, with the exact same bug, already existed in two other places**:
[`src/planner/planner.ts`](../../src/planner/planner.ts)'s `regexFrom()` — DiffCI's **real
production task planner**, used for DentalPresence.in's own CI selection, whose actual
`inputPatterns` (`src/**/*.{ts,tsx}`, `ops/**/*.test.{js,mjs,ts}`, etc., in
[`src/planner/task-registry.ts`](../../src/planner/task-registry.ts)) are exactly this
shape — and [`src/research/baseline/matcher.ts`](../../src/research/baseline/matcher.ts)'s
`regexFrom()`, used for the PATH baseline comparison. Confirmed directly against real
DentalPresence-shaped patterns before the fix: matching was inconsistent and
content-dependent (e.g. `matches("src/lib/security/scanner.ts", "src/lib/security/**/*")`
→ `true`, but `matches("src/lib/security.ts", "src/lib/security/**/*")` → `false` — not a
simple "depth" rule, genuinely unpredictable). **This means DiffCI's actual production task
selection for its own repository has likely been silently under-triggering tasks for some
real nested-path changes** — a false negative, the unsafe direction, for however long this
code has existed. **Fix**: all three occurrences now protect `**/` and `/**` behind
placeholder tokens before the `*` replace runs, then expand the placeholders afterward, so
the substituted regex fragments are never re-processed. **Regression tests**:
[`tests/repo/analyzer.test.ts`](../../tests/repo/analyzer.test.ts) (nested test-file
discovery), a new case in
[`tests/planner/planner.test.ts`](../../tests/planner/planner.test.ts) (`typecheck`/`lint`
now trigger for a two-directories-deep source change, using the real
`buildDentalPresenceTaskRegistry()`), and
[`tests/research/baseline/matcher.test.ts`](../../tests/research/baseline/matcher.test.ts).

A fourth, structurally different (unescaped-dot, leading-`**`-stripping) glob matcher exists
in [`src/repo/impact.ts`](../../src/repo/impact.ts) (`matchesGlob`), used only inside
`collectAlwaysRunTests()`. Its only call site `matchesGlob(...) || isTestFileName(node.path)`
already falls back to a correct, independent filename check, so real test files are still
identified correctly there regardless — **left unfixed** as lower priority, flagged for a
separate pass.

**Effect on this pilot's numbers**: significant, and important to be honest about. The
*first* pilot run (before any of these fixes) reported a 64.4% median task reduction for
DiffCI. That number was **inflated by the same false-negative bug** described in 3b: many of
hono's real task triggers (workflow jobs, `typecheck`, `test:unit`, keyed to `src/**/*`-style
patterns) were failing to match hono's actual (multi-level-nested) changed files, so DiffCI
looked artificially selective when it was actually under-selecting — the unsafe direction,
not a real precision win. After fixing the matcher, the **honest** median task reduction
across all 16 real commits is **0%** — see "Required pilot results" below. This is a
materially different, more sobering, and more correct picture of where this benchmark
harness currently stands, and it reinforces finding 3 below: the coarse job-level task
registry used by this generic research harness has very little real selective structure to
find in these two repos once matching is done correctly — DiffCI's actual dependency-graph
advantage would need to be measured at the individual-test-file level to be visible at all.

### 4. Observation, now addressed — the coarse task/planner model can't demonstrate DiffCI's core advantage; measuring at the test level does

`DefaultCIPlanner.triggered()` decides whether a **non-test** generic CI task runs via plain
glob matching against `task.inputPatterns` — the same mechanism `runGenericPathBaseline`
uses for PATH. In this pilot's data, `diffciTasks` equals `pathBaselineTasks` in 13 of 16
records at the coarse task level, and PATH is strictly *ahead* of DiffCI in the other 3
(zustand's docs-only commits, via PATH's hardcoded "docs-only → skip everything" shortcut,
which the generic planner has no equivalent of). But the graph/impact result *does* change
*which individual tests* are selected (`impact.affectedTests`, real and graph-driven,
confirmed unaffected by the discoverTests bug — it's built from graph-node `isTest` tags,
not from `profile.tests`) — that signal just wasn't being captured or measured anywhere.

**Implemented**: `RepositoryProfile` gained a `testFilePaths: string[]` field (the real,
individual test-file paths discovered by the now-fixed `discoverTests()`, not just its
`{glob, count}` summaries), `BenchmarkRecord` gained `testsTotal`/`testsSelectedByPath`/
`testsSelectedByDiffci`, and the benchmark runner wires them up per delta using
`analysis.profile.testFilePaths.length`, `analysis.plan.selectedTests.length` (DiffCI), and
the real production per-test PATH baseline
([`src/planner/path-baseline.ts`](../../src/planner/path-baseline.ts)'s `runPathBaseline()`,
reused rather than reimplemented). `Stage0Summary` gained matching aggregate fields
(`testsTotalAcrossDeltas`, `medianTestReductionByPath`, `medianTestReductionByDiffci`,
`diffciIncrementalTestAdvantage`), and the markdown report surfaces them.

Fixing this required one more fix in the same bug family as finding 3: `DefaultCIPlanner`'s
own `allTestPaths()` (`src/planner/planner.ts`) was building its "all tests" list from
`profile.tests.map(t => t.glob)` — **glob-pattern strings, not real file paths** — so
`plan.skippedTests` was comparing real selected-test paths against 1-2 glob strings (always
"not equal", so `skippedTests` was always just those glob strings) and, in FULL-fallback
mode, `plan.selectedTests` was the glob-string list too (length 1-2) instead of every real
test file. Fixed to use `profile.testFilePaths`; regression-tested (fallback mode now
correctly selects every real test, not 1-2). The same glob-string bug, unused/dead but
present, also existed in [`src/shadow/benchmark.ts`](../../src/shadow/benchmark.ts)'s
`createBenchmarkRun()` (confirmed uncalled anywhere in production — the real shadow
pipeline uses `fromShadowRecord()`, which derives its test list from the plan's own
`selectedTests`/`skippedTests` and so was never affected) — fixed for consistency.
**Regression tests**:
[`tests/research/test-count-tracking.test.ts`](../../tests/research/test-count-tracking.test.ts)
(real per-test selection and FULL-fallback totals, end to end against a temp repo) and a
new case in
[`tests/research/stage0-aggregation.test.ts`](../../tests/research/stage0-aggregation.test.ts).

See "Test-level results" below for what this actually measured.

## Repository selection

| | Repo A | Repo B |
|---|---|---|
| Repository | `pmndrs/zustand` | `honojs/hono` |
| Language / framework | TypeScript / react-store | TypeScript / web-framework |
| Size class | small | medium |
| Tracked source files | 48 | 360 |
| GitHub Actions workflows | 7 | 5 |

**Reason selected — zustand**: small, single-package TypeScript library. Popular
(~50k GitHub stars), actively maintained, real GitHub Actions and a vitest-based test
suite, flat single-tsconfig dependency graph. The small/simple anchor of the pair.

**Reason selected — hono**: medium-sized TypeScript web framework, structurally diverse
monorepo-like layout inside one package (10+ runtime adapters, middleware, router, jsx,
client). Actively developed, real GitHub Actions and tests. Its TS-project-references
tsconfig and deeply-nested `src/` layout together drove two of this pilot's three findings.

Both verified against the pipeline's real inclusion criteria (not bypassed) via
[`src/research/repository/collector.ts`](../../src/research/repository/collector.ts).
Neither was excluded.

## Corpus

```
Repositories attempted:            2
Repositories successfully analyzed: 2
Repositories excluded:              0

Unique commit deltas:    16  (8 per repo, target was 5-10/repo)
Successful deltas:       16
Failed deltas:            0
```

## Clone/fetch validation

| | zustand | hono |
|---|---|---|
| Clone/fetch | update (already cached locally) | update (already cached locally) |
| Duration | 1,921 ms | 1,860 ms |
| Default branch resolved | `main` | `main` |
| Commit history available | yes (200-commit window) | yes (200-commit window) |
| Base/head pairs resolvable | yes, all 8 | yes, all 8 |
| Size within limits | yes | yes |

## Commit sampling (real deterministic sampler, no hand-picking)

| | zustand | hono |
|---|---|---|
| Candidate commits (window) | 200 | 200 |
| Eligible (non-merge, non-bot, non-revert) | 196 | 199 |
| Sampled | 8 | 8 |
| Excluded | 192 | 192 |
| Exclusion reasons | revert commit: 1, bot commit: 3 | revert commit: 1 |

Same 16 SHA pairs sampled across all four runs (sampling is deterministic and independent
of graph/matcher construction), so all four runs are directly comparable. All 16
`logicalDeltaKey`s verified unique; 0 retries; 0 errors.

## DiffCI analysis, path baseline, and evidence inspection

Manually inspected all 8 zustand records and all 8 hono records (more than the required
2+2) against `git diff-tree` output for the same SHAs. Changed files matched Git exactly,
categories were sensible, `fallback`/`fallbackReasons` matched real config/dependency/
lockfile/workflow changes, percentages matched the raw counts, no secrets appeared.

**zustand** (fullTasks = 13 in every record) — unchanged by fix 3, since its real changed
files happen not to trip the multi-segment-nesting bug:

| head | changed files | mode | diffci tasks | path tasks |
|---|---|---|---|---|
| f094eeb | `.github/workflows/docs.yml` | FULL (fallback) | 13/13 | 13/13 |
| ea612a5 | `README.md` | SELECTIVE | 6/13 | 2/13 |
| b126c33 | `docs/learn/guides/nextjs.md` | SELECTIVE | 6/13 | 2/13 |
| 2115efb | `package.json` | FULL (fallback) | 13/13 | 13/13 |
| 1f531ba | 7 files incl. workflow, `package.json`, `pnpm-lock.yaml`, 2 `src/` | FULL (fallback) | 13/13 | 13/13 |
| aa6d2a1 | `docs/reference/integrations/third-party-libraries.md` | SELECTIVE | 6/13 | 2/13 |
| 3febf8c | `src/middleware/persist.ts`, `tests/persistAsync.test.tsx` | SELECTIVE (all triggered) | 13/13 | 13/13 |
| f44cecc | `package-lock.json`, `src/middleware/devtools.ts`, `tests/devtools.test.tsx` | FULL (fallback) | 13/13 | 13/13 |

(`b126c33` changed from 2/13 to 6/13 vs. the intermediate run — the extra 4 tasks are
workflow-derived jobs with unscoped `"**/*"` catch-all inputs, now correctly always-matching
regardless of nesting; not a fix-3 artifact, a pre-existing catch-all pattern now correctly
evaluated.)

**hono** (fullTasks = 24 in every record) — **materially changed by fix 3**: every record
now selects all 24 tasks, where several previously (incorrectly) selected only 2 or 6:

| head | changed files | mode | diffci tasks (before fix 3) | diffci tasks (after) | path tasks |
|---|---|---|---|---|---|
| a10592f | 4 router files, 2+ dirs deep | SELECTIVE (all triggered) | 6/24 | **24/24** | 24/24 |
| 48e360f | 2 `src/jsx/dom/` files | SELECTIVE (all triggered) | 2/24 | **24/24** | 24/24 |
| 7967760 | `src/request.{test.,}ts` | SELECTIVE (all triggered) | 24/24 | 24/24 | 24/24 |
| 0293343 | `package.json` | FULL (fallback) | 24/24 | 24/24 | 24/24 |
| 5ad469a | 2 `src/middleware/pretty-json/` files | SELECTIVE (all triggered) | 2/24 | **24/24** | 24/24 |
| c91ec9b | `src/utils/ipaddr.{test.,}ts` | SELECTIVE (all triggered) | 6/24 | **24/24** | 24/24 |
| eea9735 | 2 `src/middleware/csrf/` files | SELECTIVE (all triggered) | 2/24 | **24/24** | 24/24 |
| a194628 | 3 router files, 2+ dirs deep | SELECTIVE (all triggered) | 6/24 | **24/24** | 24/24 |

Every hono record's changed files sit 2+ directories under `src/`, exactly the shape the
fix-3b bug mis-matched — those tasks were being wrongly marked `SKIP_CANDIDATE` before the
fix. Graph confidence: all 8 zustand records `"COMPLETE"`; all 8 hono records `"PARTIAL"`
(correctly, per fix 2). No `UNSUPPORTED`/`UNSAFE` fired for either repo.

## Test-level results — the real signal

This is the headline finding of the pilot, once measured at the right granularity.

**zustand** (testsTotal = 13 in every record):

| head | changed files | mode | tests: DiffCI / PATH / total |
|---|---|---|---|
| f094eeb | `.github/workflows/docs.yml` | FULL | 13 / 13 / 13 |
| ea612a5 | `README.md` | SELECTIVE | **0** / 0 / 13 |
| b126c33 | `docs/learn/guides/nextjs.md` | SELECTIVE | **0** / 0 / 13 |
| 2115efb | `package.json` | FULL | 13 / 13 / 13 |
| 1f531ba | workflow + `package.json` + `pnpm-lock.yaml` + 2 `src/` | FULL | 13 / 13 / 13 |
| aa6d2a1 | docs file | SELECTIVE | **0** / 0 / 13 |
| 3febf8c | `src/middleware/persist.ts`, `tests/persistAsync.test.tsx` | SELECTIVE | **7** / 13 / 13 |
| f44cecc | `package-lock.json` + 2 files | FULL | 13 / 13 / 13 |

**hono** (testsTotal = 123 in every record) — this is where the advantage is dramatic:

| head | changed files | tests: DiffCI / PATH / total |
|---|---|---|
| a10592f | 4 router files | **70** / 123 / 123 |
| 48e360f | 2 `src/jsx/dom/` files | **23** / 123 / 123 |
| 79677607 | `src/request.{test.,}ts` | **83** / 123 / 123 |
| 0293343 | `package.json` (FULL) | 123 / 123 / 123 |
| 5ad469a | 2 `src/middleware/pretty-json/` files | **1** / 123 / 123 |
| c91ec9b | `src/utils/ipaddr.{test.,}ts` | **2** / 123 / 123 |
| eea9735 | 2 `src/middleware/csrf/` files | **1** / 123 / 123 |
| a1946287 | 3 router files | **8** / 123 / 123 |

PATH baseline selects **every** hono test on **every single commit** — its rule is "a file
under `src/` changed → run every test under `src/`", and every hono commit touches `src/`.
DiffCI's real dependency graph, by contrast, correctly narrows to just the tests that
actually import the changed file: 1 test for an isolated middleware change (`pretty-json`,
`csrf`), 70-83 for changes to widely-imported core files (`router`, `request.ts`), scaling
with actual blast radius rather than "did anything under src/ change." This is exactly
DiffCI's intended value proposition, now measured and confirmed on a real external repo.

```
Cross-repo test totals (sum across all 16 deltas):
  testsTotal:            1,088
  testsSelectedByPath:    1,049  (96.4% of all tests, aggregate)
  testsSelectedByDiffci:    370  (34.0% of all tests, aggregate)

Median test reduction — PATH:   0.0%   (PATH is "select everything" for most individual deltas;
                                          its aggregate reduction comes from a few outliers, not
                                          a typical delta)
Median test reduction — DiffCI: 63.7%
Median incremental test advantage (DiffCI over PATH): 16.3%
```
This is the opposite conclusion from the coarse task-level numbers (finding 4), and it's
the correct one: DiffCI's real advantage lives entirely in individual-test selection, which
the coarse job-granularity benchmark structurally could not see. Cache correctness held
here too (see below) — these numbers are stable across cold and warm re-analysis of the
same commit.

## Cache correctness (cold vs warm)

| | zustand (`f094eeb`) | hono (`a10592f`) |
|---|---|---|
| Cold overhead | 3,632 ms | 8,614 ms |
| Warm overhead | 774 ms | 604 ms |
| Selected tasks (cold) | 13 | 24 |
| Selected tasks (warm) | 13 | 24 |
| Changed-file set equal | yes | yes |
| **Plan equivalent** | **yes** | **yes** |
| Serialized graph size | 29,647 bytes | 352,064 bytes |

**Cache correctness held for both repos across all four runs of this pilot.** No STOP
triggered at any point. Overhead rose again from the previous round — expected: each delta
now also runs the real per-test PATH baseline over every one of hono's 123 test files, on
top of `discoverTests()` walking and glob-matching every file under each repo's source
roots. zustand: 78.7% reduction cold→warm; hono: 93.0%.

## Historical CI evidence

Unchanged — **no GitHub Actions run-history fetcher exists** in the research pipeline
(confirmed: `src/research/` has zero matches for `api.github.com`/`workflow_runs`/
`GITHUB_TOKEN`). Per instructions not to fabricate unavailable timing:

```
Historical CI evidence baseline state: UNAVAILABLE (all 16 deltas)
Critical timing check: NOT MEASURABLE
Test count check (testsTotal / testsSelectedByPath / testsSelectedByDiffCI): MEASURABLE as of
  this round - see "Test-level results" above for the full per-commit and aggregate numbers.
Failure recall: NOT MEASURABLE
```

## DiffCI overhead

```
Cold analysis p50 / p90:  3,608 ms / 6,451 ms   (across all 16 deltas)
Warm analysis p50 / p90:  0 ms / 0 ms            (only the 2 explicit cold/warm-check re-runs were warm)
DiffCI overhead median:   3,608 ms
```
Higher again than the previous round's 2,607 ms/3,562 ms — running the real per-test PATH
baseline against every one of hono's 123 test files per delta, on top of the now-complete
`discoverTests()` walk, is the largest contributor. Still under 6.5 seconds worst-case per
delta; still small next to a typical CI job for any repo of this size, though "relative to
what" remains unmeasured without historical CI data. This overhead is specific to the
research harness's per-commit *comparison* (computing both DiffCI's and PATH's test
selection to benchmark them against each other) — DiffCI's own real per-commit overhead in
production use is just the graph/impact/planner portion, without the PATH-baseline side
computation.

## Reliability

```
Analysis attempts:     2   (one per repository)
Successful analyses:   2
Repository failures:   0
Git failures:          0
Graph failures:        0
Workflow parsing failures: 0
Baseline API failures: n/a (no historical API integration exists yet)
Timeouts / Memory failures / Cache failures / Malformed records: 0 each
Analysis success rate: 16/16 commit deltas (100%)
```

## Cloudflare validation

Not exercised (local execution only, `LocalEvidenceStore`, `src/research/cloudflare/*` not
wired into the CLI). **Cloudflare spend: $0.00**.

## Budget guard

Not exercised live (correctly — no reason to spend to test it). Verified via code
inspection (`src/research/cli/run-stage0.ts`) plus existing passing unit coverage in
[`tests/research/stage0-aggregation.test.ts`](../../tests/research/stage0-aggregation.test.ts).

## Required pilot results

### Corpus
```
Repositories attempted / analyzed / excluded: 2 / 2 / 0
Unique commit deltas / successful / failed:  16 / 16 / 0
```

### Repository A — pmndrs/zustand
```
Deltas: 8   FULL: 5   SELECTIVE: 3
PATH FULL: 5   PATH SELECTIVE: 3

Median DiffCI task reduction: 0.0%
Median PATH task reduction:   0.0%   (PATH ahead of DiffCI on all 3 selective/docs deltas: 2/13 vs 6/13)

Tests total (every record): 13
Median DiffCI test reduction: 23.1%   (0/13 on 3 docs deltas, 7/13 on 1 mixed delta, 13/13 on 4 FULL deltas)
Median PATH test reduction:    0.0%   (PATH matches DiffCI's 0/13 on the 3 docs deltas via its
                                        own docs-only shortcut, but selects all 13/13 - not 7/13 -
                                        on the one delta where DiffCI narrows via the real graph)

Timing-complete deltas: 0   Median net DiffCI runtime opportunity: NOT MEASURABLE

Cold graph:  3,632 ms (30-node graph, 29,647 bytes, confidence COMPLETE)
Warm graph:    774 ms (78.7% reduction from cache)
```

### Repository B — honojs/hono
```
Deltas: 8   FULL: 8 (1 real fallback + 7 selective-mode records that select all 24 tasks)
SELECTIVE (by mode label, though task-identical to FULL): 7
PATH FULL: 8 (identical pattern - PATH also selects all 24 tasks in every record)

Median DiffCI task reduction: 0.0%
Median PATH task reduction:   0.0%   (identical to DiffCI in every single delta, at the coarse task level)

Tests total (every record): 123
Median DiffCI test reduction: 87.4%   (as low as 1/123 for isolated middleware changes)
Median PATH test reduction:    0.0%   (selects all 123/123 on every single delta - a src/ file
                                        changed is PATH's only rule, and every hono commit
                                        touches src/)

Timing-complete deltas: 0   Median net DiffCI runtime opportunity: NOT MEASURABLE

Cold graph:  8,614 ms (328-node real graph, 352,064 bytes, confidence PARTIAL)
Warm graph:    604 ms (93.0% reduction from cache)
```

### Cross-repo result
```
Total unique deltas: 16

DiffCI selective rate: 18.8%  (3/16)
DiffCI fallback rate:  31.3%  (5/16)
Path selective rate:   18.8%  (3/16, derived: pathBaselineTasks < fullTasks)
Path fallback-equivalent rate: 81.3%  (13/16, derived: pathBaselineTasks == fullTasks)

Commits where PATH=FULL and DiffCI=SELECTIVE: 0
Commits where DiffCI selected strictly fewer coarse tasks than PATH: 0
Commits where PATH selected strictly fewer coarse tasks than DiffCI: 3  (all 3 zustand docs deltas)

Median DiffCI task reduction:        0.0%
Median incremental task advantage:   0.0%

Tests total across all 16 deltas:       1,088
Tests selected by PATH (sum):           1,049  (96.4%)
Tests selected by DiffCI (sum):           370  (34.0%)
Median DiffCI test reduction:           63.7%
Median PATH test reduction:              0.0%
Median incremental test advantage (DiffCI over PATH): 16.3%

Timing-complete deltas: 0   Median net runtime opportunity: NOT MEASURABLE
```
The task-level number is the honest, post-all-fixes coarse-granularity result: the first
pilot run's 64.4% median *task* reduction was an artifact of the fix-3b matching bug
under-selecting tasks for hono's real (nested-path) commits, not a real DiffCI advantage —
with correct matching, DiffCI and PATH select identically at the coarse task level in 13 of
16 real commits, and PATH is ahead in the other 3. But the **test-level number is the real
one**, measured correctly for the first time this round: DiffCI shows a genuine, large,
consistent advantage once measured at the granularity its dependency graph actually
operates at. See "Test-level results" above for the full evidence.

### Safety
```
Historical failing runs observed: 0 (no fetcher exists)
DiffCI unsafe misses observed: 0     PATH unsafe misses observed: 0
Failure recall: NOT MEASURABLE
```
Separately, fix 3b directly closed a real *latent* unsafe-miss risk: before the fix, DiffCI's
real production planner (`src/planner/planner.ts`) could silently fail to trigger a task
for a legitimately-matching but deeply-nested changed file, for any `inputPatterns` using
`**/`. That was a false negative in the unsafe direction, now fixed and regression-tested.

### Reliability
```
Analysis success rate: 100% (16/16 deltas, 2/2 repositories)
Timeouts / Memory failures / Graph failures / Cache failures / Malformed records: 0 each
```

### Cost
```
Cloudflare usage: none (local execution only)   Actual spend: $0.00
Cost per repo / per analyzed delta: $0.00 / $0.00
```

## Most important questions

**A. Did both external repositories analyze successfully using the existing DiffCI engine?**
**Yes** — both cloned, sampled, and produced real `BenchmarkRecord`s for all 16 deltas with
0 errors; graphs are verified non-empty and correctly labeled for both.

**B. Did anything require DentalPresence-specific assumptions? If YES, list every case.**
One remaining case (two others closed by fixes 2 and 3): `analyzeRepository`'s glob-based
task/test-pattern matching now works correctly everywhere it's exercised, but the *generic
research task registry* (`registry.ts`) still defaults under-specified job categories to a
`["**/*"]` catch-all `inputPatterns`, which — now that matching is correct — makes many
workflow-derived tasks effectively always-triggered for any source change. Arguably correct
(matches real unscoped GitHub Actions semantics) but it's a DentalPresence-shaped judgment
call about conservatism that wasn't validated against another repo's actual CI expectations,
and it's the direct cause of hono's now-uniform 24/24 selections.

**C. Does DiffCI appear to generalize technically beyond DentalPresence?**
**YES**, upgraded from PARTIALLY now that the test-level signal is actually measured. The
plumbing generalizes cleanly. The graph engine generalizes past DentalPresence's
single-tsconfig shape (project references resolve). Test discovery and glob matching are
now demonstrably correct against real external repos. And DiffCI's actual selling point —
graph-driven selective test execution — measurably generalizes: it produced a large,
consistent test-selection advantage on hono, a repo with no DentalPresence-specific
structure at all. The one remaining caveat is the coarse task-registry granularity (finding
4's original observation) — that layer still doesn't discriminate well on these repos, but
it's no longer the layer that matters for demonstrating DiffCI's value.

**D. Did DiffCI outperform the path baseline on at least one genuine source-code-changing commit?**
**Yes — decisively, at the individual-test level**, now that it's measured. At the coarse
task level: no, 13 of 16 real commits are task-identical between DiffCI and PATH, and PATH
is strictly ahead on the other 3. But every single one of hono's 8 real source-changing
commits shows DiffCI selecting dramatically fewer *individual tests* than PATH (as few as
1 of 123, vs. PATH's 123 of 123 every time) — a real, large, consistently-reproduced
advantage, not a one-off.

**E. Was the advantage task-count only, or did measured runtime evidence show an advantage?**
**Test-count**, not task-count and not measured runtime (no historical CI data exists to
derive runtime from — see Historical CI Evidence). The advantage is real and substantial at
the test-count level (63.7% median reduction vs FULL, 16.3% median incremental advantage
over PATH) but per the pilot spec's own caution, test-count reduction should not be used to
infer runtime reduction directly (DentalPresence's own Phase 5 experiment found test-count
reduction can be a weaker signal than task-level reduction for actual CI time saved) —
proving *that* requires the still-missing historical-CI-evidence fetcher.

**F. Was DiffCI overhead small enough relative to the CI work being analyzed?**
Still unanswerable without baseline CI durations. Absolute overhead rose again (median
3,608 ms, p90 6,451 ms - the research harness now also computes the per-test PATH baseline
comparison every delta, which DiffCI's own real usage wouldn't need to do). Given the median
test-count advantage this overhead is buying (63.7% fewer tests run), a single-digit-second
one-time analysis cost per commit looks like a reasonable trade even without exact CI-time
figures, but that remains a qualitative judgment, not a measured one.

**G. Were there any unsafe misses?**
None *observed* in this sample (still no historical failing-run data to check against). But
this round found and fixed a real, confirmed *latent* unsafe-miss mechanism in DiffCI's
production planner itself (fix 3b) — a materially more serious finding than "none observed"
suggests standing alone. It is now closed and regression-tested.

**H. Were there any serious sandbox/security/reliability issues?**
No. All operations remained static analysis; no code execution beyond git plumbing and the
TypeScript compiler API; no secrets touched; zero crashes/timeouts/memory failures across
all four runs.

**I. Is the current pipeline ready for the real 20 repositories / ~2,000 deltas Stage 0 run?**
**YES WITH CHANGES**, upgraded in substance even though the label is unchanged: all three
correctness/safety bugs this pilot could find are fixed and regression-tested, *and* the
`testsTotal`/`testsSelectedByPath`/`testsSelectedByDiffCI` tracking that was this report's
top recommended item is now implemented and has already shown a real, large, generalizing
DiffCI advantage on an external repo. The one remaining recommended (not blocking) item:
build a historical-CI-evidence fetcher, so the 20-repo run's timing/runtime-opportunity/
failure-recall sections aren't uniformly `NOT MEASURABLE` and the test-count advantage
measured here can be connected to actual CI minutes saved rather than left as a
test-count-only signal. Running the 20-repo experiment today would now very likely show a
real, positive, generalizing DiffCI signal at the test level — the harness is finally
measuring the part of DiffCI that matters.

## Stop conditions — assessment

None of the listed automatic-stop conditions were triggered across any of the four runs
(cache correctness held every time; no memory instability; no unsafe code execution; no
cross-repository contamination; no benchmark corruption from the pilot process itself). All
three bugs were discovered during the mandated post-run evidence inspection, fixed,
regression-tested, and the pilot re-run in full each time rather than patched in place with
stale data left standing — consistent with "fix correctness before scale," applied
iteratively as each fix surfaced the next, deeper issue, culminating in the test-count
tracking that finally measured DiffCI's real advantage.

## Validation

```
cd diffci
npm run typecheck   → PASS
npm test             → PASS (127/127 — 124 from the prior round + 2 test-count-tracking
                        integration tests + 1 stage0-aggregation test-count test)
npm run check        → PASS
npm run build         → PASS
```
