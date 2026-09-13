# Vue analysis cache experiment — 2026-09-13

This candidate caches the expensive Vue contribution to dependency-graph construction. It does not cache final selections or reuse an entire serialized graph. TypeScript dependency resolution, graph construction, impact analysis, command planning and full-suite safeguards still run on every observation.

## Implementation and invalidation

Caching is opt-in through `--vue-analysis-cache /external/path`. Without the flag, existing behavior is unchanged. Cache paths inside the checkout, including aliases through existing symlinks, fall back to uncached analysis without writing there. Cache reads, content hashing, validation and writes are counted in the observer process duration.

An entry is scoped to observer version, adapter version, physical repository root, Node/runtime and configuration fingerprint, the scoped file inventory, and component content. Compiler filesystem reads and existence probes are recorded and revalidated, including absent paths and imported macro types. The graph resolver still examines imports afresh, so an ordinary TypeScript implementation edit does not require recompiling unchanged Vue components. Adding/removing files or changing configuration invalidates conservatively. Cache entries have payload checksums and atomic replacement; inaccessible, stale or unreadable entries are misses. Storage is trusted runner-local data, not an authenticated artifact from arbitrary contributors.

This experiment reuses files on the Cloudflare runner's filesystem. It includes those cache read/validation/write costs. It does **not** measure cross-job R2 transfer, cache artifact packaging, or reuse at different checkout paths. The implementation binds entries to a physical checkout path and stores the latest entry per component; there is no daemon or remote cache service.

## Frozen comparison

Use the same eight eligible source commits per repository as the previous held-out cohort, oldest first. Six repositories yield 48 cases. No commit is replaced after failure.

Each commit has two fresh-process measurements for each of four arms:

- **Uncached:** the same candidate with caching disabled.
- **Cold:** a unique empty cache directory per commit and repetition.
- **Warm:** reuse the cache populated by the immediately preceding cold observation.
- **Incremental:** an independent persistent directory per repetition, carried across chronological commits. The first commit starts empty.

The uncached comparator goes first or last in alternating repetitions/commits; cold always precedes warm by necessity. OS/tool caches are not flushed. Cached and uncached status, reasons, result details, graph counts/confidence and proposed commands must match exactly. Observation non-interference and head/base identities are checked on every arm.

Full and selected test commands execute in both orders, with the same measured test work reused across observer arms. Identical full policies share full work, so repeat-run noise cannot become fictitious test savings. Net saving for each arm is `full execution − selected execution − that arm's observer process time`. Cold and incremental results are reported separately from best-case same-checkout warm reuse. Failed/unreadable/unstable test cases remain visible and do not enter stable net totals. Existing fault-injection cases are retained with selection frozen before injection.

All builds and tests execute on Cloudflare. Desktop work is restricted to editing/archiving source, orchestration, and aggregation of downloaded evidence.

## Results

**The cache reduces Vue analysis overhead substantially, but the candidate does not pass the net-savings promotion gate.** All 384 observations across 48 commits preserve identical decisions across cache modes and repetitions. Of 44 cases with stable test executions, only four Validator commits save time in both repetitions. No repository has positive aggregate net savings in both repetitions.

### Vue observer overhead

Each cell below is median / nearest-rank p95 process time in milliseconds, over 16 observations per arm. Timings include startup and cache I/O. These are descriptive paired observations, not confidence intervals.

| Repository | Uncached | Empty cache | Same-commit warm | Previous-commit reuse |
| --- | ---: | ---: | ---: | ---: |
| Reka UI | 3,054 / 4,485 | 3,476.5 / 4,108 | 1,775.5 / 2,082 | 1,908 / 3,399 |
| Vue Test Utils | 1,262 / 1,695 | 1,312.5 / 1,455 | 1,073 / 1,198 | 1,260 / 1,445 |

Reka's warm median is **41.9% lower**, and its incremental median is **37.5% lower**, than uncached analysis. Warm observations are faster in 16/16 pairs; incremental observations in 15/16. Its Vue adapter median falls from **1,298.2 ms to 76.0 ms warm** and **196.0 ms incremental**. This preserves every full-suite fallback and selection decision.

Cold caches have a real cost: Reka's median is **13.8% higher** than uncached, and Test Utils' median is **4.0% higher**. The cold run includes writing the cache. Same-commit warm timing is not a free substitute for that cost on a new runner.

Reka records 9,568/9,568 warm hits. Its incremental runs hit 8,350/9,568 lookups (**87.3%**, including both initially empty caches); after the first commit, 8,350/8,372 lookups hit (**99.7%**). Only 22 component analyses are repeated across the subsequent seven commits and both repetitions. No cache write failures were observed.

### End-to-end economics

Net values below sum the same 44 stable cases in each repetition, using that arm's observer cost and matched full/selected test work. Positive means time saved versus plain full CI; negative means added time. Four cases are excluded because tests failed, not because their timings were unfavorable.

