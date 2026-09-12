# Observer performance qualification — 2026-09-12

Candidate `0.1.5-candidate.3` reduces scoped Vue observer latency while preserving the previous candidate's selection policy. The early economics bypass works in a packaged synthetic fixture. This is a shadow qualification, not production promotion or a general savings claim.

## Changes and measured motivation

Cloudflare profiling of Router found TypeScript program creation took 1.45–2.18 seconds of a 1.60–2.33 second graph build. Validator's graph instead spent 235–505 ms in adapters, mainly Go metadata; its TypeScript program took only 5–8 ms. The optimization therefore targets explicitly scoped Vue programs and preserves Go metadata discovery.

Scoped programs avoid automatic library/type loading and resolve imports with the original compiler options. They parse reachable generated implementations and their transitive imports on demand. Cross-package imports, invalid/unreadable implementations, triple-slash file references and parsing budgets retain full fallback. Required type-test files remain selected. Graph cache schema advances to `3-adapters-6`.

The opt-in history gate runs before engine/graph analysis. It can only retain full CI; it cannot authorize skipping. It requires matching repository, job, configuration fingerprint and exact observer version, fresh history, at least five distinct ancestor commits and stable positive timings. Even the best historical gross saving, with 25% plus 250 ms headroom, must fall below the cheapest historical observer cost. See [the integration guide](../observer-economics.md).

## Reproduction and evidence

- Source commit: `3ed4282`, branch `codex/cloudflare-language-qualification`.
- Source object: `sources/observer-performance-20260912-v3.tgz`.
- Source SHA256: `6f62f3707ae4289e48b47ddc7c696ccdb2e3a6f29187612b5c669190f9db2d53`.
- Candidate integrity: `sha512-WjYw9iWQftlMelT3XKVASr5qYC/FXVj4JCoWdoFf3eOrBljmyGpdzqICwfcYm11YGhwv2qJy1jr8AW3Qh3hQVg==`.
- Baseline: `0.1.4-candidate.4`, rebuilt inside Cloudflare from commit `7f4a272`; source archive SHA256 `25bee38c965ea87bc97406ee59329f3c8769adacf37e5439bb3f15710ba539a0`.
- Verified baseline artifact: `sha512-jCBnEkaz686Pe9Qdzx4EdOXdt02gsOcZUIkTzVgOIyWJMWARmm1px21hqt2jAl3/5BvVTRFLC0gW9hzUGqTg6A==`.
- Cloudflare image: `docker.io/cloudflare/sandbox:0.12.5`, Linux, Node 22.23.2; repository workloads run as UID/GID 1000. Go jobs use pinned Go 1.27.1.
- Run IDs: `performance-20260912-{vue-test-utils,vue-router,reka-ui,chi,cobra,validator}-v3`.
- Raw JSON, logs, execution receipts, aggregation script and per-commit CSV: `.diffci/observer-performance-20260912/` in the original workspace.

All source builds, tests, profiles and repository workloads ran on Cloudflare. Desktop work was limited to editing, source packaging/upload, orchestration and reading/aggregating result JSON. The receipt's bootstrap agent hash differs from the actual candidate: the latter is recorded in `language-qualification.json`.

## Method

The cohort is the same ordered eight real commits and parents in each of six repositories used in [the previous qualification](2026-09-12-vue-scope-qualification.md). Failing historical commits are retained. Each commit gets two fresh-process old/new observer pairs; the first order alternates by commit and the second reverses it. This is not a cold-cache benchmark: caches and container load can affect timings.

Policy mode, selected paths, commands and refusal must match before sharing test measurements between old and new engines. Full/selected tests run in both orders. Net saving is full-test wall time minus selected-test wall time minus the respective engine's **first observer-pair** process cost. Both test repetitions use that first cost; the second observer repetition is retained for latency/noise analysis, not substituted after seeing results. Full fallback still incurs observer cost, so it provides no savings. Observer startup, analysis and process exit are included; provisioning/install/prerequisite builds and CI billing rounding are not. Results are elapsed-time economics, not measured dollar savings.

No history bypass was enabled in the real-repository comparison. This preserves matched policy qualification and prevents hiding unprofitable cases. Mandatory Vue type suites and actual full test inventories are checked. Fault injections remain fixed at indices 0, 3 and 7; Vue outcomes use collected structured Vitest evidence rather than console-only marker detection.

## Results

