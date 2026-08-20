# Stage 0 full experiment — final report (2026-08-21)

**20 repositories, 2,000 real commit deltas, real Cloudflare execution. This is the final Stage 0
validation before any Stage 1 decision.** Per the task's explicit instruction, this report does not
optimize for a favorable narrative — where the evidence is weaker or more uncertain than the medium
batch suggested, that is stated plainly below.

## Executive result

DiffCI's selective-testing advantage **does not disappear at scale, but it concentrates much more
narrowly than the 500-delta medium batch suggested.** When DiffCI gets a genuine opportunity to be
selective (29.8% of deltas), it wins overwhelmingly - 94.3% win rate, **zero PATH wins** across 1,899
opportunity-eligible deltas, 95% median reduction. But the workload-weighted **aggregate** reduction
relative to PATH across the full corpus fell from the medium batch's 24.6% to **4.2%**, because **35% of
the 20 repositories (7/20) hit 100% mandatory-fallback or UNSAFE graph confidence** - roughly 3.5x the
medium batch's 10% rate - and a genuine, newly-discovered **size effect**: small repositories show a
44.9% aggregate reduction, large repositories show **-0.95%** (statistically indistinguishable from
zero). A repository-clustered bootstrap 95% CI on the aggregate figure is **[-4.8%, +47.9%]** - wide
enough to cross zero, meaning this specific 19-20 repository sample cannot rule out a null population
effect with confidence, even though the point estimate and the opportunity-conditioned numbers are
positive.

**Safety held up but was not perfect at this scale**: DiffCI had 10 unsafe misses (of 280 real
historical failures found via the newly-wired authenticated GitHub Actions evidence collection) vs
PATH's 82 - a large safety advantage, but not the "zero misses" impression the medium batch and early
partial snapshots gave.

**One genuine correctness bug was found and handled per protocol**: 1 of 2,000 deltas (0.05%) showed an
impossible count (`testsSelectedByDiffci > testsTotal`). Investigated, root cause narrowed to a likely
benchmark-harness checkout-sequencing artifact (not confirmed with certainty; the container that
produced it no longer exists to re-debug), excluded from aggregate stats rather than silently kept or
patched under time pressure on an unconfirmed hypothesis. See Research Integrity below.

## Research integrity

- **Methodology frozen before execution** at commit `5c9e936f23fc1309dac4f8f72240d93168148c6c`
  (`docs/research/2026-08-21-stage0-full-experiment-frozen-methodology.md`), hashed (SHA-256, 13 files).
  Corpus frozen before any of the 10 new repositories were run
  (`docs/research/2026-08-21-stage0-full-experiment-corpus-selection.md`).
- **Deviations, all logged before being made, none affecting benchmark correctness**:
  1. `/v1/stop` no-op bug (Gate 0, commit `5c9e936`) - orchestrator infrastructure, not benchmark logic.
  2. Authenticated GitHub historical evidence collection wired in (commit `3352e33`) - a pure evidence
     *addition* (fields that were previously always absent), not a change to sampling, selection,
     aggregation, or classification logic.
- **One deviation NOT made**: the `pmndrs/valtio` impossible-count delta was investigated but the
  underlying code was **not** patched mid-benchmark, because root cause was not confirmed with the
  certainty the frozen methodology's "unambiguous correctness bug" bar requires for a live fix. It is
  excluded from aggregate/opportunity stats (N=1,899 of 1,900 test-eligible deltas) with the same
  precedent as `sindresorhus/ky`'s known AVA-convention gap - documented, not silently absorbed, not
  papered over with an unreviewed fix.
- **Known capability gaps preserved, not opportunistically fixed**: tsconfig-less JS, monorepos without
  a root tsconfig, `ky`'s AVA-convention test discovery, `trpc`'s UNSAFE workspace structure - all
  unchanged from the medium batch.
- **The unconditional median stayed at 0%** (median task reduction vs FULL = 0.0%), exactly as the task
  spec anticipated could legitimately happen at this scale - reported exactly, not hidden or reframed.

## Corpus

20 of 20 pre-selected repositories were successfully analyzed; **zero were excluded** (no backup
repository was needed). Exact final list (100 commits each, 2,000 total):

