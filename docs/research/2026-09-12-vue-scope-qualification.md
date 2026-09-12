# Vue package-scope qualification — September 12, 2026

The candidate enables smaller Vue Router suites while retaining all configured type
tests. Those selections do not yet save net elapsed time. Validator continues to
show bounded savings on isolated translation-package changes. This evidence does
not justify a general Go/Vue savings claim or production skipping.

## Implementation

- A root `diffci.json` can explicitly declare one Vue package and its default
  Vitest config. Analysis and proposed pnpm commands use that package context.
- Unrelated documentation/playgrounds outside the package no longer block the
  graph merely by existing. Changes outside the package, unsupported config or
  plugins, unresolved internal dependencies, and cross-package dependencies keep
  full fallback. Physical path checks catch workspace symlinks in node_modules.
- Default enabled Vitest type-test files are part of the declared inventory and
  always run with every selection. Custom type-test discovery keeps full fallback.
- Qualification reconciles the declared inventory against the full runner's actual
  files before accepting a selective measurement. A mismatch executes full policy.
- Vue compiler initialization is deferred until a Vue adapter is actually used.
  This removes eager Vue compiler loading from Go-only observations; it is not a
  demonstrated end-to-end speedup in this experiment.

The configuration contract is documented in [Vue package suites](../vue-package-scope.md).
Production remains on observer 0.1.2; this candidate has not been promoted.

## Experiment and results

All builds, dependency installs, observer analysis, regression tests, upstream
tests and fault injection execute in Cloudflare Sandbox containers. The desktop
only edits source, archives/uploads it, orchestrates jobs and reads/aggregates
result JSON. Repository workloads run as uid/gid 1000, not root.

The experiment reuses the same six pinned repositories and eight historical
first-parent deltas per repository. Candidates and fault sites are frozen before
dependency installation; failed cases are retained, never replaced. Each genuine
selection gets full/policy and policy/full pairs. Full policy gets two full
baselines. Go test caching is disabled. Vue uses two Vitest workers and the same
explicit pnpm package/config invocation in both arms.

Net saved milliseconds = full test elapsed time − policy test elapsed time −
observer process elapsed time. Setup, prerequisite builds, container startup and
billing costs are outside this metric. Earlier direct-node Vue runs are not the
same invocation, so cross-run timing subtraction is not an improvement estimate.

All 48 cases completed on one identical candidate artifact. Forty-two have stable
green measurements; six are invalidated by test failures. There are no inventory
mismatches among accepted selective Vue cases, and all 48 observations preserve
the target worktree. Ordered base/head pairs match the previous cohort exactly.

| Repository | Stable cases | Smaller executed test set | Positive net saving in both pairs |
|---|---:|---:|---:|
| Vue Router | 8/8 | 4/8 | 0/8 |
| Vue Test Utils | 8/8 | 0/8 | 0/8 |
| Reka UI | 6/8 | 0/8 | 0/8 |
| Chi | 4/8 | 3/8 | 0/8 |
| Cobra | 8/8 | 0/8 | 0/8 |
| Validator | 8/8 | 4/8 | 3/8 |

The smaller-set and savings columns count stable cases only. SELECTIVE does not
necessarily mean fewer executed tests. Sixteen of eighteen planned fault probes
execute, and all sixteen detect the injected fault. Two Chi probes are not reached
after case validation fails. Four detections use genuinely smaller suites (two
Router, one Validator, one Chi); the others use full or equivalent-to-full policy.
No executed probe shows a full-suite-detected fault missed by the policy, but this
small sample is not proof of general selective-test safety.

### Vue Router

All four selective cases retain the eight configured type-test files. The complete
declared inventory matches all 50 files reported by the full suite on each of
these cases. The other four commits retain full policy for outside-package or
configuration/manifest changes.

| Commit | Full → selected tests | Full → selected files | Observer | First net saved | Repeat net saved |
|---|---:|---:|---:|---:|---:|
| 24ff936b | 672 → 478 | 50 → 42 | 3,653 ms | -1,899 ms | -2,035 ms |
| 2ddd19fc | 671 → 654 | 50 → 49 | 3,618 ms | -4,499 ms | -3,364 ms |
| e978eb8e | 670 → 653 | 50 → 49 | 3,564 ms | -2,993 ms | -3,093 ms |
| d992bb20 | 670 → 653 | 50 → 49 | 3,145 ms | -2,053 ms | -1,460 ms |