| Repository | Stable / 8 | Smaller stable suites | Positive net in both runs | Old observer median (ms) | New median (ms) | Median reduction |
|---|---:|---:|---:|---:|---:|---:|
| vue-test-utils | 8 | 0 | 0 | 2451 | 1201.5 | 51% |
| vue-router | 8 | 4 | 0 | 3032 | 1676 | 44.7% |
| reka-ui | 6 | 0 | 0 | 4919 | 3708 | 24.6% |
| chi | 7 | 5 | 0 | 773 | 744.5 | 3.7% |
| cobra | 8 | 0 | 0 | 729 | 718 | 1.5% |
| validator | 8 | 4 | 3 | 1101 | 1125 | -2.2% |

Medians use all 16 complete observer processes per engine per repository, including cases whose upstream tests later failed. Percentages compare those medians; they are not net test savings. The median paired reductions were 1,113.5 ms (Test Utils), 1,362.5 ms (Router), 1,252.5 ms (Reka), 24 ms (Chi), 0.5 ms (Cobra), and -22 ms (Validator). Candidate process ranges were 998-1,969, 1,287-2,256, 3,284-4,489, 691-1,343, 660-1,307, and 890-1,918 ms respectively.

Vue observer latency improved in every one of the 48 paired observations across the three Vue repositories. Router's four smaller suites still failed to save time in both repetitions. Their candidate net pairs were, by index: 0 = +1,415 / −90 ms; 1 = −1,277 / −1,310 ms; 6 = +228 / −1,999 ms; 7 = −24 / −2,548 ms. Avoided test work remains too small or variable relative to process and graph cost. Test Utils and Reka retained full suites.

Router's executed totals fell from 672 to 478 tests at index 0, 671 to 654 at index 1, and 670 to 653 at indices 6 and 7. All eight required type-test files remained selected in each case. Three of four selective cases therefore removed only 17 tests from approximately 670. This is a narrow opportunity even after improving graph analysis.

Validator's repeatable net savings remained concentrated in three translation commits: Thai +5,128 / +1,154 ms, German +1,147 / +1,022 ms, Korean +735 / +701 ms. Its observer median did not improve (1,101 to 1,125 ms). Selective mode alone is not evidence of a smaller executed suite or economic benefit.

Within this run's matched comparator, Validator's old observer also shows positive nets on the Arabic change (+702 / +861 ms), while the candidate shows −49 / +110 ms. The candidate's first observation was 751 ms slower in that pair. Across both observation repetitions, eight of sixteen Validator pairs favor each engine. This is not evidence of a Go optimization; it exposes the sensitivity of marginal savings to observer timing and order/cache variability. The per-commit CSV retains both engines' net timings.

## Checks and limits

The final candidate passed Cloudflare typechecking, 2,151 full regression tests with zero failures (five skipped), and 22 focused adapter/scope/economics tests in Go-enabled jobs (zero skipped). Vue jobs passed 20 of those focused tests with two native-Go skips. The non-root control-plane suite passed 74 tests with three skips.

The packaged synthetic economics fixture returned `REFUSED` / `BYPASS_FULL`, emitted no selective result, left the worktree unchanged and recorded no engine-load or graph phase. Complete process time was 573 ms: 482 ms before observation, 70 ms inside observation. This proves functional early bypass, not zero overhead or real-repository savings. The package still pays startup/dependency costs. History production and automatic activation are not implemented; callers must supply truthful measurements. The configuration fingerprint covers a fixed documented file set, not every transitive configuration input.

Qualification caught and fixed two intermediate problems: installed observer identity incorrectly reported `0.0.0`, and the first scoped optimization could not model Router's generated bundles, correctly causing full fallback. The final version identifies its package accurately and follows generated implementation imports recursively. Diagnostic v1 runs were preserved separately and excluded from final qualification. Historical baseline observations still display their old identity bug; the independently verified artifact hash identifies the comparator.

All 48 ordered head/base pairs matched the previous cohort, and all 96 old/new observation pairs preserved policy and worktree state. There were 45 stable cases, 13 smaller stable suites and three cases with positive candidate net savings in both repetitions. All 17 executed fault injections were detected; the fixed injection at Chi index 3 was not reached because its ordinary test run failed. Reka indices 1 and 2 failed the historical Tree snapshot, and Chi index 3 failed TestThrottleCustomStatusCode. Chi had seven stable cases this time versus four previously; this upstream test variability is not an observer improvement. Chi had no repeatable net savings: even its +15,814 ms first result at index 0 reversed to -942 ms in the other order. All six final containers were released after evidence preservation. See the [48-row result CSV](2026-09-12-observer-performance-cases.csv).

Keep this candidate in shadow. The next useful measurement is a chronological, held-out evaluation of the opt-in bypass using real per-job histories, including its startup cost and periodic forced resampling. Broadening selective execution or promoting on the basis of latency improvements alone is not supported by these results.