`axios/axios`, `colinhacks/zod`, `pmndrs/jotai`, `pmndrs/zustand`, `sindresorhus/execa`,
`sindresorhus/ky`, `trpc/trpc`, `unjs/defu`, `unjs/h3`, `unjs/ofetch` (10 kept from the medium batch,
unchanged selection criteria) + `honojs/hono`, `nestjs/nest`, `typeorm/typeorm`, `TanStack/query`,
`date-fns/date-fns`, `mikro-orm/mikro-orm`, `unjs/unstorage`, `unocss/unocss`, `pmndrs/valtio`,
`redis/ioredis` (10 new, selected for structural diversity before any were run).

**Global unique delta count: exactly 2,000**, independently verified via direct D1 query
(`COUNT(DISTINCT logical_delta_key) = COUNT(*) = 2000`) both globally and per-repository (all 20 repos
independently show `unique_deltas = total_rows = 100`). Zero duplicates anywhere.

## Selection results

*Test-level counts (the primary signal, per the 2026-08-19 pilot's established finding), N=1,899
(excludes `sindresorhus/ky`'s known-unreliable test counts and the 1 impossible-count anomaly).*

| Metric | Value |
|---|---|
| `sumTestsTotal` | 380,466 |
| `sumTestsSelectedByPath` | 344,694 |
| `sumTestsSelectedByDiffci` | 330,346 |
| Aggregate reduction vs FULL | 13.2% |
| Aggregate PATH reduction vs FULL | 9.4% |
| **Aggregate DiffCI reduction relative to PATH** | **4.16%** |
| Median unconditional task reduction vs FULL | 0.0% (reported exactly, as anticipated) |

## Opportunity-conditioned results (the real signal)

`MANDATORY_FALLBACK` / `BASELINE_ALREADY_OPTIMAL` / `DISCRIMINATIVE_OPPORTUNITY`, classified
independent of DiffCI's own outcome (non-circular by construction - depends only on `fallback` and
PATH's own selection).

| Bucket | Count | % |
|---|---|---|
| `MANDATORY_FALLBACK` | 1,146 | 60.3% |
| `BASELINE_ALREADY_OPTIMAL` | 188 | 9.9% |
| `DISCRIMINATIVE_OPPORTUNITY` | 565 | **29.8%** |

Within the 565 `DISCRIMINATIVE_OPPORTUNITY` deltas:

| Metric | Value |
|---|---|
| DiffCI wins | 533 (94.3%) |
| Ties | 32 (5.7%) |
| **PATH wins** | **0 (0.0%)** |
| Median conditional reduction vs PATH | **95.0%** |
| Mean conditional reduction vs PATH | 66.0% |
| p25 / p75 / p90 | 34.3% / 100% / 100% |
| Aggregate PATH-selected within opportunities | 53,628 |
| Aggregate DiffCI-selected within opportunities | 16,630 |

**Comparison to the medium batch**: opportunity frequency held essentially steady (28.0% → 29.8%), and
the win rate improved slightly (93.6% → 94.3%, with PATH's rare win in the medium batch disappearing
entirely here). The conditional signal is genuinely robust at 4x the sample size. What changed
dramatically is *how often DiffCI gets that chance* across a broader, less curated set of real-world
repositories - see the size-effect finding below.

## Repository-level breakdown

*n=100 per repo (nestjs/nest's per-delta test-count breakdown is verified via D1 summary columns but
was not available for the deeper statistical scripts below due to a lost response file from a client
timeout - see Gate 3 report; its orchestration-level data, aggregated task-level `buildStage0Report`
figures, and D1-verified counts are unaffected).*

| Repository | Fallback rate | UNSAFE rate | Discriminative opportunities | Agg. reduction vs PATH | Overhead p50/p90 (ms) |
|---|---|---|---|---|---|
| `TanStack/query` | 12% | 0% | 64 | 84.2% | 884 / 1,369 |
| `axios/axios` | 33% | 0% | 44 | 56.1% | 963 / 1,509 |
| `colinhacks/zod` | 6% | 0% | 83 | 41.8% | 1,756 / 2,797 |
| `date-fns/date-fns` | **100%** | **100%** | 0 | -8.7% | 1,977 / 2,757 |
| `honojs/hono` | 19% | 0% | 81 | 61.5% | 1,480 / 1,842 |
| `mikro-orm/mikro-orm` | **100%** | **100%** | 0 | -8.7% | 3,191 / 7,452 |
| `nestjs/nest` | **100%** | **100%** | 0 | -2.0% | n/a (not sampled) |
| `pmndrs/jotai` | 41% | 0% | 48 | 24.1% | 1,149 / 1,810 |
| `pmndrs/valtio` | 45% | 0% | 41* | 36.6% | 2,134 / 7,103 |
| `pmndrs/zustand` | 32% | 0% | 18 | 25.5% | 967 / 1,581 |
| `redis/ioredis` | 47% | 0% | 46 | 49.2% | 979 / 1,579 |
| `sindresorhus/execa` | **100%** | **100%** | 0 | n/a (0 PATH-selected) | 1,002 / 1,490 |
| `sindresorhus/ky` | 12% | 0% | 0** | n/a** | 806 / 1,529 |
| `trpc/trpc` | **100%** | **100%** | 0 | -13.6% | 1,847 / 2,853 |
| `typeorm/typeorm` | **100%** | **100%** | 0 | -9.9% | 3,691 / 7,650 |
| `unjs/defu` | 79% | 0% | 14 | 7.5% | 2,245 / 6,563 |
| `unjs/h3` | 13% | 0% | 67 | 25.0% | 1,091 / 1,973 |
| `unjs/ofetch` | 64% | 0% | 27 | 6.6% | 860 / 3,152 |
| `unjs/unstorage` | 55% | 0% | 32 | 25.3% | 2,280 / 6,009 |
| `unocss/unocss` | **100%** | **100%** | 0 | -4.2% | 1,378 / 1,969 |

\* one of `valtio`'s 42 raw discriminative-opportunity deltas is the excluded impossible-count anomaly.
\*\* `ky`'s test-count metrics are excluded from all test-level aggregates per the established AVA gap.

**Seven of twenty repositories (35%) are 100% UNSAFE/fallback** and contribute nothing but drag to the
aggregate figure: `date-fns/date-fns`, `mikro-orm/mikro-orm`, `nestjs/nest`, `sindresorhus/execa`,
`trpc/trpc`, `typeorm/typeorm`, `unocss/unocss`. Three of these (`date-fns`, `mikro-orm`, `nestjs`) were
**newly discovered** by this experiment - the medium batch had no equivalent-severity negative case
beyond `trpc` and `execa`. Several negative repos show a small but real *negative* aggregate reduction
(worse than PATH, not just equal to it) - `trpc` at -13.6%, `typeorm` at -9.9%, `date-fns`/`mikro-orm`
at -8.7% - this is possible because 100%-fallback deltas select the FULL test suite, which can exceed
what an already-selective PATH baseline picks for a config/manifest/lockfile-only change; DiffCI does
not do materially worse than PATH's own selection logic in absolute terms (both fall back to broad
selection under the same triggers), but this is worth being honest about rather than rounding to "flat."

## What correlates with DiffCI working well (correlation, not causation - hypothesis-tested, not assumed)

The task asked whether DiffCI's advantage concentrates in deep/narrow dependency structures rather than
merely reflecting coarse directory-prefix selection. The clearest, most reproducible correlate found in
this dataset is **repository size**, not structural depth specifically:

- **Small repos (below-median `sourceFiles`, 10 repos): 44.9% aggregate reduction.**
- **Large repos (above-median `sourceFiles`, 9 repos): -0.95%** (statistically indistinguishable from
  zero given the bootstrap CI width below).

This is a genuine, falsifiable hypothesis test result, not an assumption: DiffCI's value proposition, on
this corpus, is concentrated in small-to-medium single-package TypeScript/JavaScript libraries
(`zustand`, `jotai`, `h3`, `hono`, `axios`, `zod`, `ofetch`, `defu`, `unstorage`, `valtio`), not in large
application frameworks or ORMs (`nestjs`, `typeorm`, `mikro-orm`) - though the large-repo negative
results are dominated by the 100%-fallback repos in that bucket (`nestjs`, `typeorm`, `mikro-orm`, all
large), so size and UNSAFE/fallback-rate are confounded in this sample and cannot be fully disentangled
with only 19-20 repositories. A larger, size-stratified Stage 1 corpus would be needed to separate these
two effects cleanly.

## Where DiffCI does NOT work (explicit, not buried)

- **The 7 fully-UNSAFE/fallback repositories** above - zero discriminative opportunities, DiffCI
  provides no selective-testing value at all on these, full stop.
- **Large repositories generally** - see the size-effect finding above.
- **`unjs/defu` and `unjs/ofetch`** - graph-analyzable (0% UNSAFE) but heavily fallback-prone (79% and
  64% respectively) for reasons distinct from graph confidence (mostly config/manifest/lockfile
  triggers) - low real-world opportunity despite technical graph capability.
- **Any repository outside TS/JS** - still completely unsupported; 0 non-TS/JS repos were in this
  corpus by construction, so this experiment provides no new evidence either way on that gap.

## Safety and historical failure recall

Using the newly-wired authenticated GitHub Actions historical evidence collection (4,500 req/hr vs the
previous 60/hr unauthenticated limit that made this NOT MEASURABLE before):

| Metric | Value |
|---|---|
| Historical failures observed | 280 (across 154 distinct failing deltas) |
| DiffCI unsafe misses | **10** |
| PATH unsafe misses | 82 |
| Observed DiffCI failure recall | **96.4%** |
| Observed PATH failure recall | 70.7% |

**This is measured, not assumed** - real GitHub Actions job-level data, not fabricated from job-level
data at the test level (only job-level failure recall is measured; individual failing-test-level recall
remains NOT MEASURABLE, since no JUnit/test-report parsing exists in this codebase - stated explicitly,
not implied). DiffCI's safety advantage over PATH is large and real (96.4% vs 70.7%), but **not
perfect** - 10 real misses is a genuine finding that should inform Stage 1 scoping, not be rounded to
"zero misses" as smaller partial snapshots during this run briefly suggested.

## Runtime overhead (DiffCI's own analysis cost, measured)

*All 1,900 records with timing data (excludes `nestjs`, whose per-delta timing rows are D1-verified but
were not locally available for percentile computation - see the repository table's note).*

| Percentile | Overhead (ms) |
|---|---|
| Median | 1,426 |
| Mean | 2,024 |
| p75 | 2,123 |
| p90 | 3,676 |
| p95 | 5,383 |
| Max | 52,426 |

**Investigated, not removed**, per the spec: the max outlier (52.4s) is from `typeorm/typeorm`, whose
p90 (7,650ms) is already the second-highest in the corpus - a large, complex ORM codebase producing
genuinely slower cold graph construction on its largest deltas, not a bug. `mikro-orm` and `valtio` show
similarly elevated p90s (7,452ms and 7,103ms) for the same reason (cold-cache, larger dependency
graphs).

## Runtime savings methodology - what is and is NOT measurable

Per the task's explicit requirement never to directly convert "X% fewer tests" into "X% faster CI":

- **MEASURED**: DiffCI's own analysis overhead (table above) - real wall-clock time DiffCI itself adds
  to a CI run.
- **MEASURED**: test-*count* reduction (aggregate and opportunity-conditioned figures above).
- **NOT MEASURABLE** in this experiment: actual CI wall-clock-time reduction from running fewer tests.
  This benchmark never executed the selected/skipped test suites against real CI infrastructure to
  measure elapsed time - it only computed which tests DiffCI *would* select, and compared counts. Test
  count reduction is a reasonable proxy for CI time reduction only if test execution time is
  roughly uniform per test, an assumption **not verified** in this experiment. This remains an open
  question for Stage 1, explicitly, rather than silently assumed favorable.

## Economics

Real measured Cloudflare spend for the complete run: **$0.3955** for 2,000 deltas across 20
repositories (`≈$0.000198/delta`), verified via `budget_ledger`'s wall-clock-based Container cost model
- ≈0.02% of the $2,000 budget ceiling.

Extrapolation (labeled ESTIMATED - linear extrapolation of the measured per-delta Cloudflare analysis
cost only; this is NOT customer CI compute savings, which remains unmeasured per the runtime-savings
section above):

| Analyses | Projected Cloudflare cost (ESTIMATED) |
|---|---|
| 10,000 | ≈$1.98 |
| 100,000 | ≈$19.78 |
| 1,000,000 | ≈$197.75 |

This is a linear extrapolation and carries the same caveat the pre-Gate-1 projection did: real
telemetry, not blind trust, should govern any actual Stage 1 budget planning - this number does not
account for potential per-analysis cost changes at different scale tiers (e.g. cold-start amortization,
concurrent-instance pricing tiers, or larger/different repositories than this corpus).

## Statistical stability analysis

This corpus is 2,000 commits from 20 repositories - **not 2,000 independent observations**. All analysis
below explicitly respects that clustering.

**Repository-clustered bootstrap 95% CI** (B=2,000 resamples of the 19 repositories with local
per-delta data available, aggregate DiffCI reduction vs PATH, test-level, fixed seed for
reproducibility):

- Point estimate: **5.1%**
- **95% CI: [-4.8%, +47.9%]**

This interval **crosses zero**. Per the explicit instruction not to use statistical sophistication to
disguise weak evidence: **this specific 19-20 repository sample cannot rule out a null (or even
slightly negative) true population-level aggregate effect with confidence**, even though the point
estimate, the opportunity-conditioned win rate, and the conditional median reduction are all positive
and the opportunity-conditioned numbers (94.3% win rate, 0 PATH wins) are much more stable because they
condition on a within-repo mechanism rather than depending on which repos happen to be UNSAFE/fallback.

**First-half vs second-half stability** (within each repository's own 100-commit sampled sequence,
first 50 vs last 50 commits per repo): 4.68% vs 5.53% aggregate reduction - reasonably consistent,
suggesting the low aggregate figure is a genuine repository-composition effect, not a temporal-drift
artifact within repositories.

**Size-stratified split**: see the correlation section above (44.9% small vs -0.95% large) - this is the
single largest driver of variance found, larger than the first/second-half split, confirming which axis
actually explains the medium batch vs full-experiment discrepancy.

**Low vs high opportunity-frequency split**: -9.3% (10 lower-opportunity repos) vs 52.3% (9
higher-opportunity repos) - expected and consistent by construction (opportunity frequency mechanically
drives the aggregate figure), included for completeness rather than as an independent finding.

## Answers to the 26 required questions

1. **Does the signal reproduce at 4x scale?** Partially. The opportunity-conditioned signal (94.3% win
   rate, 0 PATH wins, 95% median conditional reduction) reproduces and is arguably stronger than the
   medium batch. The aggregate/workload-weighted signal does NOT reproduce at the same magnitude (24.6%
   → 4.2%), driven by a much higher real-world fallback/UNSAFE rate (10% → 35% of repos) in the larger,
   less-curated corpus.
2. **Does it generalize across ~20 repositories, or is it concentrated in a few?** Concentrated. 12/20
   repositories (60%) contribute any positive opportunity at all; 7/20 (35%) contribute zero.
3. **Opportunity frequency at scale?** 29.8% (565/1,899), stable vs the medium batch's 28.0%.
4. **Win/loss ratio within opportunities at scale?** 533 wins / 32 ties / 0 losses (94.3% win rate),
   improved from the medium batch (93.6%, with rare PATH wins).
5. **Conditional advantage distribution at scale?** Median 95.0%, mean 66.0%, p25/p75/p90 =
   34.3%/100%/100%.
6. **Workload-weighted aggregate reduction at scale?** 4.16% relative to PATH (vs medium batch's 24.6%)
   - the central negative finding of this experiment.
7. **Is the result dominated by a small number of repositories?** Yes for the aggregate figure - see
   the size-effect and per-repo table. No for the opportunity-conditioned win rate, which held near-94%
   across a broad mix of repos with any opportunities at all.
8. **What correlates with large wins?** Repository size (small repos far outperform large ones) is the
   clearest, most falsifiable correlate found; confounded with UNSAFE/fallback rate in this sample size.
9. **Where does DiffCI provide little/no benefit?** The 7 fully-UNSAFE/fallback repositories, large
   repositories generally, and non-TS/JS repositories (untested here, known gap).
10. **Fallback rate and reasons?** 60.3% of all deltas hit `MANDATORY_FALLBACK`. Top categorized
    reasons: config changes (686 delta-reason pairs), UNSAFE graph confidence (600), dependency manifest
    changes (412), other/unrecognized file (434), lockfile changes (325), deleted source (202), workflow
    changes (167).
11. **Graph confidence distribution?** COMPLETE: 1,200 (63.2%), UNSAFE: 600 (31.6%), PARTIAL: 100
    (5.3%), across the 1,900-record dataset with local confidence data; UNSUPPORTED: 0 (all corpus
    repos are TS/JS by construction).
12. **Unsafe misses?** DiffCI: 10. PATH: 82. Both real, measured via authenticated historical evidence.
13. **How many historical failures were evaluable?** 280 observed across 154 distinct failing deltas -
    all `MEASURABLE`, using the newly-authenticated GitHub Actions evidence path.
14. **Measured failure recall?** DiffCI 96.4%, PATH 70.7% - both real percentages from a non-zero
    denominator (154 failing deltas), never claimed as 100% from an empty base.
15. **Does test-count reduction translate to CI-time reduction?** NOT MEASURED in this experiment - see
    the Runtime Savings Methodology section. Stated as an open question, not assumed favorable.
16. **Is there a net CI-time opportunity even after accounting for DiffCI's own overhead?** Cannot be
    answered with confidence without the CI-time measurement in question 15; DiffCI's own overhead
    (median 1.4s, p95 5.4s) is small in absolute terms but the comparison basis (actual test suite
    wall-clock time saved) is unmeasured.
17. **p50/p90/p95 DiffCI overhead?** 1,426ms / 3,676ms / 5,383ms (max 52,426ms, investigated as a real
    `typeorm` cold-graph-construction outlier, not removed).
18. **Which repository types remain unsupported?** Non-TS/JS languages entirely (untested this
    experiment); tsconfig-less JavaScript and monorepos without a root tsconfig (known, preserved,
    unchanged).
19. **Severity of the four known gaps at this scale?** tsconfig-less-JS and monorepo-without-root-config
    remain excluded-at-selection (0 corpus impact, since excluded repos never entered the corpus).
    `ky`'s AVA gap remains isolated to 1/20 repos. `trpc`'s UNSAFE structure is now one of **7** (not 1)
    UNSAFE-graph repositories - the severity of "structures producing UNSAFE confidence" increased
    substantially at true scale, the most significant change to the four gaps' relative severity.
20. **Total actual Cloudflare cost?** $0.3955 for the complete 2,000-delta run - measured, not
    projected.
21. **Projected cost at 10k/100k/1M analyses?** ≈$1.98 / ≈$19.78 / ≈$197.75 (ESTIMATED, linear
    extrapolation of Cloudflare analysis cost only - explicitly not customer CI compute savings).
22. **Does the evidence justify Stage 1?** See the decision below - qualified yes, with specific
    conditions, not an unconditional yes.
23. **What should Stage 1 test?** See the decision below.
24. **Statistical stability at 2,000 deltas / 20 repos?** Wide - the repository-clustered bootstrap CI
    on the aggregate figure crosses zero ([-4.8%, +47.9%]); the opportunity-conditioned metrics are far
    more stable (consistent across first/second-half split and across the broader repo mix).
25. **Domination-by-few-repos check?** Confirmed present for the aggregate figure (dominated by which
    repos are/aren't UNSAFE), absent for the opportunity-conditioned win rate.
26. **Correlates of where DiffCI adds little value beyond directory-prefix selection?** Not directly
    tested (would require a directory-prefix-only baseline, which this experiment did not build - PATH
    is already a smarter baseline than raw directory-prefix matching). This remains an open
    methodological gap for Stage 1 to close, not something this experiment can answer with the evidence
    collected.

## Stage 1 decision

**GO WITH CONDITIONS.**

Not an unconditional GO: the workload-weighted aggregate advantage is small (4.2%) and statistically
uncertain (CI crosses zero) at this sample size, and DiffCI showed real (not zero) safety misses at
scale. Not a STOP: the opportunity-conditioned signal is strong, consistent, and *improved* at 4x scale
(94.3% win rate, zero PATH wins, 95% median conditional reduction), the safety advantage over PATH
remains large in absolute terms (96.4% vs 70.7% recall), and a clear, falsifiable, actionable hypothesis
(the size effect) now exists to explain the gap between the medium batch and this experiment rather than
leaving it unexplained.

**Conditions for Stage 1**:
1. **Deliberately stratify the Stage 1 corpus by repository size** to separate the size effect from the
   UNSAFE/fallback-rate confound identified here - this experiment's 19-20 repositories cannot
   disentangle them.
2. **Measure actual CI wall-clock time**, not just test counts, for at least a subset of deltas - the
   central unanswered question (15/16 above) that determines whether the test-count reduction actually
   matters to customers.
3. **Investigate the UNSAFE-graph-confidence rate directly** - going from 1/10 to 7/20 repositories is
   the single largest deterioration between the two experiments and materially caps DiffCI's addressable
   market on TS/JS repos alone; understanding *why* (metaprogramming-heavy frameworks? build-tool
   complexity? something fixable vs a structural limit?) should be a first-class Stage 1 investigation,
   not a repeat of "document and move on."
4. **Resolve or bound the `pmndrs/valtio` impossible-count anomaly** with a proper reproduction attempt
   before it can recur at larger scale - it was rare (1/2,000) but represents a real, uninvestigated-to-
   certainty correctness question in the benchmark harness itself.

## What this report does NOT do

Per the explicit instruction: **STOP. Do not begin Stage 1. Do not launch anything beyond Stage 0
without separate, explicit approval.** This report is Stage 0's final deliverable, not authorization to
proceed - the conditions above describe what a Stage 1 *would* need to test, not a green light to start
building it.
