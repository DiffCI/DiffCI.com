# Stage 0 medium batch — final report (2026-08-21)

10 repositories, 500 unique successfully analyzed commit deltas, run through the real deployed
Cloudflare pipeline. All four gates (A: resumability, B: ~50, C: ~200, D: ~500) passed. Two real
correctness bugs were found and fixed mid-run via the required STOP-fix-invalidate-rerun process, not
smoothed over - both are reported in full below alongside their measured effect on the numbers.

Raw aggregate data: `docs/research/2026-08-21-stage0-medium-batch-aggregate.json`. Corpus selection
criteria (written before any run): `docs/research/2026-08-21-stage0-medium-batch-corpus-selection.md`.
Pre-run gap analysis: `docs/research/2026-08-21-stage0-medium-batch-gap-analysis.md`.

## What was built this session (summary - see the gap-analysis doc for detail)

- **Cross-container resumability** (`src/research/cloudflare/resumable-batch.ts`, new `/v1/run-repo`
  endpoint): a fresh container checks D1 before analyzing each delta, verifies R2 evidence a checkpoint
  claims exists actually does, and persists incrementally per-batch so a mid-run failure loses at most
  one batch. 10 unit tests against fake D1/R2, then verified live on real Cloudflare (Gate A).
- **Opportunity classifier** (`src/research/benchmark/opportunity-analysis.ts`): every delta classified
  into MANDATORY_FALLBACK / BASELINE_ALREADY_OPTIMAL / DISCRIMINATIVE_OPPORTUNITY using rules that
  reference only `fallback` and PATH's own selection - never DiffCI's - so the classification cannot be
  circular with the win/tie/loss comparison computed afterward.
- **10-repository TS/JS corpus**, selection criteria documented before any run.

## Bugs found and fixed during execution (STOP-fix-invalidate-rerun, not hidden)

### Bug 1: FOREIGN KEY constraint violation (Gate A)

`/v1/run-repo`'s first real call failed outright - `completed_deltas`/`repository_runs` reference
`experiment_runs(experiment_id)`, but nothing ever inserted the parent row. Fixed
(`ensureExperimentRun()`, idempotent). No evidence was affected (the very first write failed, so nothing
incorrect was ever persisted).

### Bug 2: `discoverSourceRoots()` silently missed monorepo source (Gate C)

**Severe, real product bug**, not research-harness-only. `colinhacks/zod`, `sindresorhus/execa`,
`trpc/trpc` all have a top-level `scripts/` directory (build tooling) but no `src/app/lib/tests/test/api`
at the root - their real source and tests live under `packages/<name>/src/`. The "scan every top-level
directory" fallback only triggered when *zero* conventional roots were found; `scripts/` alone being
present suppressed it, so `packages/` was never scanned. **`testsTotal` came back 0 for every single
delta across these three repositories** (90 of the medium batch's first 200 deltas) - not a near-miss,
a complete miss - while `testsSelectedByDiffci` (computed independently via the TypeScript compiler's
own tsconfig `include` globs) stayed correct, producing 18 "selected > total" impossible records once
aggregated. Caught by the medium batch's own explicit STOP-condition check, not by chance.

Root-caused against a real cloned `colinhacks/zod`: before the fix, 1 source root (`scripts` only), 0
test files found. After: 11 source roots (including `packages`), 192 real test files found, matching
zod's actual test file names. Verified the graph/impact/planner pipeline was never wrong: a real zod
commit's `testsSelectedByDiffci: 123` was already correct both before and after the fix (123 ≤ 192,
plausible) - only the total/PATH side was broken.

**Fixed, regression-tested (2 new tests, one proving the common `src/`-at-root case is unaffected), and
the 90 affected deltas were invalidated (D1 rows deleted) and fully re-analyzed** before Gate C's
numbers were trusted. See commit `44a90e6`.

### Discovered but NOT fixed: `ky`'s AVA-style test files aren't detected

