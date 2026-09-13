# Frozen-history bypass evaluation — 2026-09-12

This experiment evaluates the existing economics bypass without changing its rules or the observer artifact. It separates reduced analysis overhead from net savings versus plain full CI. All builds, tests and repository workloads run on Cloudflare; the desktop edits/packages source, orchestrates jobs and aggregates downloaded reports.

## Protocol frozen before execution

For each of the six existing OSS repositories, take the latest 16 eligible source commits from the pinned first-parent history, then process them oldest first. The first eight are calibration commits; the next eight are held out from history construction. No failed or inconvenient commit is replaced. These held-out source commits have appeared in previous engineering benchmarks: this is a chronological timing-history holdout, not a blind test of previously unknown repositories or source changes.

Training uses the unchanged `0.1.6-candidate.1` observer and real full/selected test executions. Two observer measurements and two test repetitions are retained. Only green, readable runs with a stable full test universe enter history. The offline audit also checks selected-test counts across admitted repetitions. When the policy is full, selected work is the identical full command and shares its measured duration; differences between repeated full runs are not labeled gross savings.

After calibration, freeze one artifact for the job's latest observed training configuration. Include only stable training samples matching that context. Do not use the held-out checkout or its measured outcomes to pick history or refresh it. Retain the five-distinct-ancestor-commit minimum, exact observer/job/repository/configuration match, 48-hour freshness rule and fixed inequality:

```text
maximum historical gross saving × 1.25 + 250 ms < minimum historical observer cost
```

Insufficient or mismatched history resumes analysis. No thresholds are tuned from this run. Both timing repetitions from each admitted commit are eligible samples; they do not count as two distinct commits. Zero-duration empty-selection samples are excluded rather than fabricated into positive timings.

Each held-out commit gets two paired fresh-process observations, with first order alternating by commit and second order reversed: normal gating with frozen history, and forced analysis with the same history. Forced analysis is a diagnostic comparator and is never fed back into history. Thus “always analyze” here specifically means `--force-analysis` with the same history artifact, including its read/evaluation cost. Gating must either retain full CI before engine loading or preserve the forced observer's decision details.

Run the full test suite and the forced observer's executable selection in both orders. Confirm the actual Vue suite inventory before using selective execution. When both policies execute the same command, share measured test work rather than turn run-to-run noise into savings. This allows measuring whether bypass suppresses a profitable opportunity even when its actual policy is full CI.

```text
always-analyze net = full time − forced-selection time − forced observer time
controlled net = full time − controlled test time − gated observer time
improvement versus forced analysis = controlled net − always-analyze net
```

A full bypass therefore has controlled net equal to **negative bypass process time** versus plain full CI. It can improve over analysis while remaining pure overhead against full CI. “Missed repeatable savings” means bypass was chosen while forced selection had positive net savings in both test repetitions. Count inconclusive/failed cases separately, never as savings.

All CLI process time, including startup, local history reading, Git ancestry checks and analysis, is counted. Shared checkout/install/prerequisite builds, remote history-artifact retrieval and CI billing rounding are outside these net timings. Extra forced-oracle observations and diagnostic test repetitions are research work, not the deployed controlled path. Calibration's recorded extra work is reported separately; held-out savings do not imply calibration payback.

## Results

**No aggregate net savings, and no demonstrated bypass benefit.** Across 48 held-out commits, bypass activated zero times. Of the 45 cases with two stable test repetitions, six had positive controlled net savings in both repetitions. Summing those 45 cases, including the losses, DiffCI added **29.072 seconds in repetition 1 and 57.010 seconds in repetition 2** versus plain full CI.

