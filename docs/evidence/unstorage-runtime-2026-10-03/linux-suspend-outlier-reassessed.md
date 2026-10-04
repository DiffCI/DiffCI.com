# DiffCI Verify Savings: Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker, full source and declaration guards

Produced at: 2026-10-03T04:59:49.140Z
Repository label: Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker, full source and declaration guards
Selection source: diffci-observation

Selected tests: 5 of 40

> WARNING: Checkout provenance validation failed: . Timings are diagnostic only.


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

Comparison invalid: checkout identity changed or could not be verified. Do not interpret the timing difference as savings.

| Measure | Value |
| --- | ---: |
| Full runtime | 39.13s |
| Selected runtime | 11.71s |
| Test execution change vs full | +70.1% |
| DiffCI analysis overhead | 8.82s |
| Net selected runtime | 20.53s |
| Delta vs full | 18.60s faster |
| Percent change vs full | +47.5% |
| Runtime evidence | invalid |
| Repetitions | 3 |
| Full runtime range | 31.62s / 39.13s / 4615.62s (min/median/max) |
| Selected runtime range | 11.29s / 11.71s / 11.90s (min/median/max) |

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
| Classification | none |
| Confidence | not-applicable |
| Explanation | Every measured arm passed. |

## Provenance

| Field | Value |
| --- | --- |
| Base SHA | `88f8e43b40ea5533a96118770784ecb58d945243` |
| Head SHA | `c9361afa5833d601cf262d137f068e3907fd8c9d` |
| Observation SHA-256 | `bb3d0361168de64931b6a2511f211178fffd8beb203a6c9a2052c2c6a3cd560d` |
| DiffCI observer version | 0.3.1 |
| Checkout stable across both arms | yes |
| Dependency inputs SHA-256 | `a5e3b9e204866bce9d50afde97f0e77e4533e448fd40d42ed7050db9b303414b` |
| Resolved dependency markers SHA-256 | `d28947a676f83c2b12ef1b0e0ed946f344443192a7ceeba06ddc8dca3af53075` |
| Runner identity SHA-256 | `e700870461834aa341529e07c8ae3cae62cc5b62fc18a4b452a6106d73683fb9` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | 0 | no | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 test --maxWorkers=1` |
| Selected | 0 | no | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 lint && corepack pnpm@11.21.0 test:types && corepack pnpm@11.21.0 exec vitest run --typecheck.only --maxWorkers=1 && corepack pnpm@11.21.0 exec vitest run --coverage --maxWorkers=1 test/driver-dependencies.test.ts test/driver-types.test.ts test/drivers/db0.test.ts test/drivers/s3-list.test.ts test/drivers/s3.test.ts` |

## Maintainer Review

| Question | Answer |
| --- | --- |
| Command coverage | Selected command came from the observation report. If the repository needs a runner-specific command, rerun with an explicit selected command that covers the complete DiffCI selection. |
| Cache state | cold; reset/preparation applied before each arm. |
| Invalid evidence handling | Failed commands or unstable checkout provenance are labelled diagnostic only above. |
| Next step | Fix the checkout/provenance issue and rerun before treating this as savings evidence. |

## Interpretation Notes

- This is paired runtime evidence, not a production-savings claim.
- Full and selected commands were run sequentially in the same checkout.
- Net selected runtime includes DiffCI analysis overhead.
- Runtime evidence is preliminary until at least three alternating, cache-prepared repetitions agree.
- Timing invalid: elapsed wall time is outside the configured timeout bounds; runner suspension or a clock discontinuity may have occurred.
