# Stage 1A — Phase 6: the `pmndrs/valtio` impossible-count anomaly, root-caused and fixed

## The exact offending delta

- Repository: `pmndrs/valtio`
- baseSha: `e5f5604d687e5362d9e3ead041bfa48ce2ad7fb3`
- headSha: `a8e8dd06ff9fece791276e1f0053bd51f4b37400`
- logicalDeltaKey: `pmndrs/valtio:e5f5604d687e5362d9e3ead041bfa48ce2ad7fb3:a8e8dd06ff9fece791276e1f0053bd51f4b37400:0.6.0-phase6:diffci-research/stage0-2`
- Changed files (per the recorded `gitDelta`): `src/vanilla.ts` (modified), `tests/performance.test.tsx`
  (**added**)
- Stage 0's recorded values: `testsTotal: 34`, `testsSelectedByPath: 34`, `testsSelectedByDiffci: 35`
  (the impossible count), `graphConfidence: COMPLETE`, `fallback: false`, `coldCache: true`.

## Reproduction: succeeded, 100% deterministic

Using the new forensic tool (`scripts/cloudflare-forensic-graph.ts`, extended this phase to dump the
full `selectedTests`/`testFilePaths` arrays whenever the count already looks impossible - not just the
summary numbers Stage 0 persisted), the exact anomaly was reproduced on the first live re-run against
this exact `{baseSha, headSha}` pair: `testsTotal: 34`, `testsSelectedByDiffci: 35`. Diffing the two
arrays directly gives the precise mechanism: **`selectedTests` has zero exact duplicates** (ruling out
the double-counted-path-key hypothesis from the original Stage 0 investigation) - instead, exactly one
entry, `tests/performance.test.tsx`, is present in `selectedTests` but **absent from `testFilePaths`
entirely**. This is an undercount of the total, not an inflated selection.

## Root cause: no per-delta checkout to `headSha` exists anywhere in the pipeline

A repository-wide search (`grep -rl checkout src/ scripts/`) found **zero** checkout logic anywhere in
the research pipeline. Tracing the actual mechanics:

