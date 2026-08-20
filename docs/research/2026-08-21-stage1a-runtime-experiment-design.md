# Stage 1A — Phase 10: Stage 1B runtime-experiment design (design only, not launched)

Stage 0 never measured real CI wall-clock time - only test *counts*. This design specifies exactly how
Stage 1B would measure whether test-count reduction actually translates into CI time savings, without
launching it.

## What must be measured, on identical deltas

For a stratified sample of Stage 0 deltas (deliberately including both `DISCRIMINATIVE_OPPORTUNITY` and
`MANDATORY_FALLBACK`/`BASELINE_ALREADY_OPTIMAL` cases - the runtime picture matters for the whole
distribution, not just the favorable cases), run three conditions on the exact same checked-out commit:

1. **FULL** - the repository's real full test suite.
2. **PATH** - PATH-baseline-selected tests only.
3. **DiffCI** - DiffCI-selected tests only.

For each, measure separately (not just "total time"):
- **Wall-clock test-execution time** - the actual dominant, real-world metric.
- **CPU time**, where the runner exposes it - distinguishes genuine parallelism gains from wall-clock
  noise.
- **Startup/setup time** - test-runner boot, environment setup - this is often a FIXED cost independent
  of how many tests run, and matters enormously for whether "run fewer tests" translates to
  proportionally less time (a 5-test run and a 50-test run can have similar total time if setup
  dominates).
- **Dependency-installation/cache-warm effects** - `npm ci`/`pnpm install` time is identical regardless
  of which condition is being tested (not a DiffCI-vs-PATH-vs-FULL variable) but must be held constant
  and reported, since it's a real part of total CI-equivalent duration a customer experiences.
- **DiffCI's own analysis overhead** - already measured in Stage 0 (median 1.4s, p95 5.4s) - must be
  added back on top of DiffCI's selected-test execution time to get a fair total-duration comparison,
  not left out as if DiffCI's decision were free.
- **Total CI-equivalent duration** = setup + (DiffCI overhead, DiffCI condition only) + selected-test
  execution time. This is the number that answers the actual product question.

## Noise control

Test-execution wall-clock time on shared CI infrastructure is noisy (neighbor contention, cache state,
network variance for any live-dependency tests). Each condition should be run **multiple times** (a
concrete, practical starting point: 3 repetitions per condition per delta, escalating to more only for
deltas where the 3 runs disagree by more than a reasonable threshold) and reported as median with a
visible spread (min/max or IQR), not a single noisy sample - directly informed by this investigation's
own experience with flaky/environment-dependent test failures (Phase 4).

## Cache control

Explicitly decide and hold constant per condition:
- Dependency cache: either always cold (most conservative, most representative of a fresh CI run, but
  slowest and most expensive) or always warm with an identical pre-populated cache shared across all
  three conditions for a given delta (faster, cheaper, but must verify the cache is genuinely identical
  across conditions to avoid a hidden confound).
- Graph cache (DiffCI's own `GraphCache`): should be COLD for the DiffCI condition's overhead
  measurement in at least one pass (representative of a real first-time PR check) and additionally WARM
  in a second pass (representative of subsequent pushes to the same PR/branch) - Stage 0 already
  distinguishes cold/warm overhead; Stage 1B's runtime measurement should too.

## Where to run: real production CI infrastructure, not Cloudflare Containers

Stage 0's Cloudflare Sandbox execution was appropriate for *analysis* (graph construction, test
selection) - a pure compute task with no real notion of "CI environment realism." Actual test
*execution* timing is a different problem: what matters is realistic CI-runner characteristics (shared
resource contention, real dependency-install network conditions, real test-runner startup cost) that
customers actually experience. **GitHub Actions runners are the right choice for experimental validity**,
not Cloudflare Containers - they are the environment DiffCI's real customers actually run in, and using
anything else would measure a different (and less relevant) thing, purely for implementation
convenience. This is a deliberate validity-over-convenience choice, exactly as the task instructed.

## Sample size and stratification

Not every one of Stage 0's 2,000 deltas needs to be re-run for wall-clock measurement (test execution is
far more expensive than the graph analysis Stage 0 already performed). A stratified sample should
cover: multiple repositories across the size/opportunity-frequency spectrum Phase 7 characterized,
enough `DISCRIMINATIVE_OPPORTUNITY` deltas to get a real distribution of the conditional-reduction
scenarios Stage 0 found (median 95%, but p25 was only 34%), and enough `MANDATORY_FALLBACK` deltas to
confirm FULL-equivalent conditions don't show a spurious "DiffCI is faster" artifact from the DiffCI
condition's own overhead being small relative to noise.

## The metric that should replace test-count reduction as Stage 1B's headline number

**Net CI time saved vs PATH after DiffCI's own overhead** - not raw test-count reduction, and not
DiffCI-vs-FULL (PATH is the real competing baseline DiffCI needs to beat, as Stage 0 already
established). This design intentionally does not predict what this number will be - that would repeat
exactly the extrapolation error Phase 9 explicitly avoided.
