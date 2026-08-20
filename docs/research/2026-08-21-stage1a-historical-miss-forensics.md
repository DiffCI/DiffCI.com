# Stage 1A — Phase 4: forensic analysis of all historical "unsafe miss" deltas

**Methodology note (unit correction).** The final Stage 0 report's "10 DiffCI unsafe misses" / "82 PATH
unsafe misses" are `aggregator.ts`'s sums of `historicalUnsafeMissTargets.length` /
`historicalPathUnsafeMissTargets.length` **across all records** - i.e. total missed CI-*job* target
instances, not distinct deltas. A direct R2 scan (`/v1/forensic/scan-unsafe-misses`, added this phase,
read-only over existing Stage 0 evidence - no Stage 0 data touched) finds these 10 target instances are
spread across **8 distinct deltas** (some deltas have 2 missed targets), and finds 49 distinct deltas
carrying PATH's 82 missed-target instances. Both counts were independently reconciled - not a
discrepancy, just two different units, now stated precisely for the rest of this report.

**Every one of the 8 distinct deltas was investigated individually** against the real GitHub Actions
history (`gh api .../check-runs`, `.../annotations`, and cross-commit flakiness checks), not aggregated
away, per the task's explicit instruction.

## Critical, unexpected finding: "unsafe miss targets" are CI *job* identifiers, not tests

Every `historicalUnsafeMissTargets` entry is shaped `<workflow-file>::<job-id>` (e.g.
`.github/workflows/ci::tests`, `.github/workflows/release::release`) - a whole GitHub Actions **job**,
not an individual failing test. This matters enormously for interpretation: a "miss" here means "a CI
job that failed historically wasn't in DiffCI's selected task set," not "a specific test DiffCI should
have run was skipped." Several real CI jobs bundle multiple concerns (lint + test in one job, in at
least one repository in this corpus) or aren't test jobs at all (a `Release` job appears in this list).

## The 8 deltas, individually

### 1. `unjs/h3` — docs-only change
- baseSha `ba429473b8`, headSha `50266f3d99`
- Changed files: 9 files, all under `docs/` (`.config/docs.yaml`, several `.md` files) + `docs/package.json` + `docs/pnpm-lock.yaml` + `docs/pnpm-workspace.yaml`
- DiffCI: `testsSelectedByDiffci: 1` of `testsTotal: 70`. PATH: `testsSelectedByPath: 0`.
- Miss target: `.github/workflows/ci::tests`
- **Real GitHub Actions job `tests` failing step (confirmed via job-detail API): `Run pnpm lint`.**
  This job bundles lint and test execution together; the failure was a **lint** failure, not a test
  failure. DiffCI's test-selection decision had zero causal relationship to this failure.
- **Classification: `BENCHMARK_MAPPING_ERROR`.** The historical-evidence collector's job-name-based
  matching (`matchFailedTaskIds()`) cannot see past the job boundary into which step failed - this repo's
  CI structure makes "the tests job failed" ambiguous between lint and test failures.
- **Could DiffCI have detected this was unsafe beforehand?** No signal exists for this - it isn't a
  DiffCI test-selection problem at all.

### 2. `unjs/h3` — `src/event.ts` change (a real source-code delta)
- baseSha `74d53c5bc8`, headSha `3f8b5bc621`
- Changed files: `docs/1.guide/900.api/2.h3event.md`, `src/event.ts`
- DiffCI: `testsSelectedByDiffci: 59` of `testsTotal: 70` (selective, not fallback). PATH: 70 (full).
- Miss target: `.github/workflows/ci::tests`
- **Same job, same failing step confirmed: `Run pnpm lint`.** This is the most important of the 8 to
  get right, because it's the one case with a genuine source-code change and a genuinely selective
  (non-fallback) DiffCI plan - exactly the shape of delta where a real missed dependency edge would show
  up. It doesn't: the job failed on lint, a step that runs regardless of which tests were selected.