| Repository | Stable calibration / 8 | Matching history commits | Stable held-out / 8 | Bypasses / 8 | Positive net in both repeats | Net sum, repeat 1 / 2 (seconds) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Reka UI | 8 | 8 | 6 | 0 | 0 | −17.057 / −16.923 |
| Vue Test Utils | 8 | 1 | 8 | 0 | 0 | −9.977 / −10.113 |
| Vue Router | 7 | 3 | 8 | 0 | 2 | −7.155 / −9.690 |
| Chi | 8 | 8 | 7 | 0 | 0 | −4.282 / −7.979 |
| Cobra | 8 | 4 | 8 | 0 | 0 | +0.631 / −11.145 |
| Validator | 8 | 4 | 8 | 0 | 4 | +8.768 / −1.160 |
| Total | 47 / 48 | — | 45 / 48 | 0 / 48 | 6 / 45 | −29.072 / −57.010 |

Positive means time saved after observer cost. Each total is one repetition across all stable cases, not a per-job median or a confidence interval. No repository had positive aggregate net savings in both repetitions. See the [48-case audit CSV](2026-09-12-heldout-bypass-cases.csv) for individual commits, decisions, reasons and paired timings.

The 48 analysis decisions divide into **24 configuration mismatches, 16 insufficient-distinct-commit histories and eight cases where Chi's historical maximum gross saving kept analysis enabled**. Compared with forced analysis using the same history, the controlled path added 3.612 / 0.346 seconds across the paired totals. Because every gate chose analysis, this is process timing variation and gate-path overhead, not an observed bypass saving.

The recorded calibration work above one full test execution per training case totals **1,933.143 seconds (32.22 minutes)** across the six final runs. This sums measured observer and test-command durations, including research repetitions. It excludes setup/build work and the discarded diagnostic attempts; it is neither a Cloudflare bill nor a production calibration-cost estimate. With negative aggregate held-out net savings, this experiment demonstrates no calibration payback.

The gate did not activate in any final repository run. Reka's eight historical commits qualified as stable samples, but every held-out configuration fingerprint differed. Router had three distinct commits in its latest configuration; two held-out cases matched that context but failed the five-commit minimum, and six had a different fingerprint. Cobra had four matching historical commits: six cases failed the minimum and two mismatched configuration. Validator had four historical commits and all eight cases failed the minimum. Test Utils recovered all eight stable calibration commits after the harness correction, but only one belongs to the latest training configuration; all eight held-out contexts differ from that frozen context. These counts are context-specific; they are not the number of successful calibration commits overall.

Chi had eight matching training commits but its largest observed gross saving was 20,361 ms versus a minimum observer cost of 872 ms, so the fixed rule required analysis. That large gross saving came from 46,074 ms full versus 25,713 ms selected on the first training commit. The reverse-order repetition was 25,977 versus 25,742 ms, only 235 ms gross saving. The maximum-based rule intentionally retains the optimistic single observation; this run exposes its sensitivity to startup/cache/order effects but does not establish their precise cause or justify tuning the rule after seeing outcomes.

No observed missed savings from bypass is a vacuous result when bypass never activates. Likewise there is no measured real-history bypass startup distribution in this experiment. The earlier synthetic bypass test remains functional evidence only.

The current run found positive controlled net time in both repetitions on four Validator translation commits (Korean 791/830 ms, German 1,018/936 ms, Arabic 795/661 ms, Thai 906/808 ms) and two Router commits (RouterLink prop 1,252/17 ms, memory history 374/75 ms). These are selective-execution observations, not bypass benefits. Router's smallest margins are particularly fragile and had not repeated in the prior run; do not generalize these small-sample positives into a reliable job-level claim.

## Evidence and checks

- Benchmark source commit: `4d9b682`.
- Source object: `sources/bypass-heldout-20260912-v1.tgz`.
- Source SHA256: `cec56728b741bf9b77f203983b0e0c4723c89884955e8e846f2ec066d57d5b95`.
- Observer: `0.1.6-candidate.1`; verified artifact `sha512-elBxpjaEiYlfj3ZJsQ14cKbS+cO/Fui5/EX8/I4/erKqa8eNm8uBSsE86aczZ+A4J9bBjUWdur0XpzrOerb68A==`.
- Image: `docker.io/cloudflare/sandbox:0.12.5`; repository observations/tests use UID/GID 1000. Go is pinned to 1.27.1.
- Final run IDs: `bypass-heldout-20260912-{reka-ui,chi,validator,cobra,vue-router}-v2` and `bypass-heldout-20260913-vue-test-utils-v4`.
- Raw JSON, logs, receipts, frozen histories, aggregation script and CSV: `.diffci/bypass-heldout-20260912/` in the original workspace.