| Arm | Net, repetition 1 | Net, repetition 2 |
| --- | ---: | ---: |
| Uncached | +23.154 s | −55.397 s |
| Empty cache | +25.471 s | −59.081 s |
| Same-commit warm | +37.294 s | −47.392 s |
| Previous-commit reuse | +35.272 s | −49.341 s |

The first repetition's large gains on some Go commits do not survive reverse-order execution. Those repositories have no Vue cache hits. Differences between their cache-labeled observer arms are timing variation, not cache benefits. This paired design does not reset OS or tool/compiler caches between test executions; the divergent totals are a reason to reject a robust net-savings claim, not select the favorable repetition. Adding the two warm totals still yields **10.098 seconds extra time** across the 88 stable executions.

| Repository | Stable cases / 8 | Warm net, repetition 1 / 2 | Positive net in both |
| --- | ---: | ---: | ---: |
| Reka UI | 6 | −10.975 / −11.215 s | 0 |
| Vue Test Utils | 8 | −8.646 / −8.657 s | 0 |
| Vue Router | 8 | −5.375 / −9.145 s | 0 |
| Chi | 6 | +13.035 / −4.726 s | 0 |
| Cobra | 8 | +22.228 / −12.791 s | 0 |
| Validator | 8 | +27.027 / −0.858 s | 4 |

For the two repositories that actually use the Vue cache, warm observation reduces the observer cost by **10.691 / 8.682 seconds** across their stable cases compared with uncached observation. That improvement is real within this paired experiment, but their policies still execute the full suite. Router's measured scope has no Vue component cache work; its earlier two small positive-net cases did not repeat here.

See the [384-observation CSV](2026-09-13-vue-cache-cases.csv) for per-commit timing, net cost, cache hits/misses and normalized full-suite fallback reasons. All detailed reasons remain in the raw reports.

Test Utils demonstrates why same-commit warm reuse must be separated from incremental reuse: all 644 warm component lookups hit, but only 82 of 644 incremental lookups hit (12.7%). Its configuration fingerprint changes on six of seven chronological transitions; the unchanged transition reuses all 41 components. Warm adapter median drops from 210.7 ms to 6.1 ms, but incremental adapter median remains 213.1 ms. Its full-suite policy remains necessary because of unsupported scoped configuration/plugin/setup patterns, runtime component resolution and unresolved/out-of-scope implementation dependencies.

## Evidence

- Candidate: `0.1.7-candidate.1`; source commit `19111d7`.
- Source object: `sources/vue-cache-20260913-v1.tgz`.
- Source SHA256: `0638112f26f990aba480eb736ce48d2c8504ca639b64b0b35a6d857bd7941670`.
- Run IDs: `vue-cache-20260913-{reka-ui,vue-test-utils,vue-router,chi,cobra,validator}-v1`.
- Raw reports, receipts, logs and audit: `.diffci/vue-cache-20260913/` in the original workspace.

All six source receipts match the frozen source hash, and all six packaged observers have the same integrity:

`sha512-2mSPkqZ2nNS3ZGRvxjkaCbryfqnHdf2eyJr0jd3jP3yoTWI0e+NdvLkG2eDEU5byhu00gIJ6u6U6mAPRhiFzUQ==`

The audit checks the previous cohort's exact head/base identities, non-interference, identical decisions across all eight observations per commit, positive/readable test outcomes and stable selected-test counts for admitted cases, and the net-time arithmetic. All repository workloads ran as UID/GID 1000 on Cloudflare. All six containers were released; confirmations are in `container-release.json`.

Cloudflare typechecks and all benchmark preflight checks passed. The full regression suite passed **2,156 tests with zero failures and five skips**. The new cache test exercises graph equality through reuse, source/import/type changes, missing-file creation, configuration changes, corrupt data, deletion, unavailable storage and in-checkout/symlink cache paths. The validation/control-plane suite passed **77 tests with three skips**. These suites overlap; counts are not additive unique coverage.

**17 fault injections were detected by both the full and chosen command policies.** Their selections were frozen before mutation; cache invalidation itself is exercised separately by the new tests. Reka's console-only fault labels were initially inconclusive because Vitest writes failure messages to its JSON reporter; the existing collector recovered those messages and verified the injection markers before classifying them as detected.

Four cases are excluded from stable net totals: Reka indices 5 and 6 fail the full-suite Tree snapshot; Chi index 3 fails the baseline and index 5 has an unstable execution, both involving `TestThrottleCustomStatusCode`. Their observer comparisons still pass. No failing commit was replaced.

Reka's unchanged full-suite reasons include unproven component analysis, runtime component/directive resolution and an unestablished declared test inventory. Caching makes these decisions cheaper; it does not resolve those modeling gaps. The next selection-quality investigation should establish the actual scoped Vitest inventory and explain the component-analysis failures before relaxing any full-suite guard.

**Not promoted:** the predeclared gate requires positive aggregate net savings in both repetitions, and it failed. The opt-in implementation and evidence are retained on the candidate branch; production is unchanged.