# Language adapter candidate results — September 12, 2026

The Go changes now enable smaller package selections, with bounded net savings on Validator translation changes. Vue dependency analysis improved, but all measured Vue deltas still require full validation. These results do not support a general Go/Vue savings claim or automatic production skipping.

All builds, dependency installation, observer analysis, regression tests, upstream suites and fault injection ran in Cloudflare Sandbox containers. The desktop only edited source, uploaded archives, orchestrated jobs and retrieved/aggregated result JSON. Production was not promoted.

## Changes

- Go associates metadata-reported inactive files with their owning package and selects its dependents. Inactive tests stay out of the executable test universe.
- Go discovery-excluded names no longer block unrelated changes merely by existing. Edits and renames involving these paths, including testdata, still force full validation. Unknown files, configuration changes, deleted unmodeled sources and unsupported build contexts retain full fallback.
- Vue resolves imported macro types through the compiler filesystem interface and records their runtime-relevant dependency edges. Candidate.2 also records compiler-reported dependencies and invalidates imported-type caches between components/analyses.
- Adapter versions and the graph cache schema advance. Dynamic Vue resolution, unsupported preprocessors and Nuxt conventions still block selection.

## What was measured

Forty-eight distinct historical commit deltas across the same six pinned repositories were evaluated across two candidate builds. Validator was repeated under the final candidate, making 56 completed commit evaluations. This is not a single-artifact 48-commit qualification: the versions below are intentional and the CSV preserves every run. The Go implementation is identical between candidate.1 and candidate.2; the latter adds the Vue cache correction.

| Repository | Candidate | Stable cases | Smaller executed test set | Positive net saving in both pairs |
|---|---|---:|---:|---:|
| Chi | 0.1.3-candidate.1 | 8/8 | 6/8 | 0/8 |
| Cobra | 0.1.3-candidate.1 | 8/8 | 0/8 | 0/8 |
| Validator, initial | 0.1.3-candidate.1 | 8/8 | 4/8 | 4/8 |
| Validator, final repeat | 0.1.3-candidate.2 | 8/8 | 4/8 | 3/8 |
| Vue Router | 0.1.3-candidate.1 | 8/8 | 0/8 | 0/8 |
| Reka UI | 0.1.3-candidate.1 | 6/8 | 0/8 | 0/8 |
| Vue Test Utils | 0.1.3-candidate.2 | 8/8 | 0/8 | 0/8 |

Reka UI's two first-baseline failures were Tree snapshot failures on the same historical candidates as the original cohort. No failing candidate was substituted. Chi's earlier baseline instability did not recur in these runs; that is not attributed to an engine fix.

SELECTIVE in an observer report does not guarantee a smaller executed suite. Cobra's plans still ran all observed tests. Some Validator and Chi plans also retained the full test count. These rows do not count as test reduction.

## Final candidate savings

Validator's package-local translation changes reduce the observed test count from 295–297 to one. Net saved time subtracts observer process elapsed time; installation, build and container startup costs are excluded. These are runtime measurements, not Cloudflare billing estimates.

| Changed package | First pair net saved | Repeat pair net saved | Repeat net percentage |
|---|---:|---:|---:|
| Thai | 3,784 ms | 539 ms | 28.1% |
| German | 513 ms | 619 ms | 31.2% |
| Korean | 325 ms | 477 ms | 24.8% |
| Arabic | 103 ms | -146 ms | -8.6% |

Arabic's tiny positive initial measurements did not repeat consistently, so it is not a robust savings result. First-pair cold/build effects can be large; do not advertise Thai's larger first-pair percentage as a general expected saving. Two pairs per commit provide bounded evidence, not an estimate of ecosystem-wide performance.

Chi selected fewer tests on six commits but observer overhead erased consistent net savings. Cobra ran the same tests and generally added overhead. All Vue cases retained FULL policy due to remaining runtime/framework/style dependency uncertainty, including docs/playground code discovered at repository scope.

## Fault and regression evidence

The final candidate's six planned faults across Validator and Vue Test Utils were detected. The Validator Korean mutation is a genuine reduced-suite detection case. Vue Test Utils retained full policy, so its full-policy detections are not independent evidence for selective safety.

Across the earlier candidate's five completed repositories, 14 of 15 attempted faults were detected. Chi candidate index 3 was inconclusive because the full suite did not detect the preregistered mutation. There was no observed case where the full suite detected a fault and the selected policy missed it. This is not a false-negative rate estimate or proof of general soundness.

The final candidate passed typechecking and the complete Cloudflare regression run: 2,143 passed, zero failed, five skipped (2,148 total). Its Go-enabled Cloudflare job separately passed all 14 focused adapter tests, including the native Go fixtures. Validation-environment checks passed 74 tests with three skips.

Earlier complete-suite attempts failed an existing live GitHub assertion under HTTP 403 with zero anonymous requests remaining. The unchanged assertion passed after the reported reset; the successful diagnostic response was HTTP 200 and returned the expected commit SHA. Failures and cancelled development runs remain retained, not relabeled as passes.

## Provenance and limits

- Candidate.1 integrity: sha512-Iv/lH5mhPn5nqx1qgcmA53WgGDmcYawUD8ZW3T1x5PloQR8C+zyalYzp6gtfD80gr4WuNqFE80lltMItQ2PXGA==
- Candidate.2 integrity: sha512-Ay7DsqgRXF9q2hIRW+kxeDG09fG6cbEfw+QcV4NVNB1q6HIRw+e5MKe3S+kt/HxbjuBcSnRiwP0rDdoSjJSeEA==
- Final candidate source commit: f06f701. Archive SHA256: f6f9fb19575f73bdb9f5ce2f4e4dc3cfced989c2f7e580f5eec2544582446263.
- Final candidate jobs: candidate-20260912-validator-v6 and candidate-20260912-vue-test-utils-v7, both using the same uploaded source and producing identical artifact integrity.
- Earlier completed jobs: candidate-20260912-chi-v3, candidate-20260912-validator-v3, candidate-20260912-cobra-v4, candidate-20260912-vue-router-v4, candidate-20260912-reka-ui-v4.
- Reports identify the actual candidate artifact. Execution receipts separately identify the old bootstrap artifact; that bootstrap integrity is not the measured candidate integrity.
- Every completed report records non-root uid/gid 1000. R2 retains JSON, logs and execution receipts under validation/<runId>/. Completed benchmark containers are released after evidence collection.

Each repository folder contains language-qualification.json, language-qualification.log and execution-receipt.json. commit-results.csv contains all 56 completed evaluations with versions, commit SHAs, counts, timings and fault outcomes. Diagnostic subfolders retain aborted and failed preparation attempts.

Further Vue savings require explicit measured-suite/package boundaries and better runtime dependency modeling. The current candidate deliberately retains the existing full-suite guards for those unresolved cases. The measured Go results favor isolated packages whose avoided test work exceeds observer startup/analysis overhead.