- `analyzeGitDelta()` (`src/git/git-diff.ts`) computes the changed-file list between `baseSha` and
  `headSha` via pure git plumbing (diff/log against git's object database) - this is **correct
  regardless of what the working tree is currently checked out to**, and does not require or perform a
  checkout.
- `buildDependencyGraph()` (`src/repo/graph.ts`) uses `ts.sys` directly (confirmed via
  `ts.createProgram`, `ts.sys.readFile`, `ts.sys.fileExists` at multiple call sites) - i.e. it reads
  **real files from the actual working-tree filesystem**, whatever commit that happens to be checked out
  to.
- `runRepoBenchmark()` (`src/research/benchmark/runner.ts`) clones the repository **once** per
  container/repo session (`cloneOrUpdateRepo()`, which resets hard to the default branch's tip) and then
  loops over every sampled delta calling `analyzeCommit()` against that **same, never-re-checked-out**
  `repoPath` for every single delta in the batch.

**The result: git-diff computation is correctly delta-specific (headSha-aware), but graph construction
and test-file discovery are NOT - they always reflect the repository's state at container-clone time
(approximately "now"), not the historical state at the delta's actual `headSha`.**

**Direct, external confirmation this is exactly what happened here**: `tests/performance.test.tsx` does
not exist anywhere in `pmndrs/valtio`'s current repository (confirmed via GitHub code search - zero
results). It exists today as `tests/perf/performance.test.ts` (confirmed via directory listing) - the
file was renamed/relocated (note the extension also changed, `.tsx` → `.ts`) at some point after the
historical commit that added it. The container's clone reflects this current, post-rename state, so
`discoverTests()`'s glob-based scan correctly finds 34 real test files as they exist **today** - not
including the file under its historical name - while `analyzeGitDelta`'s git-plumbing diff correctly and
accurately reports the historical fact that `tests/performance.test.tsx` was added at that specific
commit, regardless of what happened to it afterward.

## This is broader than one anomalous delta

This is not a narrow, delta-specific quirk - it is a structural property of how the benchmark harness
computes evidence for **every** sampled delta: graph/profile/test-discovery data always reflects the
clone's current state, not the delta's actual historical state. For the overwhelming majority of Stage
0's 2,000 deltas this produces no *observable* symptom, because file existence, tsconfig content, and
package.json content tend to be stable within Stage 0's sampling window (`recentCommitWindow: 200`, all
sampled deltas are historically recent relative to the tip) - most files present at a recent historical
commit are still present, under the same name, at the current tip. But it is a real, if usually
invisible, source of potential inaccuracy for any repository/window combination where files get
renamed, moved, or restructured within the sampled range, and this experiment surfaced exactly one
concrete case of it doing so observably (a directory reorganization of valtio's performance tests).

**This was not confirmed as a purely benchmark-harness-scoped issue with 100% certainty either** - it
is possible (though not observed in this investigation) that a similar historical/current-state mismatch
could, in principle, affect other Stage 0 metrics beyond test counts (tsconfig-driven graph confidence,
fallback-reason detection based on `package.json`/lockfile content) if a repository's config files were
also restructured within the sampling window. This is flagged as a real, open question for Stage 1B,
not assumed away.

## Fix implemented this phase

Per the task's explicit instruction not to clamp impossible values (clamping would hide the bug), a
**non-clamping invariant guard** was added:

- `BenchmarkRecord` gained an optional `testCountInvariantViolation: { reason: string }` field
  (`src/research/types.ts`), documented with the exact root cause above so a future reader doesn't have
  to rediscover it.
- `runner.ts`'s `analyzeCommit()` now checks `0 <= testsSelectedByDiffci <= testsTotal` and
  `0 <= testsSelectedByPath <= testsTotal` immediately after computing them, setting the flag (with a
  precise reason string) when either is violated - the underlying numbers are left exactly as computed,
  never corrected or hidden.
- `aggregator.ts`'s `buildStage0Report()` now automatically excludes any flagged record from every
  test-count-derived metric (`testsTotalAcrossDeltas`, `testReductionsByPath/ByDiffci`,
  `incrementalTest`, etc.) - the same precedent already established for `sindresorhus/ky`'s known-bad
  test counts - and reports how many were excluded via a new `testCountInvalidDeltas` summary field, so
  this is never silently absorbed into an aggregate again. Task-level metrics (which don't depend on
  test counts) are unaffected and continue to include the record.
- A regression test (`tests/research/stage0-aggregation.test.ts`) reproduces the exact real-world shape
  of this anomaly (`testsTotal: 34, testsSelectedByDiffci: 35`) and asserts that a report built with the
  flagged record present produces byte-identical test-count metrics to one built without it at all -
  proving exclusion, not silent clamping-into-a-different-wrong-number.
- Full suite: 225/225 pass (was 224 before this test was added), `tsc --noEmit` clean.

## What was NOT done, deliberately

**A per-delta `git checkout <headSha>` was not implemented.** This would be the complete structural fix
(making graph construction and test discovery genuinely historically-accurate for every delta, not just
guarding against the symptom), but it is a change to the core benchmark pipeline's checkout/analysis
sequencing used by every future research run, not a narrow bug fix - implementing it now would exceed
Stage 1A's explicit scope ("Do NOT implement broad graph-coverage improvements... without explicit
approval"). It is recorded here as the concrete, well-understood Stage 1B follow-up: add a checkout (or
an equivalent git-worktree-per-delta / `git show`-based content-reading approach that avoids mutating a
shared working tree across concurrent deltas) immediately before `buildDependencyGraph()`/
`analyzeRepository()` run for each delta, reverting or advancing the tree as needed between deltas in
the same batch. Estimated complexity: moderate - correctness is straightforward (a `git checkout` per
delta) but performance is a real concern (checkout cost scales with delta count per repository, and
Stage 0 processed up to 100 deltas per repository per run); a `git worktree` per concurrent batch slot,
or reading file content via `git show <sha>:<path>` directly into TypeScript's compiler host without
touching the working tree at all, are both worth evaluating before committing to the naive approach.
