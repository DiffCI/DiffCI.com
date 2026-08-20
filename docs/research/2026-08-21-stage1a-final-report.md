# Stage 1A final report — forensic investigation of DiffCI's Stage 0 limitations (2026-08-21)

**Stage 0 is complete and untouched.** This was a forensic/research phase, not an optimization phase -
no benchmark numbers were rerun or replaced, no fallback rules were weakened, no graph confidence was
made more optimistic. One narrow, well-evidenced bug fix was made (the `pmndrs/valtio` impossible-count
guard, Phase 6) - it adds a non-clamping safety check to the benchmark harness itself, it does not touch
DiffCI's production selection logic, and it was explicitly requested by the task's own Phase 6
instructions upon successful reproduction.

All 11 phases are documented in full in their own reports (linked throughout below); this is the
synthesis.

## What was found, in one paragraph

The 7 fully-UNSAFE repositories are not one problem, or seven unrelated ones - they are roughly 4-5
distinct, precisely identified structural causes, and in 5 of 7 cases the actual unresolved-import
volume is a vanishingly small fraction of an otherwise huge, well-resolved graph (as low as 1 in 4,554
edges), confined to build scripts, generated artifacts, or isolated test fixtures - meaning the current
confidence *policy* (treat any unresolved import anywhere as disqualifying the whole repository) is
disproportionate to the actual risk in most of these cases, a safely-improvable overconservatism rather
than an unavoidable limitation. Separately, forensic investigation of all 10 historical "unsafe misses"
found zero of the 8 distinct affected deltas are confirmed genuine test-selection safety failures - 5 are
confirmed unrelated to code content (lint-job bundling, live-API rate limiting, infrastructure outages,
flaky timing assertions), 3 remain unconfirmed due to expired evidence, none confirmed as real misses.
The one impossible-count anomaly was fully root-caused (a structural gap in the benchmark harness's
checkout sequencing, not DiffCI itself) and fixed. Repository size, tested directly, is not itself
causal - it correlates with where the UNSAFE-triggering structural patterns happen to occur.

## Full phase reports

1. Phase 1 (evidence freeze/verification): this report, §"Phase 1" below.
2. Phase 2/3 (UNSAFE taxonomy + 7-repository forensics): [`2026-08-21-stage1a-unsafe-taxonomy.md`](2026-08-21-stage1a-unsafe-taxonomy.md)
3. Phase 4 (10 historical misses, individually): [`2026-08-21-stage1a-historical-miss-forensics.md`](2026-08-21-stage1a-historical-miss-forensics.md)
4. Phase 5 (replay harness): `tests/fixtures/stage1a-safety-cases/` + `scripts/replay-safety-fixtures.ts`
5. Phase 6 (valtio anomaly, root-caused and fixed): [`2026-08-21-stage1a-valtio-anomaly.md`](2026-08-21-stage1a-valtio-anomaly.md)
6. Phase 7/8 (size analysis + fallback composition): [`2026-08-21-stage1a-size-and-fallback-analysis.md`](2026-08-21-stage1a-size-and-fallback-analysis.md)
7. Phase 9 (headroom, ranked): [`2026-08-21-stage1a-headroom-analysis.md`](2026-08-21-stage1a-headroom-analysis.md)
8. Phase 10 (runtime experiment design): [`2026-08-21-stage1a-runtime-experiment-design.md`](2026-08-21-stage1a-runtime-experiment-design.md)
9. Phase 11 (CI blast-radius architecture, design only): [`2026-08-21-stage1a-blast-radius-architecture.md`](2026-08-21-stage1a-blast-radius-architecture.md)

## Phase 1: evidence freeze/verification

