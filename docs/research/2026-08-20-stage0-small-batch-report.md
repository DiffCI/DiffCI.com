# Stage 0 small batch — report (2026-08-20)

Ran 4 repositories (`pmndrs/zustand` from the earlier cloud-validation run, plus `pmndrs/jotai`,
`unjs/h3`, `unjs/ofetch` for this batch) through the deployed `diffci-research-sandbox` Worker, 2-3
commits each, 11 unique deltas total. Repos were the next TS/JS entries in `corpus.json` order not
already covered by the 2026-08-19 pilot (which used zustand+hono) — a stated rule, not a
result-dependent pick, per the research integrity requirement.

## Checklist (per the Stage 0 spec's small-batch gate)

- **Budget estimates**: measured Cloudflare spend $0 (nothing beyond the free tier touched by 4 short
  runs); real wall-clock across all cold+warm passes ≈ 42.2s total, which at published Container rates
  (architecture doc §1) is a small fraction of a cent. Consistent with the cloud-validation estimate.
- **No cache contamination**: verified two ways. Structurally, every `/v1/validate` call spins up a
  fresh container (`sleepAfter`/`destroy()` between calls) keyed by `validate-${owner}-${name}`, so nothing
  can carry over between repos by construction. Empirically, a direct D1 query
  (`SELECT repository, COUNT(*), SUM(fallback) ... GROUP BY repository`) shows exactly 4 distinct
  repositories with delta counts matching each run's own report (jotai 3, zustand 2, h3 3, ofetch 3 =
  11, matching D1's own `last_row_id`) and no duplicate `logical_delta_key`s.
- **Cloudflare stability**: 3 of 4 repository runs succeeded on the first request. `unjs/h3`'s first
  attempt failed with `"The sandbox container stopped while the operation was pending"` — a real,
  recorded reliability event, most likely a `max_instances: 1` container-lifecycle race right after the
  prior repo's container finished tearing down. A retry ~1 minute later succeeded cleanly. **This is a
  genuine finding for the orchestrator design**: the per-repository Workflow/dispatch logic for the
  medium/full batches needs built-in retry-on-transient-container-failure, not just fail-and-move-on.
- **GitHub rate limits**: not exercised - `git clone`/`fetch` uses the git protocol, not the REST API,
  so it isn't subject to the 60/hour unauthenticated cap. Historical CI evidence collection (the part
  that *would* hit that cap) stayed off for this batch, consistent with the cloud-validation run - see
  "Open gaps" below.
- **Evidence persistence**: independently verified via direct D1 query and `wrangler r2 object get`
  pulling all 4 repos' real evidence back (not just trusting each run's own HTTP response).
- **Historical CI collection**: still not exercised live (see "Open gaps").
- **Result correctness**: real, distinct, sane per-repo results - see below.

## Real aggregate (via the actual `buildStage0Report` aggregator, not hand-computed)

| Metric | Value |
|---|---|
| Repositories analyzed | 4 |
| Unique commit deltas | 11 (0 duplicates) |
| Fallback rate | 36.4% (5 FULL / 6 SELECTIVE) |
| Median task reduction vs FULL | 14.3% |
| Median test reduction (DiffCI) | 34.3% |
| Median test reduction (PATH) | 0.0% |
| **DiffCI incremental test advantage over PATH** | **0.0%** |
| Unsafe misses | 0 (no historical evidence to check against, though) |
| Proceed to Stage 1 | STOP (correctly - well below the 10-repo/500-delta floor) |

**Report this plainly, not spun**: the median incremental test advantage over PATH came out to 0.0% in
this batch, versus 16.3% in the 2026-08-19 pilot (zustand+hono, 16 deltas). At only 11 deltas across 4
repos, this is consistent with small-sample noise in either direction, not a reversal of the pilot's
finding - but per the research-integrity rule, it's reported exactly as measured, not smoothed toward
the earlier number. The medium and full batches are what will actually settle whether the incremental
advantage holds up at scale; a small batch this size was never going to be statistically conclusive on
its own, and the spec doesn't ask it to be - it asks it to validate the *pipeline*, which it did.

## Per-repository detail

| Repository | Deltas | Fallback rate | Notes |
|---|---|---|---|
| pmndrs/zustand | 2 | 50% | From the cloud-validation run; 1 FULL (workflow file changed), 1 SELECTIVE (README-only, 0/13 tests selected) |
| pmndrs/jotai | 3 | 66.7% | 2 FULL, 1 SELECTIVE |
| unjs/h3 | 3 | 0% | All 3 SELECTIVE - best-performing repo this batch (median reduction highest) |
| unjs/ofetch | 3 | 33.3% | 1 FULL, 2 SELECTIVE |

All graph confidence `COMPLETE` across all 11 deltas - no `PARTIAL`/`UNSAFE` results in this batch, no
fallback caused by graph-quality issues (every fallback was a legitimate config/workflow-change trigger,
not a graph failure).

## Open gaps carried forward (unchanged from the cloud-validation report)

- Historical CI evidence collection remains unexercised live - would need a GitHub token to be useful
  at any real scale given the 60/hour unauthenticated cap.
- Cross-container-instance resumability (the D1-backed index checked *before* a container starts
  analyzing, for the real 20-repo/2000-delta orchestrator) is still not built - each validation call
  today is a self-contained, single-repository unit. That's the next real piece of engineering, not
  this batch's job.
- The container-lifecycle transient failure found here should get a retry policy before the medium
  batch, so a single race condition can't silently drop a repository from the corpus.

## Addendum: retry policy added, and a second real finding surfaced while smoke-testing it

Added an automated retry policy for the transient container-lifecycle failure above (see
`src/research/cloudflare/retry.ts` - narrowly matches container-lifecycle error phrasings only, never
retries a real application-level failure; retries the whole per-repository attempt against a fresh
container session, not an individual command, since the warm pass's resumability proof requires the
same session as cold). 10 new unit tests, redeployed, health-checked.

Smoke-testing the redeployed Worker against `lukeed/kleur` (a plain-JavaScript corpus entry, no
TypeScript) surfaced a **second, unrelated, real correctness gap**: DiffCI's graph builder requires a
`tsconfig.json` to run at all - `kleur` has none, so both sampled commits failed outright
(`"No tsconfig.json found in /workspace/repos/lukeed--kleur"`), producing **zero records and zero
fallback** rather than either an explicit exclusion or a safe FULL-fallback. This is exactly the
"repository cannot be analyzed safely -> exclude it with the exact reason" case the Stage 0 spec calls
for, and today it silently isn't handled that way - the repo just returns 0 analyzed commits with the
real reason buried in `errors[]` in the R2 evidence, not surfaced in the API response or treated as an
exclusion. Several other corpus entries are `primaryLanguage: "javascript"`
(`kleur`, `express`, `fastify`, `axios`) and may hit the same gap depending on whether each has a
`tsconfig.json` for tooling purposes even without being TypeScript proper - not yet checked across all
of them. Not fixed in this pass (out of scope for the retry-policy ask that prompted this smoke test) -
flagged here so it isn't rediscovered expensively during the medium/full batch.

## GO / NO-GO

**GO to continue small-scale validation or begin building the retry-hardened orchestrator; NOT yet GO
for the medium batch (≈2-3x this size) without addressing the container-retry gap first.** Everything
the small-batch checklist asked for was confirmed except historical CI evidence (still gated on a
token) and cross-instance resumability (still gated on the orchestrator, which doesn't exist yet). The
one reliability finding (transient container failure) is exactly the kind of thing this stage exists to
surface before it costs real budget at 20-repo scale.