The first upload failed due to connectivity. Four initial jobs reported a missing R2 source object before running repository workloads. Their failed states were preserved and containers released. The identical source upload succeeded before replacement jobs started; those initial failures are excluded from benchmark results.

All original jobs ultimately completed within their Cloudflare time limits; Reka took 37.4 minutes. A planned training-checkpoint split was unnecessary, was never executed, and its unused harness support was reverted.

Audit found that the original Test Utils calibration failed five commits before tests ran because their Vitest 0.34 CLI rejects `--maxWorkers`. This was a harness compatibility failure, not five failing project tests. That run is preserved under `diagnostics-vue-test-utils-v2` and excluded from final totals. An initial compatibility attempt assumed historical thread CLI flags; its capability check rejected them before tests, so it was cancelled and preserved under `diagnostics-vue-test-utils-v3`.

The corrected harness reads the installed runner's help/version. Modern runners retain `--maxWorkers=2 --minWorkers=2`; verified Vitest 0.34.6 uses `--threads` with `VITEST_MAX_THREADS=2` and `VITEST_MIN_THREADS=2`, as supported by its [upstream configuration source](https://raw.githubusercontent.com/vitest-dev/vitest/v0.34.6/packages/vitest/src/node/config.ts). These overrides apply only to test execution and preserve the two-worker constraint and all commit/history rules. The corrected run ID is `bypass-heldout-20260913-vue-test-utils-v4`, source commit `e9c5ded`, source object `sources/bypass-heldout-20260913-v4.tgz`, SHA256 `ab948222368cf717a9c34ef67554a23409a447a8f08adc39fb6cceed40d6fd54`. The observer artifact is unchanged.

The observer engine is unchanged. New protocol tests reject held-out history records, failed/mismatched training samples and false savings from identical full policies. Existing graph, adapter, economics and full regression checks run on Cloudflare. Fault injections are not repeated in this economics-only experiment; previous correctness qualifications remain separate evidence.

The excluded cases in the five original repository runs remain visible: Reka held-out indices 13 and 14 failed the full-suite Tree snapshot; Chi held-out index 15 failed `TestThrottleCustomStatusCode` in one selected repetition; Router training index 3 failed two lazy-loading/alias tests. They are not replaced or admitted as stable savings evidence.

The final audit verified all six source receipts and the unchanged observer integrity, 48 training/48 held-out split, the exact previous held-out head/base pairs in chronological order, stable training measurements, matching training contexts, unchanged history IDs throughout holdout and observer non-interference. All 16 corrected Test Utils cases completed successfully. Its first five commits record Vitest 0.34.6 with the two environment limits; later commits record modern two-worker CLI arguments and no legacy overrides.

Cloudflare checks for final source `e9c5ded`: typechecks passed; full regression **2,155 passed, zero failed, five skipped**; focused adapter/scope/economics **21 passed, two Go-dependent skips**; protocol **three passed**; validation/control-plane **77 passed, three skipped**. The original Go-enabled repository jobs also passed their focused Go checks. These suites overlap and their pass counts must not be added as unique tests.

All final and diagnostic containers were released. The release confirmations are preserved in `container-release.json`, `compatibility-container-release.json` and `upload-failure-container-release.json`. No desktop builds or tests were run.

Production remains unchanged. This is a bounded benchmark and does not establish general prediction accuracy, dollar savings, cold/warm daemon behavior or a production history-collection policy.
