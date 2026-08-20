# Stage 0 medium-batch pre-run gap analysis (2026-08-21)

Concise by design - the detailed history is already in `docs/research/2026-08-20-*` (architecture,
small-batch, larger-study reports) and this doc doesn't re-derive it. This is specifically "what changed
since the larger study, and what did that change require."

## What already existed and was reused unchanged

- **Corpus / sampler / graph builder / DiffCI planner / PATH baseline**: `src/research/repository/`,
  `src/repo/graph.ts`, `src/planner/`, `src/planner/path-baseline.ts` - untouched. `sampleCommits()`
  (`src/research/repository/sampler.ts`) is already deterministic (pure function of `git log`); reused
  as-is for the medium batch's 50-commits-per-repo sampling via the new sample-phase script.
- **Stage 0 aggregator**: `src/research/benchmark/aggregator.ts` - untouched, still used for the
  standard summary; the medium batch's opportunity-conditioned analysis is additive
  (`opportunity-analysis.ts`), not a replacement.
- **Budget guard**: `src/research/config/cost-model.ts` - real Cloudflare pricing already verified
  2026-08-20, three-tier thresholds already implemented. Reused for the cost projection in the final
  report; not modified.
- **Retry handling**: `src/research/cloudflare/retry.ts` - the transient-container-failure retry policy
  built 2026-08-20, reused unchanged for both `/v1/validate` and the new `/v1/run-repo` endpoint.
- **Session-ID implementation**: `src/research/cloudflare/session-id.ts` - the hash-based fixed-length
  session ID built 2026-08-20 after the real `spring-petclinic` overflow. Reused unchanged.
- **Repository exclusion logic**: `src/research/repository/collector.ts` - the root-only tsconfig check
  and known-unsupported-language fast-path (both fixed 2026-08-20 after real bugs: fastify's nested
  tsconfig false positive, flask/cobra/junit5's wasted clone time). Reused unchanged; still the correct,
  verified-live behavior.
- **Historical CI evidence**: `src/research/historical/` exists (built 2026-08-20 groundwork, GitHub
  REST fetcher, MEASURABLE/PARTIALLY_MEASURABLE/UNAVAILABLE classification) but has never been exercised
  live - no GitHub token is available, and the unauthenticated 60/hour rate cap makes it not worth
  attempting against ~500 real deltas' worth of commits. Left off for this batch, reported as
  UNAVAILABLE across the board rather than silently attempted and mostly failing on rate limits.

## What was genuinely missing and had to be built (this session, 2026-08-21)

1. **Cross-container resumability** - the explicit blocking gap. Nothing in the codebase before today
   let a fresh container instance recognize work a previous container/Worker invocation had already
   completed; the old `/v1/validate` path always wiped its container and re-analyzed from scratch, and
   even within one call, results were only persisted in bulk at the very end. Built:
   `src/research/cloudflare/resumable-batch.ts` (the D1-check-before-dispatch decision logic, tested
   against fake D1/R2), two new container-side scripts (`cloudflare-sample-commits.ts` /
   `cloudflare-analyze-batch.ts`) replacing the previous one-shot clone-sample-analyze-everything script
   for this endpoint, and a new Worker endpoint `POST /v1/run-repo` that checks D1 before dispatching
   each batch and persists incrementally. `runner.ts`'s `runRepoBenchmark()` gained one new optional
   field (`commits`) to let the batch-analyze script hand it a specific delta list instead of always
   re-sampling - everything else about the actual analysis path is untouched.
2. **Opportunity classification** - did not exist. `src/research/benchmark/opportunity-analysis.ts`,
   built to directly test (rather than assume) the small/larger-batch reports' "0% median is swamped by
   structural ties" explanation, with an explicit non-circularity guarantee (classification depends only
   on `fallback` and PATH's own selection, never on DiffCI's selection).
3. **Aggregate workload-weighted metrics** - `computeAggregateWorkloadMetrics()` in the same module,
   reproducing the larger study's 293/777/910 numbers as a regression anchor.
4. **10-repository TS/JS corpus** - the larger study only produced 6 graph-capable repos out of 19
   attempted (13 excluded, mostly by design - non-JS/TS languages). The medium batch needs ≥10 real
   analyzable TS/JS repos; see the separate corpus-selection doc for the 12 candidates chosen to reach
   that with margin.

## Explicitly not touched, and why

- **`src/repo/graph.ts`'s tsconfig-root-only requirement** - not expanded to admit tsconfig-less JS, per
  the spec's explicit instruction. Reported as a generalization limitation, not patched around.
- **Historical CI evidence collection** - not activated for this batch (see above); would need a GitHub
  token to be worth the rate-limit risk against ~500 real commits.
- **The full ~2,000-delta orchestrator** - out of scope for this batch by design; the medium batch is
  the gate before it, not a preview of its final shape.
