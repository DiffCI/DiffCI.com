# Vue adapter overhead experiment — 2026-09-12

This experiment targets observer overhead while preserving selection decisions. It compares `0.1.6-candidate.1` with the previously qualified `0.1.5-candidate.3` on the same eight commits in each of six repositories. It does not activate production, add a daemon or persistent graph cache, or measure new end-to-end test savings.

## Measured bottleneck

A Cloudflare profile of Reka's first fixed commit examined 598 Vue components and recorded 126 imported-type reads and 233 registration scans per observation. Three fresh observer processes recorded:

| Adapter step | Range across three observations |
|---|---:|
| Compiler loading | 63–66 ms |
| Source reads | 19–21 ms |
| SFC parsing | 366–416 ms |
| Script compilation | 500–553 ms |
| Template compilation | 289–310 ms |
| Registration scanning | 148–182 ms |
| Imported-type cache invalidation | 2–3 ms |

Compilation and parsing dominate this adapter, not source-file reads. Its workload also differs from Go metadata discovery; the raw adapter times are not a comparison of equivalent work.

The profile adds `result.graph.adapterMetrics.vue` with per-stage durations and work counts. These are nested details of the graph's adapter phase, not extra durations to add to total overhead. The first profiling upload failed Cloudflare typechecking because of template narrowing in the timing callback; it produced no performance evidence. The corrected profile passed checks before collecting these observations.

## Change

Vue's pinned compiler generates source maps by default during SFC parsing, script compilation and template compilation. DiffCI consumes code, binding metadata, dependencies and errors, but not these source maps. The candidate disables map generation at those three entry points.

The candidate also scans Options API registrations only when compiled template code contains a runtime component-resolution call. It preserves the existing matching logic and always checks dynamic components and directives. Compiler type-cache invalidation, inventory breadth, import resolution and fallback guards remain intact. Adapter version advances to 5 and graph cache schema to `3-adapters-7`.

Roughly 5–23 ms decision/planning times from the previous run do not mean Reka is supported selectively. Reka still has component/type-analysis and test-discovery blockers and retains full CI. Reducing its overhead lowers the cost of reaching that fallback.

## Matched protocol

Each of 48 unchanged commit/parent pairs gets two fresh-process old/new observation pairs. The first engine order alternates by commit; the second pair reverses the first. Both engines run against the same installed checkout. The harness compares the complete observation result except performance metrics, including selected tests, commands, fallback reasons, risk signals, path-rule baseline and graph node/edge counts and confidence. It also checks worktree non-interference.

The eight original commits are retained even if their historical test runs failed. This experiment measures observer behavior only: target suites and fault injections are not repeated. Candidate regression, adapter and compiler-output tests do run on Cloudflare. Previous test economics remain evidence about the previous candidate; faster observation alone is not a new net-savings measurement.

Results use medians and nearest-rank p95. With only 16 observations per engine per repository, p95 is the sample maximum; it is an outlier-sensitive descriptive statistic, not a reliable production tail estimate. First-pair and second-pair medians are reported separately. OS and tool caches are not flushed, so neither group is labeled a controlled cold/warm experiment. Every observation has a fresh process; there is no persistent DiffCI daemon or graph cache here.

## Results

| Repository | Baseline median ms | Candidate median ms | Median reduction | Baseline p95 ms | Candidate p95 ms | Faster pairs / 16 |
|---|---:|---:|---:|---:|---:|---:|
| reka-ui | 4708 | 3951.5 | 16.1% | 5538 | 5585 | 13 |
| vue-test-utils | 1693.5 | 1525 | 9.9% | 2555 | 2616 | 9 |
| vue-router | 1137.5 | 1145 | -0.7% | 1685 | 1687 | 7 |
| chi | 844 | 824 | 2.4% | 1484 | 1337 | 7 |
| cobra | 1583 | 1537.5 | 2.9% | 2655 | 2710 | 7 |
| validator | 1251 | 1206 | 3.6% | 3376 | 1910 | 10 |

| Repository | First-pair old → new median ms | Second-pair old → new median ms | Median paired reduction ms |
|---|---:|---:|---:|
| reka-ui | 4938.5 → 3982.5 | 4582 → 3892 | 317 |
| vue-test-utils | 1972.5 → 1791 | 1616.5 → 1478 | 145.5 |
| vue-router | 1360.5 → 1355 | 1100 → 1126 | -27.5 |
| chi | 1062 → 917 | 841 → 819 | -6 |
| cobra | 1868.5 → 1810.5 | 1405 → 1478 | -59 |
| validator | 1254 → 1342.5 | 1222 → 1120 | 74 |