- **Classification: `BENCHMARK_MAPPING_ERROR`** (same mechanism as #1).
- **Could DiffCI have detected this beforehand?** No - again, not a test-selection problem. This
  specific delta is the strongest evidence in this dataset that DiffCI's selective test decisions were
  NOT the cause of any of the 8 "misses" - the one case that looks most like a real selectivity failure
  turns out to be a lint failure under the same job name.

### 3. `unjs/unstorage` — `.oxfmtrc.json` only (formatter config)
- baseSha `46aab4d8bc`, headSha `c28ebab4ae`
- DiffCI: `testsSelectedByDiffci: 0` of `testsTotal: 40`. PATH: 40 (full).
- Miss target: `.github/workflows/ci::tests`
- **Real failing test, identified via check-run annotations**:
  `test/drivers/github.test.ts > drivers: github > can read an item metadata`, error:
  `FetchError: [GET] "https://api.github.com/repos/unjs/unstorage/git/trees/main?recursive=1": 403 rate
  limit exceeded`.
- **Classification: `ENVIRONMENT_DEPENDENCY`.** This test makes a live call to the real GitHub REST API
  and hit a rate limit during that CI run - entirely unrelated to the `.oxfmtrc.json` change, and not
  something any static dependency analysis (however complete) could predict, because the failure has no
  causal link to source code at all.
- **Could DiffCI have detected this beforehand?** No - the failure mode is inherent to a test that
  depends on live external network state at execution time, not on any property of the diff.

### 4. `unjs/unstorage` — `src/_utils.ts` change (a real source-code delta)
- baseSha `fdaa0e1a87`, headSha `bc7e5a959e`
- DiffCI: `testsSelectedByDiffci: 36` of `testsTotal: 40` (selective). PATH: 40 (full).
- Miss target: `.github/workflows/ci::tests`
- Job step-level and annotation detail were **unavailable** - GitHub's log/step retention had already
  expired for this run by the time of this investigation (a genuine, stated evidentiary limit, not
  something suppressed). The annotation returned only a generic `"Process completed with exit code 1"`
  at the workflow level.
- **Classification: `UNKNOWN`.** Per the task's explicit instruction not to force a classification
  without evidence, this is left unresolved rather than assumed benign. Circumstantial context: this is
  the same repository and same `tests` job as case #3 (a confirmed environment-dependent GitHub-API test)
  and case #5 below - a real possibility is the same rate-limited `github.test.ts` test recurring, since
  Stage 0 sampled several `unjs/unstorage` commits in a short time window and a shared rate limit could
  plausibly affect more than one of them - but this is a hypothesis, not a confirmed finding.

### 5. `unjs/unstorage` — `vite.config.mjs` only
- baseSha `05e2857e74`, headSha `bbc9990281`
- DiffCI: `testsSelectedByDiffci: 0` of `testsTotal: 40`. PATH: 40 (full).
- Miss target: `.github/workflows/ci::tests`
- Same evidentiary limit as #4 - logs/steps expired, only a generic exit-code annotation available.
- **Classification: `UNKNOWN`**, same reasoning and same circumstantial context as #4.

### 6. `pmndrs/zustand` — `README.md` only
- baseSha `da381c39cd`, headSha `4966a15d93` (commit message: "fix(readme): comparison documentation
  link")
- DiffCI: `testsSelectedByDiffci: 0` of `testsTotal: 13`. PATH: 0 (also correctly selected nothing).
- Miss targets: `.github/workflows/docs::build`, `build`
- Real check-run data: every one of ~25 `test_*`/`test_old_typescript`/`test_multiple_versions`/
  `test_multiple_builds` jobs **succeeded**. Only `build / build-job` failed.
- Step-level detail was unavailable (log retention expired). Cross-commit check across the 15 most
  recent `zustand` commits: `build / build-job` succeeded on 13, was cancelled on 1 (unrelated), and
  failed on exactly this one - a rare, isolated failure, not a chronic flake.
- **Classification: `UNKNOWN`**, though the structural implausibility is strong: a documentation-link
  fix in `README.md` cannot plausibly break a code build through any real dependency mechanism this
  codebase's graph could model, and every real test job passed. The most likely explanation given the
  pattern found in cases #3/#7/#8 (external/environmental failures) is the same category, but this is
  stated as a hypothesis given the unavailable evidence, not a confirmed classification.

### 7. `TanStack/query` — `CONTRIBUTING.md` only
- baseSha `3bc8edfa01`, headSha `dce04b5c5a`
- DiffCI: `testsSelectedByDiffci: 0` of `testsTotal: 184`. PATH: 0 (also correctly selected nothing).
- Miss target: `.github/workflows/release::release`
- **Real failure, confirmed via annotations**: `HttpError: No server is currently available to service
  your request. Sorry about that. Please try resubmitting your request and contact us if the problem
  persists.` - a GitHub infrastructure-level outage message, not an application error.
- Cross-commit check across the 10 most recent commits: this `Release` job succeeded 10/10 times
  elsewhere - confirmed rare, isolated infrastructure failure.
- **Classification: `ENVIRONMENT_DEPENDENCY`** (GitHub platform outage). Also worth noting explicitly:
  **this "miss" isn't even about test selection** - `Release` is a publish/release job, not a test job,
  and its failure has no relationship to which tests DiffCI selects. This is a second, distinct flavor of
  `BENCHMARK_MAPPING_ERROR`: the task registry this benchmark's job-matching draws from apparently
  includes non-test jobs like `release`, which should arguably never be counted as a "DiffCI test-
  selection safety miss" at all.
- **Could DiffCI have detected this beforehand?** No - not a test-selection problem, and not predictable
  from the diff.

### 8. `pmndrs/valtio` — `README.md` + `docs/api/advanced/ref.mdx` only
- baseSha `a6ad505857`, headSha `4689e794de`
- DiffCI: `testsSelectedByDiffci: 0` of `testsTotal: 34`. PATH: 0 (also correctly selected nothing).
- Miss targets: `.github/workflows/test-multiple-versions::test_multiple_versions`,
  `.github/workflows/test::test`
- **Real failing test, confirmed via annotations**:
  `tests/perf/performance.test.ts > performance with nested objects > snapshot with subscription`,
  error: `AssertionError: expected 0.11916369408326592 to be less than 0.1`.
- **This is a timing/performance-threshold assertion, not a correctness test** - a classic source of CI
  flakiness (shared-runner CPU contention, not the code). Cross-commit check across the 9 most recent
  commits: this exact job succeeded 9/9 times elsewhere - confirmed rare, isolated timing flake.
- **Classification: `ENVIRONMENT_DEPENDENCY`** (timing-sensitive flaky assertion, CI-runner-load
  dependent). Not caused by, or predictable from, a documentation-only diff.

## Summary classification

| Delta | Classification | Confirmed with certainty? |
|---|---|---|
| h3 docs-only | `BENCHMARK_MAPPING_ERROR` (lint bundled into "tests" job) | Yes - job step identified |
| h3 event.ts | `BENCHMARK_MAPPING_ERROR` (same mechanism) | Yes - job step identified |
| unstorage `.oxfmtrc.json` | `ENVIRONMENT_DEPENDENCY` (GitHub API rate limit) | Yes - exact test + error identified |
| unstorage `_utils.ts` | `UNKNOWN` | No - logs expired |
| unstorage `vite.config.mjs` | `UNKNOWN` | No - logs expired |
| zustand `README.md` | `UNKNOWN` (structurally implausible as a real miss) | No - logs expired |
| TanStack/query `CONTRIBUTING.md` | `ENVIRONMENT_DEPENDENCY` + `BENCHMARK_MAPPING_ERROR` (non-test job) | Yes - exact error identified |
| valtio `README.md`+docs | `ENVIRONMENT_DEPENDENCY` (flaky timing assertion) | Yes - exact test + error identified |

**Zero of the 8 distinct miss deltas are confirmed genuine DiffCI test-selection safety failures** (a
real, code-caused test failure that a more complete dependency graph should have caught but didn't).
5 of 8 are confirmed to have causes entirely unrelated to code content (lint-job bundling, live network
rate limiting, GitHub infrastructure outage, timing flakiness). 3 of 8 could not be confirmed either way
due to expired GitHub log retention - reported as `UNKNOWN`, not assumed safe.

**This is a genuinely important, if perhaps counter-intuitive, finding, reported per the task's research-
integrity instruction regardless of which direction it points.** It does not mean DiffCI has zero real
safety gaps in general - it means this specific measured set of "10 misses" substantially overstates
genuine test-selection failures, because the underlying measurement methodology (job-level GitHub
Actions matching) cannot distinguish "this job failed because of the code change" from "this job failed
for an unrelated reason that happened to coincide with this commit," and in at least one repository
bundles lint into the same job name the benchmark treats as "tests." **A materially more precise safety
measurement - job-granularity aware, flakiness-filtered, non-test-job-excluded - is a genuine, concrete
Stage 1B methodology improvement, not a cosmetic one.**

## What conservative rule would have prevented these misses, and at what cost?

Given zero confirmed genuine test-selection misses, this question inverts: **no additional conservative
rule is evidenced as necessary by this dataset.** The Pareto-frontier analysis the task requests
(misses prevented vs. additional fallback cost) has a trivial answer here for the ONLY well-confirmed
data: preventing the 5 confirmed-unrelated misses would require either (a) treating every historical
"job failure" as unconditionally unsafe regardless of cause (destroys the product, explicitly ruled out
by the task), or (b) fixing the measurement methodology itself (recommended - see Stage 1B proposal).
For the 3 `UNKNOWN` deltas, no rule can be responsibly proposed without knowing the actual cause.
