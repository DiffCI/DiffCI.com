# DiffCI Verify Savings: Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker

Produced at: 2026-10-03T03:37:36.462Z
Repository label: Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker
Selection source: diffci-observation

Selected tests: 2 of 40

> WARNING: Full failed while selected passed. Do not treat this selected command as safe until the full-run failure is understood.


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

Comparison invalid: command failure. Do not interpret the timing difference as savings.

| Measure | Value |
| --- | ---: |
| Full runtime | 115.89s |
| Selected runtime | 23.95s |
| Test execution change vs full | +79.3% |
| DiffCI analysis overhead | 3.61s |
| Net selected runtime | 27.56s |
| Delta vs full | 88.33s faster |
| Percent change vs full | +76.2% |
| Runtime evidence | invalid |
| Repetitions | 3 |
| Full runtime range | 62.11s / 115.89s / 141.02s (min/median/max) |
| Selected runtime range | 12.05s / 23.95s / 45.04s (min/median/max) |

## Measurement Protocol

| Field | Value |
| --- | --- |
| Alternating arm order | yes |
| Declared cache state | cold |
| Cache preparation command | `node /evidence/reset-vitest-cache.mjs` |
| Cache state controlled | yes |

## Failure Assessment

| Field | Value |
| --- | --- |
| Classification | likely_flaky |
| Confidence | medium |
| Explanation | At least one arm changed pass/fail outcome across repeated executions. |

## Provenance

| Field | Value |
| --- | --- |
| Base SHA | `88f8e43b40ea5533a96118770784ecb58d945243` |
| Head SHA | `c9361afa5833d601cf262d137f068e3907fd8c9d` |
| Observation SHA-256 | `51a4c8b7e496c8524967e1d284fa28ccc833428f68a8bdfa6edf4dbee87e0a50` |
| DiffCI observer version | 0.3.1 |
| Checkout stable across both arms | yes |
| Dependency inputs SHA-256 | `a5e3b9e204866bce9d50afde97f0e77e4533e448fd40d42ed7050db9b303414b` |
| Resolved dependency markers SHA-256 | `d28947a676f83c2b12ef1b0e0ed946f344443192a7ceeba06ddc8dca3af53075` |
| Runner identity SHA-256 | `9d2402820337bdf55db1ead4c9d0f2e32be96a6941d8d73f2e91ef00dcec95f9` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | 0 | no | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 test --maxWorkers=1` |
| Selected | 0 | no | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 lint && corepack pnpm@11.21.0 test:types && corepack pnpm@11.21.0 exec vitest run --typecheck.only --maxWorkers=1 && corepack pnpm@11.21.0 exec vitest run --coverage --maxWorkers=1 test/drivers/s3-list.test.ts test/drivers/s3.test.ts` |

## Maintainer Review

| Question | Answer |
| --- | --- |
| Command coverage | Selected command came from the observation report. If the repository needs a runner-specific command, rerun with an explicit selected command that covers the complete DiffCI selection. |
| Cache state | cold; reset/preparation applied before each arm. |
| Invalid evidence handling | Failed commands or unstable checkout provenance are labelled diagnostic only above. |
| Next step | Inspect the failed command output and rerun before treating this as savings evidence. |

## Interpretation Notes

- This is paired runtime evidence, not a production-savings claim.
- Full and selected commands were run sequentially in the same checkout.
- Net selected runtime includes DiffCI analysis overhead.
- Runtime evidence is preliminary until at least three alternating, cache-prepared repetitions agree.
- Full failed while selected passed; inspect outputs before treating the selection as safe.