Reka's median total overhead fell 16.1%, and median adapter time fell 30.6% (2,411 to 1,673 ms). Thirteen of sixteen pairs were faster. The median of paired reductions is 317 ms; the difference between the two distribution medians is 756.5 ms. These are different statistics and should not be substituted for one another. Test Utils' median fell 9.9%, with nine of sixteen faster pairs and adapter time falling from 304 to 219 ms.

Neither Vue workload showed an improved p95 in this sample. Router has no active SFC adapter in its scoped suite and showed essentially unchanged timing. Go outcomes are small and mixed: Chi and Cobra have lower marginal medians but negative median paired reductions. There is no consistent startup or Go-adapter optimization demonstrated here.

Compare engines within this matched run. Absolute times differ from earlier sessions because container/cache/load conditions differ: for example this run's old Reka median is 4.71 s, versus 3.71 s in the previous session. The source/artifact comparator is verified; a cross-session subtraction would confound the code change with those conditions.

The candidate still inventories all 598 Reka components and records 126 imported-type reads. Registration scans fall from 233 in the profiling run to 150 in every candidate observation. Its remaining median Vue costs include 727 ms script compilation, 361 ms template compilation, 290 ms SFC parsing and 147 ms registration scanning. These substep timings come from the current candidate distribution; they are not a matched substep comparison against the earlier three-run profile. Reka's graph phase is 2,867 ms, including 571 ms import resolution and 458 ms TypeScript program work; pre-observation process time is 573.5 ms. Nested and independently computed medians must not be summed.

This is a measured median overhead improvement with preserved decisions, not a new net-CI-savings result. Reka and Test Utils still retain full CI. The experiment has not reached sub-500 ms warm overhead and does not justify a claim that DiffCI accelerates every observed job. The existing break-even formula remains full execution minus selected execution minus complete observer process time. No target execution timings were collected here, so there is no new measured value for that formula.

## Evidence and validation

- Candidate source commit: `cd8798e`.
- Cloudflare source object: `sources/reka-overhead-20260912-v1.tgz`.
- Source SHA256: `522de8089364886cbff4b9583e3584f11734e7e016f94256340eedd0e0ff947b`.
- Baseline source commit: `3ed4282`; archive SHA256 `211bf7f0e7970edff38feb3588c861db6f5fd3c8076f3808935a0ee0dbdd2950`.
- Verified baseline artifact: `sha512-WjYw9iWQftlMelT3XKVASr5qYC/FXVj4JCoWdoFf3eOrBljmyGpdzqICwfcYm11YGhwv2qJy1jr8AW3Qh3hQVg==`.
- Profile source commit: `2c3109f`, source object `sources/reka-adapter-profile-20260912-v2.tgz`, SHA256 `136e6fef8daaee783e3552712122b571b5b4bfc0b34866638a9303af4ec6a97e`.
- Comparison run IDs: `reka-overhead-20260912-{reka-ui,vue-test-utils,vue-router,chi,cobra,validator}-v1`.
- Raw reports, execution receipts, logs, aggregation script and CSV are in `.diffci/reka-overhead-20260912/` in the original workspace.

All builds, tests, profiling and target-repository observations run in Cloudflare's `docker.io/cloudflare/sandbox:0.12.5` image. Target observations run as UID/GID 1000. Desktop work is source editing/packaging, orchestration and aggregation of downloaded JSON only.

The candidate artifact is `sha512-elBxpjaEiYlfj3ZJsQ14cKbS+cO/Fui5/EX8/I4/erKqa8eNm8uBSsE86aczZ+A4J9bBjUWdur0XpzrOerb68A==`, identical across all six comparison jobs. All 48 original head/base pairs matched, all 96 paired comparisons preserved complete decision details and all 192 observations preserved worktrees.

Cloudflare validation passed typechecking, 2,152 full regression tests (zero failed, five skipped), 23 focused adapter/scope/economics tests in Go-enabled jobs (zero failed or skipped), and 74 non-root control-plane tests (zero failed, three skipped). Vue-only jobs passed 21 focused tests with two native-Go skips. The new compiler-output comparison covers script setup, Options API registrations, template assets, dynamic components, directives and repeated analyses; existing imported-type refresh and unsafe-scope tests remain in the suite.

The six comparison containers and both profiling containers were released after evidence preservation. The candidate remains unpromoted. [All 96 paired observation rows](2026-09-12-reka-overhead-observations.csv) retain commit IDs, execution order, total/startup/graph/adapter timings and decision-equivalence results.

A useful follow-up is a separate startup/warm-state experiment with explicit process and cache lifetimes, measuring invalidation safety as well as speed. Production tail-latency claims need more samples. Persistent graph caching or a daemon should not inherit this experiment's qualification automatically.