Stage 0 evidence located and independently re-verified without modification: D1 (`diffci-research`,
`completed_deltas`/`repository_runs`/`budget_ledger`), R2 (`diffci-research-evidence`), the final report
(`2026-08-21-stage0-full-experiment-final-report.md`), and the frozen methodology
(`2026-08-21-stage0-full-experiment-frozen-methodology.md`). Frozen reference commit for this
investigation: `3e28cecff0f9b4cef33af518697e9faaab04e6c3`. Independently re-verified via direct D1
query: exactly 2,000 unique deltas = 2,000 total rows (zero duplicates), and 700 UNSAFE+fallback rows
(exactly 7 repositories × 100, confirming the "7 repositories" finding independently of the final
report's own claim). A new Stage 1A namespace was used throughout (a read-only `/v1/forensic/*` Worker
route family, a separate `stage1a-forensic`/`stage1a-replay` schema-version tag, and a dedicated
`docs/research/2026-08-21-stage1a-*.md` document series) - Stage 0's own experiment rows, evidence, and
reports were never written to.

## Answers to the 17 required decision-framework questions

1. **Why were 7/20 repositories completely UNSAFE?** Five distinct structural mechanisms, precisely
   identified per-repository in Phase 3: a dynamic import in a build-tooling script (`date-fns`), a
   tsconfig scoped to declaration-only validation excluding all real source (`execa`), relative imports
   of non-committed generated fixtures (`mikro-orm`, and 5/6 of `unocss`'s cause), a nested-tsconfig/
   alias-scope mismatch for per-example subdirectories (`trpc`), an optional peer-dependency shim file
   (`typeorm`), a Vite-specific `?raw` import-query specifier (1/6 of `unocss`'s cause), and one
   tentative, unconfirmed `.js`-extension resolution question (`nestjs`).

2. **How many distinct root causes explain those seven repositories?** 4-5 distinct mechanisms, not 7
   unrelated ones and not 1-2 universal ones. See the cross-cutting synthesis in the taxonomy report.

3. **Are the dominant causes fixable without weakening safety?** Yes, for the most impactful one: the
   single highest-leverage finding is that in 5 of 7 repositories, the unresolved-import volume is
   under 0.1% of total graph edges and confined to files unrelated to the actual library/test surface -
   a reachability-aware confidence policy (only disqualify confidence when the unresolved import is
   actually reachable from the delta's changed files) would not weaken safety for the paths that
   matter, while reclaiming selectivity for the paths that don't touch the problem area. `trpc` and
   `execa` are more structural (genuine graph-construction capability gaps), not policy questions.

4. **What percentage of the currently inaccessible workload could plausibly become analyzable?** Not
   estimated as a percentage - per the task's explicit instruction (Phase 9), addressable workload
   (700/2,000 deltas, 35% of the corpus) is reported factually; how well DiffCI would perform on that
   newly-eligible workload is not assumed from other repositories' rates.

5. **Is repository SIZE actually the problem, or a proxy for workspace/graph complexity?** A proxy, not
   the problem itself - directly evidenced in Phase 7: `unjs/unstorage` (large by `sourceFiles`,
   `COMPLETE` confidence, a real 171-edge graph) shows 25.3% aggregate reduction, closely matching small
   `pmndrs/zustand`'s 25.5%. Size correlates with more surface area for one of Phase 3's specific
   structural patterns to occur somewhere in a larger codebase, not with a size-intrinsic limitation.

6. **What caused each of the 10 historical unsafe misses?** Individually forensically investigated in
   Phase 4 (10 target instances across 8 distinct deltas - a unit clarification, not a discrepancy).
   2 confirmed `BENCHMARK_MAPPING_ERROR` (lint bundled into a job named "tests"), 3 confirmed
   `ENVIRONMENT_DEPENDENCY` (live-API rate limit, infrastructure outage, flaky timing assertion), 3
   `UNKNOWN` (evidence expired), 0 confirmed genuine test-selection failures.

7. **How many misses share common causes?** 2 of 8 share the exact same mechanism (h3's lint-in-"tests"-
   job); the other 6 have distinct individual causes, though 3 of those (unstorage/TanStack-query/
   valtio) share the broader category of external/environmental non-determinism.

8. **How many misses appear preventable using information available before CI execution?** Zero, for
   the 5 confirmed-unrelated cases - none of the causes found (a lint failure, a rate limit, an
   infrastructure outage, timing flakiness) are things a pre-execution static diff signal could have
   predicted, because none of them are caused by the code change at all.

9. **What conservative rules would prevent them?** None are evidenced as necessary by this dataset,
   since zero confirmed genuine misses were found - see Phase 4's explicit Pareto analysis.

10. **What optimization opportunity would those rules sacrifice?** N/A given (9) - no rule is proposed.

11. **Is there a plausible path from 96.4% observed recall toward production-grade safety without
    eliminating most of DiffCI's savings?** The evidence here suggests the *true* test-selection-caused
    miss rate may be lower than 96.4% recall implied - most of the measured "misses" trace to the
    measurement methodology's own limitations (job-level granularity, non-test jobs included, no
    flakiness filtering) rather than real gaps. The concrete path forward is fixing the *measurement*:
    job-step-level (not job-level) failure attribution, excluding non-test jobs, and a flakiness filter
    (checking whether the same job fails on nearby unrelated commits) - a genuine, scoped Stage 1B
    methodology improvement, not a DiffCI selectivity change.

12. **What caused the `valtio` impossible-count anomaly?** Fully root-caused and fixed (Phase 6): no
    code anywhere in the research pipeline checks the repository out to a delta's specific `headSha`
    before graph/test-discovery runs; a file added historically and later renamed is invisible to the
    tip-state scan while still correctly reported as historically-added by the headSha-independent git
    diff. Confirmed externally via GitHub (the file's current location and name were found directly).

13. **Which fallback category represents the largest safely-addressable optimization headroom?**
    `package.json` metadata-only changes (412 instances) has the clearest, lowest-complexity, safely-
    scoped fix (field-level diffing) with whole-corpus reach; the reachability-aware confidence-policy
    change (Phase 9, item 1) has the single largest per-change leverage (400 deltas, 4 repositories, one
    policy change).

14. **Is improving graph coverage more valuable than improving the selector itself?** Yes, unambiguously,
    per this investigation's central finding (restated from the task's own framing, now evidenced): the
    selector already wins 94.3% of the time with zero PATH wins when it gets a real opportunity - the
    problem is opportunity *frequency*, not selector quality. Every ranked headroom item (Phase 9)
    targets graph/confidence coverage, not selection-logic aggressiveness.

15. **What exact experiment should measure real CI wall-clock savings next?** Fully designed in Phase
    10 - FULL/PATH/DiffCI wall-clock+CPU+setup time on identical deltas, run on real GitHub Actions
    runners (not Cloudflare Containers, for experimental validity), repeated for noise control, both
    cold and warm graph-cache states measured, DiffCI's own overhead added back into its total. Not
    launched.

16. **Is the current dependency graph architecture capable of eventually supporting full CI blast-
    radius analysis?** Partially, per Phase 11's design: reachability and entry-point classification
    generalize directly; typecheck blast radius needs a new type-vs-value-change distinction; build
    blast radius needs bundler-boundary awareness the current graph lacks; lint blast radius mostly
    doesn't need the graph at all; integration/E2E blast radius likely cannot be fully captured by
    static graph analysis alone, per Phase 4's own findings about environment-dependent failures. This
    work should follow, not precede, the graph-confidence improvements Phase 9 ranks highest.

17. **Based on all evidence, should DiffCI proceed to Stage 1B?** See the decision below.

## Top 3 engineering problems worth solving, ranked

1. **Confidence-policy reachability refinement** (Phase 9, item 1). Addressable workload unlocked: up
   to 400 deltas across 4 repositories (`date-fns`, `mikro-orm`, `typeorm`, `unocss`) with one bounded
   policy change. Safety implications: none identified - an unresolved import that IS reachable from a
   delta's changed files would still correctly trigger UNSAFE; this only changes behavior for the
   already-demonstrated case of an unresolved import confined to an unrelated, isolated part of the
   graph. Complexity: medium-high (a real, bounded graph-traversal capability, not a policy toggle).

2. **Historical safety-measurement methodology fix** (Phase 4, question 11 above). Not workload-
   unlocking in the same sense, but directly resolves whether DiffCI's actual safety picture is
   materially better than Stage 0's reported 96.4% recall implied. Safety implications: this is itself a
   safety-measurement improvement - makes future safety claims more trustworthy, not less conservative.
   Complexity: low-medium (job-step-level attribution instead of job-level, exclude non-test jobs, add a
   flakiness filter).

3. **`tsconfig`-file-scope fallback + `package.json` field-level diffing** (Phase 9, items 2 and 4,
   grouped as one tier given comparable complexity). Addressable workload: 100 confirmed deltas
   (`execa`) plus likely ecosystem-wide reach beyond this corpus for the tsconfig fix; whole-corpus reach
   for the package.json fix. Safety implications: none identified for either - both are narrowing an
   overconservative default toward a more precise one, not weakening a case that's actually required.
   Complexity: medium and low-medium respectively.

*(`trpc`'s nested-tsconfig fix and the base-graph deleted-source handling remain real, identified
opportunities - see the headroom report - but rank below these three given trpc's higher architectural
invasiveness and unconfirmed practical benefit, and the deleted-source fix's real 2x graph-construction
cost tradeoff.)*

## Recommended order of implementation

1. Historical safety-measurement methodology fix first (cheapest, and everything else should be
   evaluated against a more trustworthy safety baseline).
2. Confidence-policy reachability refinement (highest workload-unlock leverage, no identified safety
   cost).
3. `tsconfig`-file-scope fallback and `package.json` field-level diffing (in parallel - independent of
   each other and of items 1-2).
4. Stage 1B runtime experiment (Phase 10's design) - can begin once items 1-3 land, to measure whether
   the *reclaimed* workload from items 2-3 actually produces real CI time savings, not just test-count
   reduction.
5. `trpc`'s nested-tsconfig support and deleted-source base-graph handling - larger, costlier changes,
   deferred until the cheaper wins are banked and their real-world effect is measured.
6. CI blast-radius expansion (Phase 11) - explicitly sequenced last, since it would inherit whatever
   graph-confidence gaps remain unaddressed.

## Exact proposed Stage 1B experiment

Per Phase 10's full design: a stratified-sample FULL/PATH/DiffCI wall-clock CI-time comparison on real
GitHub Actions runners, covering both `DISCRIMINATIVE_OPPORTUNITY` and `MANDATORY_FALLBACK` deltas,
repeated runs for noise control, both cold and warm graph-cache states, with "net CI time saved vs PATH
after DiffCI's own overhead" as the headline metric - not test-count reduction. This should run AFTER
(not before) the historical safety-measurement methodology fix and the highest-leverage graph-confidence
work, so the sample it draws from reflects DiffCI's corrected (not current) reach.

## Decision

**GO WITH CONDITIONS.**

Not an unconditional GO: real, unresolved capability gaps remain (`trpc`'s nested-tsconfig mismatch,
`execa`'s tsconfig-scope exclusion, 3 `UNKNOWN` historical misses that were never confirmed benign), and
the actual CI-time benefit of any of this work remains completely unmeasured - test-count reduction is
not CI-time reduction, and this investigation deliberately did not conflate the two anywhere. Not
STOP/fundamental: this investigation did not surface a single confirmed genuine test-selection safety
failure across all 10 historical misses investigated, found that repository size is not itself causal
(directly falsifying the more pessimistic reading of Stage 0's own size-effect finding), and identified
concrete, safety-neutral, well-scoped fixes for the single largest deterioration between the medium
batch and the full experiment (the UNSAFE-rate jump). The evidence supports continued, scoped
engineering investment along the three ranked priorities above, gated on: (a) the historical safety-
measurement methodology fix landing first and not revealing new, previously-hidden real misses when
applied at greater precision, and (b) the Stage 1B runtime experiment actually confirming test-count
reduction translates to real CI-time savings before any of this is treated as a validated product
improvement rather than a promising research direction.

## What this report does NOT do

Per the task's explicit instruction: this is Stage 1A's final deliverable. **Stage 1B has not been
started.** No broad graph-coverage improvements were implemented beyond the one narrow, explicitly-
requested valtio fix. Awaiting explicit approval before any further implementation work begins.