For example, the memory-history repeat reduced suite time from 20,701 to 19,083 ms,
but added 3,653 ms of analysis: a net 2,035 ms slowdown. Three other selections only
omit one runtime test file. Graph extraction alone takes 1.75–2.29 seconds on the
selective cases. The measured work removed is insufficient to cover the observer.

All three preregistered Router faults were detected. Two are genuine reduced-suite
detections; the third used full policy. These finite probes do not establish a
general false-negative rate.

### Validator

Four package-local translation changes reduce 295–297 observed tests to one.
Three save net time in both pairs:

| Package | First net saved | Repeat net saved | Repeat percentage |
|---|---:|---:|---:|
| Thai | 4,626 ms | 1,104 ms | 38.1% |
| German | 886 ms | 922 ms | 35.7% |
| Korean | 818 ms | 669 ms | 31.2% |

Arabic is mixed (-28 ms, +221 ms). Root-package changes retain the full observed
test count and do not give repeatable savings. All three planned faults were
detected; the Korean case is a genuine reduced-suite detection.

Absolute observer times were not lower than the previous candidate's Validator
run, while baseline suite times also increased. Separate container runs do not
isolate the lazy-loading change from environment variation. Do not attribute the
larger net savings percentages to that change.

### Other repositories

Cobra's eight cases are stable, but every executed policy retains the full observed
test count. None saves time in both pairs. Vue Test Utils retains full fallback on
all eight cases because its plugins/setup and runtime component resolution are not
fully modeled. Each repository detects its three planned faults under full or
equivalent-to-full policy; these are not reduced-suite safety evidence.

Chi has four stable cases, three with fewer observed tests and one retaining all
tests. None saves net time. The other four cases are invalidated by
`TestThrottleCustomStatusCode`: two first-baseline failures, one selected-run
failure and one repeat-full failure. Their timings are preserved but excluded from
successful results. The final commit's reduced suite detects its fault. Two planned
Chi faults are not reached because validation of those cases fails.

Reka UI retains full policy for all eight observations. Static suite discovery and
multiple component analyses remain unsupported in the declared package, alongside
dynamic component/directive resolution. Six cases have stable baselines; two fail
the same Tree snapshot assertion seen in the earlier cohort. All three planned
faults are detected using full policy, so they add no reduced-suite safety evidence.

## Regression and development evidence

The final candidate passed typechecking and the complete Cloudflare regression
suite: **2,148 passed, zero failed, five skipped** (2,153 total). Its Go-enabled job
passed all 19 focused adapter/scope tests with zero skips. Validation-environment
checks passed 74 tests with three skips. The full suite's existing live GitHub
assertion passed; the recorded diagnostic returned HTTP 200 and the expected SHA.

Development runs are retained separately. Early Router selections omitted type
tests and are invalid as qualification evidence. The final candidate fixes that
omission and checks the actual suite inventory. Candidate.3 failed a workspace
symlink regression before benchmarking; the corrected physical-path handling and
both symlink/ordinary-third-party fixtures pass in candidate.4. Cancelled or failed
development runs are not included in the final matrix.

## Provenance and remaining work

- Candidate: `0.1.4-candidate.4`, source commit `4d849c7`.
- Source archive: `sources/vue-scope-20260912-v4.tgz`.
- Source SHA256: `61c7af3498748be7e9704dfae5a298b739e04e32c85a2dc52bc5ae604fdbcbbf`.
- Actual candidate integrity: `sha512-jCBnEkaz686Pe9Qdzx4EdOXdt02gsOcZUIkTzVgOIyWJMWARmm1px21hqt2jAl3/5BvVTRFLC0gW9hzUGqTg6A==`.
- Jobs: `scope-20260912-<repository>-v4`, for vue-router, vue-test-utils, reka-ui,
  validator, chi and cobra.
- R2 bucket `diffci-validation-env` retains JSON, logs and execution receipts under
  `validation/<runId>/`. Receipts identify the older bootstrap artifact separately
  from the actual measured candidate recorded in each report.
- Local evidence: `.diffci/vue-scope-20260912/`, with one folder per final repository,
  a commit CSV and diagnostic subfolders. Completed containers are released after
  collection.

The next performance work should target measured observer startup/graph costs and
job-level gating for selections that remove little work. Broader runtime/plugin
and suite-discovery modeling is still needed for Vue Test Utils and Reka UI. Maintain shadow operation
and full fallback until repeated measurements justify a narrower activation.
