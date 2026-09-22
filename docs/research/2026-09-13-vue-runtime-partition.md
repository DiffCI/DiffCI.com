# Vue runtime test protection — 2026-09-13

The previous Reka candidate found all 62 test files and repaired macro analysis, but eleven runtime component/directive blockers still forced full execution. This experiment changes the test-selection policy: tests that can reach an unresolved runtime component always run, regardless of which source changed. Other tests remain eligible for ordinary static dependency selection.

## Safety contract

This does not claim to resolve arbitrary runtime dependencies. It conservatively protects every test-file root whose static dependency closure reaches a runtime-blocked component. Those files are unioned into every impact result with `ALWAYS_RUN_POLICY`, including when the caller supplies a separately discovered repository profile. The dependency-graph profile retains the protection and the graph cache schema is invalidated.

Partitioning requires an explicit Vue package scope, a verified complete test inventory, and parsed test/setup/configuration roots. Shared setup/configuration reaching any runtime blocker retains full-suite fallback. Compilation errors, unresolved imports, package-boundary violations, unsupported frameworks and other global blockers remain full-suite safeguards. Existing change-specific safeguards also remain active.

Only a literal, unambiguous Vitest test configuration with a supported isolated execution environment permits partitioning. Disabled or nonliteral isolation, custom runners, browser configuration, pool overrides, custom environments and duplicate test definitions cannot establish the contract. Vitest documents isolation as enabled by default; disabling it allows test files to share an environment. [Vitest isolation documentation](https://vitest.dev/config/isolate).

This qualification concerns the declared isolated unit-test job. It does not establish safety for order-dependent suites, other CI jobs, or executions that override the verified configuration. Runtime uncertainty in shared setup requires full execution rather than test-file partitioning.

## Validation design

All builds and tests run on Cloudflare. Local work only edits/archives source, orchestrates jobs and aggregates returned evidence.

- Regression fixtures verify that an unrelated source change retains runtime-dependent tests while excluding unrelated static tests.
- Negative fixtures retain fallback for disabled/ambiguous isolation and shared setup; a caller cannot lose graph-level protection by rediscovering a profile.
- An executable synthetic Vitest contract uses three test files. A source change selects its static test plus a runtime-dependent test. Full and selected execution must pass, then both must detect a fault injected into the runtime component after selection is frozen. This specifically exercises protection outside the static source-change closure.
- That synthetic contract invokes Vitest directly with the computed selection. Its npm-installed fixture retains the expected scoped-command refusal because production scope routing requires pnpm. It validates the selection invariant, not command routing for npm. The real Reka cases separately exercise accepted pnpm scope routing and actual selected-file execution.
- The Reka cohort remains the same eight held-out commits, oldest first. Every inventory is checked against an independent full Vitest run. Full/selected execution is measured in both orders, and normal cohort fault cases remain at indices 0, 3 and 7. Failed baselines remain visible and do not enter stable economics.
- The broad comparison uses two uncached observations per commit, with each repetition's own process cost deducted. The previous candidate's cache arm was slower, so cache optimization is not mixed into this experiment.
- To stay within Cloudflare's per-run time budget, final cohort assignment is indices 0–3 on `reka-runtime-20260913-qualified` and indices 4–7 on `reka-runtime-20260913-second-half`. This split was fixed before second-half outcomes were observed. Any unassigned work from the first run is excluded by index, not by result. Both halves pin the same observer artifact and frozen commits; there is no persistent cache to transfer. OS/tool caches remain local to each container.

## Source and runs

Final source commit: `3ae730f`; candidate `0.1.9-candidate.3`; Cloudflare run `reka-runtime-20260913-qualified`; source object `sources/reka-runtime-20260913-qualified.tgz`; SHA-256 `df9f304e93b4e06a3146fab79338b7e73698dd49f001fce0294baf10c502a2c3`.

Pinned artifact integrity: `sha512-VJbqnOqITLIiewyg7LfR7hdTt4NuJURoINWEtoYiSGGQgSawoVUVUP9oDupCEz9w6/2J5bdiuSyQF+7pS3WCSw==`. This analyzer passed type checking, 27 focused tests with two skips, cache tests, and the full regression suite (2,162 passed, five skipped) before the final harness-only repair.

Second-half harness source: `2d58938`, object `sources/reka-runtime-20260913-second-half.tgz`, SHA-256 `d039a6c6242f71e202a851708746daee055da6204402126f95507a22f154b7a5`. It adds the start-index option and changes no analyzer code.

The preliminary `0.1.9-candidate.1` probe selected and executed 17/62 files and measured +33.133 / +33.297 seconds net after cached observation overhead, with both normal execution orders passing. Full execution took 69.257 / 69.614 seconds and selected execution 27.610 / 27.026 seconds. All 17 selected files were protected runtime tests. Its injected fault was detected by both full and selected execution. This is diagnostic evidence, not the final cohort result.

The intermediate `reka-runtime-20260913-final` run was cancelled and released before qualification to add the duplicate-configuration guard. The subsequent `reka-runtime-20260913-final-v3` attempt was stopped and released after the synthetic fixture correctly hit the package-boundary guard: its node_modules symlink pointed outside its own repository. The repaired fixture installs pinned Vitest 2.1.9, Vue 3.5.13, plugin-vue 5.1.4, Vite 5.4.16 and jsdom 25.0.1 inside its own root. No boundary guard was relaxed. Interrupted runs are preserved separately and excluded from benchmark totals.

The assigned first-half timing cases completed before that container was stopped. Cancellation preserved their timing JSON but bypassed the normal collector's enrichment of Vitest failure messages, leaving their original fault verdicts inconclusive. Dedicated, normally completed fault supplements repeat indices 0 and 3 with the same pinned analyzer and frozen selections, require a green full baseline, and preserve both full and selected failure traces. Their timings do not enter the savings totals. The original timing reports are not rewritten to claim fault detection.

Fault supplement sources: `353e4f2` / `sources/reka-runtime-20260913-fault-0.tgz` / SHA-256 `43101ee541be1aa1047c80bb19ad533d74142a9c379e5b832b98a1cae942ab24`, and `f83cbfe` / `sources/reka-runtime-20260913-fault-3.tgz` / SHA-256 `33bcbf6b0369bba7bb78a09166f4708b033acb4654d72d80a2eaf5bdcb34d740`.

## Timing results

**The same Reka cohort now shows positive aggregate net savings in both execution orders.** Five commits run selective subsets and save time in both repetitions. One stable commit retains full execution and adds observer overhead. Two commits repeat the existing Tree snapshot failure and are excluded from stable economics; they are not replaced.

| Across six stable commits | Repetition 1 | Repetition 2 |
| --- | ---: | ---: |
| Full test execution | 511.582 s | 519.800 s |
| Policy test execution | 282.059 s | 282.347 s |
| Observer process overhead | 57.210 s | 54.844 s |
| Net time saved | **172.313 s** | **182.609 s** |
| Net saving / full test time | **33.7%** | **35.1%** |

These timings cover the test-execution stage plus DiffCI's observer process. Dependency installation, candidate building and benchmark qualification checks are outside the timed comparison. This is not a measured percentage reduction for an entire CI pipeline that also performs builds, downloads or deployment.

| Commit | Actual policy files / 62 | Baseline | Net saved, repetitions 1 / 2 |
| --- | ---: | --- | ---: |
| `f950796b` | 17 | Both pass | +44.420 / +51.394 s |
| `b9125cfd` | 19 | Both pass | +32.583 / +32.178 s |
| `e0343918` | 19 | Both pass | +38.869 / +42.274 s |
| `97fd052a` | 30 | Both pass | +30.925 / +30.768 s |
| `7567e33b` | 18 | Both pass | +32.954 / +33.713 s |
| `1593f678` | Not executed selectively | Tree snapshot fails | Excluded |
| `764f0781` | Full policy; baseline fails | Tree snapshot fails | Excluded |
| `c06c994d` | 62 | Both pass | −7.438 / −7.718 s |

Every case discovers and independently executes the same 62-file full inventory. On the five stable selective cases, both actual executed subsets exactly match the planned paths. All 16 uncached observations preserve their decisions between repetitions. Seventeen runtime-dependent tests are protected on every commit. The snapshot-changing last commit still falls back to full execution; the package-boundary fallback also remains on `764f0781`.

Median observer overhead across the 16 observations is **8.501 seconds**, nearest-rank p95 **11.620 seconds**. Analysis is still expensive. The economic improvement comes from safely executing fewer test files, not from making that overhead negligible. These are descriptive observations on a small fixed cohort, not confidence intervals or a claim about every repository.

Combined across the twelve stable executions, full execution takes 1,031.382 seconds and policy execution plus observer overhead takes 676.460 seconds: **354.922 seconds saved (34.4%)**. Both repetitions pass the positive aggregate net-savings gate. This qualifies this scoped experiment; no production promotion was performed.

## Final fault verification and evidence

Both normally collected supplements (indices 0 and 3) report `DETECTED`: the full baseline passes, selection matches the original timing case, and both full and selected executions contain the injected mutation marker after selection is frozen. The index-7 main-run fault is also detected under its full policy. The separate synthetic runtime-protection contract reports `DETECTED`. These checks support the stated contract; they are not exhaustive proof for arbitrary runtime dependencies.

All benchmark containers have been released. The [sixteen observation rows](2026-09-13-vue-runtime-partition-observations.csv) retain failed baselines and the negative full-policy case. Supplemental timings are excluded.

Raw reports are retained in Cloudflare R2 bucket `diffci-validation-env` at `validation/<runId>/language-qualification.json`, and locally under `.diffci/reka-runtime-20260913/<part>/language-qualification.json`. SHA-256 hashes:

| Part | Run ID | Report SHA-256 |
| --- | --- | --- |
| qualified | `reka-runtime-20260913-qualified` | `8a86876e11632fb701cfc50ca5afa0499c6981f320e8bdc9dfd193f2c23e18f4` |
| second-half | `reka-runtime-20260913-second-half` | `2a911bbbb550083718cd5bc80701c70e42b6337c0ae4a58fe136b5e1bd2c8859` |
| fault-0 | `reka-runtime-20260913-fault-0` | `26c405ea3a513dc285e20624e61327f32444687701fbe540ad0d9b8e25ea13fc` |
| fault-3 | `reka-runtime-20260913-fault-3` | `7315fb608a71adc722753ab0b1fd88138178f1b692bef39694a09aee07700109` |