`sindresorhus/ky` has a real top-level `test/` directory (correctly recognized as a root), but its test
files (`base-url.ts`, `bytes.ts`, ...) don't carry a `.test.`/`.spec.` suffix - ky uses AVA's convention
where any file in the designated test directory is implicitly a test. `isTestFile()`'s naming-based
detection misses these entirely, so `testsTotal` is 0 for all 35 of ky's deltas.

This is deliberately **not fixed** in this pass. Unlike Bug 2 (an unambiguous "the tool returns
completely wrong data for a common, legitimate structure" defect), this is a narrower, different-in-kind
capability gap - support for a specific test-runner convention - and fixing it mid-batch, specifically
because it affects one of the ten chosen corpus repositories, would risk exactly the "expand capability
to inflate the benchmark population" pattern the spec explicitly prohibits for tsconfig-less JS. Reported
honestly below as a generalization limitation; `ky`'s test-selection metrics are excluded from
opportunity/aggregate-reduction analysis for this batch (it still counts as one of the ten analyzed
repositories - it *was* really graph-analyzed, with real fallback detection, just not real test counts).

### Real, honest finding (not a bug): `trpc/trpc`'s graph confidence is UNSAFE across the board

All 65 of `trpc/trpc`'s deltas show `graphConfidence: UNSAFE` - including a plain `README.md`-only
change with zero code impact, meaning the graph build itself is unreliable for this repository's
structure (likely `pnpm` workspace protocol / complex module resolution), not any specific delta.
DiffCI correctly, conservatively falls back to FULL every time - this is the safety mechanism working
exactly as designed, not a defect. The consequence: `trpc` shows a **negative** aggregate result
(`aggregateReductionVsPath: -12.1%`) - DiffCI selects *more* than PATH here, because PATH's simpler
rules don't happen to trigger fallback on every one of trpc's sampled commits while DiffCI's
confidence-based safety net does. This is a genuine "where does DiffCI lose to PATH" finding, reported
plainly, not excluded or explained away.

## Corpus

| | |
|---|---|
| Repositories attempted (this batch's new candidates) | 6 (4 primary + 2 backup) |
| Repositories excluded | 2 - `vitest-dev/vitest`, `remix-run/react-router` (both: no root `tsconfig.json`, monorepo per-package configs only - anticipated in the pre-run corpus doc as a real possible outcome) |
| Final analyzed corpus | 10 - `axios/axios`, `colinhacks/zod`, `pmndrs/jotai`, `pmndrs/zustand`, `sindresorhus/execa`, `sindresorhus/ky`, `trpc/trpc`, `unjs/defu`, `unjs/h3`, `unjs/ofetch` |
| Deltas attempted | 500 |
| Unique successful deltas | 500 (0 duplicates, 0 impossible values, verified by direct query and independent re-aggregation) |
| Resumed/skipped across all repos' final state | Every delta beyond each repo's first-ever analysis in this session resumed correctly; see per-call `resumedDeltas`/`newDeltasAnalyzed` telemetry in the raw run logs |

## Overall selection (unconditional population - reported exactly as observed, not smoothed)

| Metric | Value |
|---|---|
| Total tests (sum across all 500 deltas) | 37,740 |
| PATH selected | 32,128 |
| DiffCI selected | 24,240 |
| **Aggregate DiffCI reduction vs FULL** | **35.8%** |
| Aggregate PATH reduction vs FULL | 14.9% |
| **Aggregate DiffCI reduction relative to PATH** | **24.6%** |
| Median per-delta DiffCI reduction | 0.0% |
| Median per-delta PATH reduction | 0.0% |
| **Median unconditional incremental advantage over PATH** | **0.0%** |

The median is 0% at 500 deltas, same as at 11 and at 200. This is **not** an artifact of small sample
size - it's a structural property of the delta population itself (mandatory-fallback and
baseline-already-optimal deltas are the *majority*, 72% of all 500 - see below), and it persists exactly
as predicted. Reported as observed, without qualification.

## Opportunity analysis (this is what actually explains the 0% median)

| Category | Count | % of 500 |
|---|---|---|
| MANDATORY_FALLBACK | 267 | 53.4% |
| BASELINE_ALREADY_OPTIMAL | 93 | 18.6% |
| **DISCRIMINATIVE_OPPORTUNITY** | **140** | **28.0%** |

**Opportunity frequency: 28.0%** - a little over 1 in 4 real, deterministically-sampled commits gives
DiffCI's dependency graph any chance to differ from PATH at all. The rest are structural ties by
construction (both correctly select everything, or PATH already correctly selects nothing).

**Within the 140 discriminative opportunities:**

| | |
|---|---|
| DiffCI wins | 131 (93.6%) |
| Ties | 9 (6.4%) |
| PATH wins | 0 (0%) |
| **Win rate** | **93.6%** |
| Median conditional advantage (DiffCI reduction vs PATH) | **35.9%** |
| Mean conditional advantage | 53.5% |
| p25 / p75 / p90 | 34.3% / 100% / 100% |
| Aggregate PATH-selected (within opportunities) | 16,251 |
| Aggregate DiffCI-selected (within opportunities) | 7,069 |

**When dependency analysis has a real opportunity to improve on PATH, it wins 93.6% of the time, ties
6.4%, and never loses in this dataset - by a median 35.9% additional reduction beyond what PATH already
achieves.** This directly confirms the hypothesis the small/larger-batch reports proposed and explicitly
asked this batch to test, not assume: the 0% unconditional median is a real, correctly-predicted
consequence of tie-heavy delta composition, not evidence DiffCI doesn't work.

## Repository breakdown

| Repository | Deltas | Fallback% | Opportunity% | Win/Tie/Loss | Median cond. adv. | Agg. reduction vs PATH | Graph confidence |
|---|---|---|---|---|---|---|---|
| axios/axios | 65 | 32.3% | 46.2% | 30/0/0 | 100% | 58.4% | 100% COMPLETE |
| colinhacks/zod | 65 | 9.2% | 78.5% | 51/0/0 | 35.9% | 39.5% | 100% COMPLETE |
| pmndrs/jotai | 35 | 51.4% | 28.6% | 10/0/0 | 6.1% | 13.9% | 100% COMPLETE |
| pmndrs/zustand | 35 | 34.3% | 11.4% | 4/0/0 | 46.2% | 14.9% | 100% COMPLETE |
| sindresorhus/execa | 65 | 100% | 0% | 0/0/0 | n/a | n/a | 100% UNSAFE |
| sindresorhus/ky | 35 | 11.4% | 0%* | 0/0/0 | n/a* | n/a* | 100% COMPLETE |
| trpc/trpc | 65 | 100% | 0% | 0/0/0 | n/a | **-12.1%** | 100% UNSAFE |
| unjs/defu | 65 | 76.9% | 15.4% | 7/3/0 | 50.0% | 8.3% | 100% COMPLETE |
| unjs/h3 | 35 | 5.7% | 80.0% | 28/0/0 | 15.7% | 34.0% | 100% COMPLETE |
| unjs/ofetch | 35 | 68.6% | 20.0% | 1/6/0 | 0% | 3.2% | 100% COMPLETE |

\* `ky`'s test-count metrics are unreliable for this batch - see the AVA-convention finding above; its
0% opportunity frequency reflects `testsTotal: 0`, not a real absence of opportunities.

**The result is not dominated by one or two repositories.** Six of ten repos (axios, zod, jotai, zustand,
h3, defu) show real, positive discriminative-opportunity signal with win rates of 100% (all but defu's
70%) and meaningfully varied conditional advantages (6.1% to 100% median). `execa`'s 100% fallback is a
correctness-appropriate outcome (confirmed via manual spot check - real config/dependency-triggering
changes in its sampled window), `trpc`'s is a graph-confidence limitation, and `ky`'s data is unreliable.

**What correlates with large DiffCI wins** (correlational observation only, not causal - 10 repositories
is far too small a sample to establish causation): the two highest-opportunity-frequency repositories
(`unjs/h3` at 80.0% and `colinhacks/zod` at 78.5%) both have deep, narrow module structures where most
individual source files have few, specific dependents - exactly the shape dependency-graph analysis is
built to exploit. The lowest (`pmndrs/zustand` at 11.4%, `sindresorhus/execa` at 0%) tend toward either
small, broadly-interconnected codebases (zustand) or structures DiffCI can't build a trustworthy graph
for at all (execa, tied to its `UNSAFE` confidence - not confirmed as fundamentally single-clustered,
just unmeasurable here).

## Safety

- **Unsafe misses: 0.** But per the spec's own caution, this does NOT prove safety - it means no unsafe
  miss was *observed* in this sample.
- **Historical failures evaluable: 0 / Historical failures preserved: 0 / 0.** Failure recall is
  `NOT MEASURABLE` - historical CI evidence collection was not activated this batch (no GitHub token
  available; the unauthenticated 60/hour rate cap makes it not worth attempting against 500 real
  commits' worth of lookups). Numerator and denominator both reported as zero/unavailable, not inferred.
- **Fallback reasons** (top 5, all legitimate and independently spot-verified): configuration changed
  (197), graph confidence UNSAFE (130 - entirely `execa`+`trpc`), dependency manifest changed (111),
  lockfile changed (91), GitHub workflow changed (52).
- **Graph confidence distribution**: 370 COMPLETE (74%), 130 UNSAFE (26%, entirely concentrated in
  `execa`+`trpc` - 0% UNSAFE across the other 8 repositories).
- One additional real, distinct fallback trigger appeared twice: `"Deleted source/asset ... not present
  in HEAD dependency graph; legacy dependents cannot be determined"` - a deleted-file edge case
  correctly triggering conservative fallback rather than an unsafe silent skip.

## Runtime

- **DiffCI analysis overhead**: median 1,481ms per delta, p90 3,447ms across all 500. Small relative to
  any real CI job (typically tens of seconds to minutes), but this is the analysis-only overhead, not
  validated against real CI minutes (see below).
- **Cold vs warm**: this batch's architecture doesn't exercise a warm-cache path per delta (each delta
  is genuinely new work by construction, since resumability skips truly-repeated ones entirely rather
  than re-running them warm) - `warmAnalysisP50Ms`/`P90Ms` are correctly 0 here, not a bug; cold/warm
  cache-plan equivalence was separately verified in earlier sessions
  (`tests/shadow/cold-warm-equivalence.test.ts`).
- **Historical CI runtime opportunity: NOT MEASURABLE.** No historical evidence was collected this
  batch (see Safety above). Test-count reduction must NOT be read as a runtime-savings estimate -
  that mapping is exactly what's unmeasured.
- **Net runtime opportunity: NOT MEASURABLE**, for the same reason.

## Cloudflare consumption

- **Real infrastructure used**: `diffci-research-sandbox` Worker + Container (public
  `docker.io/cloudflare/sandbox:0.12.5` image), D1 (`diffci-research`), R2
  (`diffci-research-evidence`), all in the same account as the rest of Stage 0.
- **Reliability**: 5 transient failures across the whole medium batch (2 exec-level sample timeouts, 2
  "internal error" platform blips, 1 dropped connection) out of ~35 total dispatch calls (including
  re-fetches) - all recovered via retry (2 automatically via the widened retry policy fix, 3 via a
  single manual re-invocation, itself proof of the resumability the retry policy relies on: each retry
  picked up exactly where the prior attempt left off). 0 unretryable/persistent failures.
- **Persistence**: 500 D1 `completed_deltas` rows, 500 R2 evidence objects, all independently verified
  present, parseable, and non-duplicated. Zero invalid checkpoints encountered across the whole batch
  (the corrupt-checkpoint path was exercised only in unit tests, not needed live).
- **Cost**: real container CPU-time billing is $0.00002/vCPU-second, active-use only (§1 of the
  architecture doc, verified against live Cloudflare pricing 2026-08-20). At the measured median 1.5s
  DiffCI overhead per delta, plus clone/sample overhead observed in the single-digit seconds per repo
  call, cumulative active container time for this entire medium batch (500 deltas + re-runs +
  investigation clones) is conservatively under 30 minutes total. **Estimated cost: well under $0.10** -
  effectively negligible against the 2,000-credit ($2,000, 1 credit = $1) ceiling. This is an ESTIMATE
  from observed wall-clock timing, not a measured reconciliation against Cloudflare's billing dashboard
  or GraphQL Analytics API - clearly labeled as such, not presented as exact billing data.
- **Projected cost for the full ~2,000-delta experiment**: linearly scaling from the measured
  ~500-delta cost (≈$0.10 estimated), **≈$0.40 estimated** for 2,000 deltas across the full 20-repository
  corpus - trivially within the 2,000-credit budget, with essentially the entire allocation still
  available. Cost was never remotely a constraint in this batch and is not expected to become one at
  full scale; the real gating factors for the full run are engineering readiness (the
  cross-container-instance-across-Worker-crash edge case - see below) and corpus/language coverage, not
  budget.

## Generalization limitations (explicit)

- **tsconfig-less JavaScript**: unchanged from the larger study - `express`, `fastify`, `kleur` remain
  cleanly excluded. Not touched this batch, per the spec's explicit instruction.
- **Unsupported languages** (Python/Go/Rust/Java): unchanged, cleanly excluded via the fast-path fix
  from the larger study. Not touched this batch.
- **Monorepos without a root tsconfig.json**: `vitest-dev/vitest` and `remix-run/react-router` both
  excluded on this basis - a real, material gap for a growing share of the TS/JS ecosystem (monorepo
  tooling is increasingly common). Distinct from Bug 2 above (which was about *source discovery* within
  an existing root config, not the presence of the config itself).
- **AVA-convention test files** (bare filenames in a `test/` directory, no `.test.`/`.spec.` suffix):
  newly discovered this batch via `sindresorhus/ky`. Not fixed - reported as a real, separate
  generalization gap.
- **Graph-confidence degradation on certain monorepo module-resolution patterns**: `trpc/trpc`'s 100%
  UNSAFE confidence (likely pnpm workspace-protocol-related) is a real, unresolved limitation - not
  fixed or investigated further this batch, since doing so was out of scope and risked exactly the
  "tune the tool to improve the numbers" pattern research integrity requires avoiding.

## Required conclusions

1. **Does the mechanism continue to appear real across ≥10 repositories?** Yes. Six of ten repositories
   show genuine, varied discriminative-opportunity signal (6 different repos, opportunity frequencies
   from 11.4% to 80.0%, conditional advantages from 6.1% to 100% median) - not one outlier carrying the
   whole result.
2. **How frequently does a real commit provide a discriminative opportunity?** 28.0% (140/500) across
   the whole batch; per-repository this ranges 0%-80.0% (excluding `ky`'s unreliable data).
3. **When an opportunity exists, how often does DiffCI beat PATH?** 93.6% of the time (131/140); ties
   6.4% (9/140); loses 0% (0/140) in this dataset.
4. **Median/mean advantage conditional on opportunity?** Median 35.9%, mean 53.5% (p25 34.3%, p75/p90
   both 100%, reflecting a real cluster of complete-elimination wins alongside more modest ones).
5. **Across the entire sampled workload, what % of PATH's selected tests does DiffCI eliminate?** 24.6%
   in aggregate (24,240 selected vs PATH's 32,128, against a total of 37,740) - the workload-weighted
   figure, distinct from and lower than the 35.9% conditional-median figure because it's diluted by the
   72% of deltas that are structural ties (where DiffCI can't improve on PATH by definition).
6. **Is the aggregate dominated by one or two repositories?** No - see repository breakdown; six repos
   contribute real positive signal at meaningfully different magnitudes, not one outlier.
7. **Which repository characteristics correlate with large wins?** Deep, narrow module structure (h3,
   zod) - correlational only, 10 repositories is not enough to claim causation.
8. **Where does PATH perform just as well as DiffCI?** The 9 ties (6.4% of opportunities), concentrated
   in `unjs/ofetch` (6 of its 7 opportunities tied) - a small, shallow-dependency codebase where PATH's
   coarse rule already approximates the graph-optimal selection.
9. **Where does DiffCI lose to PATH?** Never within a genuine discriminative opportunity (0 losses). In
   aggregate, only `trpc/trpc` shows DiffCI selecting more than PATH overall (-12.1%), entirely because
   its 100% UNSAFE graph confidence forces conservative FULL fallback on commits where PATH's simpler
   rule doesn't happen to trigger its own fallback - a safety-correctness tradeoff, not a losing
   dependency-analysis comparison.
10. **How frequently does DiffCI conservatively fall back?** 53.4% (267/500) overall; per-repository
    5.7% (h3) to 100% (execa, trpc).
11. **Were any unsafe misses observed?** No (0/500). Not proof of safety - no historical failure
    evidence was evaluable this batch (see #12).
12. **What failure recall can actually be measured?** None - 0 evaluable historical failures, 0/0,
    explicitly `NOT MEASURABLE`, not inferred as 100%.
13. **Do test-count reductions translate into CI-time savings?** Not measured this batch - historical CI
    evidence collection was not activated (no GitHub token, real rate-limit risk at this delta count).
    Explicitly unanswered, not assumed.
14. **Is DiffCI's overhead small relative to work avoided?** Directionally yes (median 1.5s analysis vs.
    typically tens of seconds to minutes of CI work per test) but not validated against measured CI
    minutes - see #13.
15. **How serious is the tsconfig-less-JS gap?** Unchanged from the larger study assessment - real
    (3 of the larger study's corpus), not touched or re-measured this batch.
16. **What did the ~500-delta experiment cost?** Estimated well under $0.10 (see Cloudflare
    Consumption) - not a measured reconciliation, clearly labeled as an estimate.
17. **Will ~2,000 deltas safely fit the remaining 2,000-credit allocation?** Yes, with very large
    margin - projected ≈$0.40 estimated, against a $2,000 ceiling essentially untouched so far.
18. **Is the evidence strong enough to authorize the full ~2,000-delta Stage 0?** See GO/NO-GO below.

## GO / NO-GO for the full ~2,000-delta Stage 0

**Recommendation: GO, with one explicit precondition before launch.**

What this batch established with real, verified, non-circular evidence: the dependency-selection
mechanism is real and generalizes across a structurally diverse 10-repository TS/JS corpus, not an
artifact of the original 2-repo pilot or a lucky small sample. When a commit genuinely gives dependency
analysis room to differ from PATH, it wins 93.6% of the time, by a meaningful margin, and never loses
outright in this dataset. Two real, high-severity bugs were found and fixed via the required
stop-fix-invalidate-rerun process rather than allowed to silently invalidate the result, and the
resumability infrastructure the previous study flagged as blocking is now built, unit-tested, and
verified live on real Cloudflare infrastructure (Gate A), including recovering real production
transient failures automatically.

**The one precondition**: cross-container-instance resumability was proven within this batch's actual
usage pattern (repeated top-level `/v1/run-repo` calls, each re-checking D1 fresh) but the full
2,000-delta experiment's real orchestrator - dispatching 20 repositories with some form of concurrency
or scheduling beyond one-call-per-repository - doesn't exist yet. Building and validating that
orchestration layer (not the resumability *mechanism*, which is done) is the remaining real engineering
gap before launch, plus deciding whether to accept `ky`'s AVA-convention gap and `trpc`'s
UNSAFE-confidence pattern as known limitations for the full corpus or investigate further first.

Budget is not a constraint on this decision - the full run is projected to cost a small fraction of the
remaining allocation.

Do not launch the full ~2,000-delta experiment without separate explicit approval, per the standing
instruction.
