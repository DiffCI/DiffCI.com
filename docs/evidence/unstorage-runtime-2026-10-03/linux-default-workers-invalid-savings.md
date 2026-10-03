# DiffCI Verify Savings: Unstorage: local unpublished DiffCI, Linux, local S3 emulator

Produced at: 2026-10-03T03:29:47.432Z
Repository label: Unstorage: local unpublished DiffCI, Linux, local S3 emulator
Selection source: diffci-observation

Selected tests: 2 of 40

> WARNING: Checkout provenance validation failed: . Timings are diagnostic only.


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

Comparison invalid: checkout identity changed or could not be verified. Do not interpret the timing difference as savings.

| Measure | Value |
| --- | ---: |
| Full runtime | 30.39s |
| Selected runtime | 29.63s |
| Test execution change vs full | +2.5% |
| DiffCI analysis overhead | 3.61s |
| Net selected runtime | 33.24s |
| Delta vs full | -2.85s slower |
| Percent change vs full | -9.4% |
| Runtime evidence | invalid |
| Repetitions | 3 |
| Full runtime range | 28.44s / 30.39s / 41.15s (min/median/max) |
| Selected runtime range | 16.57s / 29.63s / 29.80s (min/median/max) |

## Measurement Protocol

| Field | Value |
| --- | --- |
| Alternating arm order | yes |
| Declared cache state | warm |
| Cache preparation command | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 test` |
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
| Observation SHA-256 | `51a4c8b7e496c8524967e1d284fa28ccc833428f68a8bdfa6edf4dbee87e0a50` |
| DiffCI observer version | 0.3.1 |
| Checkout stable across both arms | yes |
| Dependency inputs SHA-256 | `a5e3b9e204866bce9d50afde97f0e77e4533e448fd40d42ed7050db9b303414b` |
| Resolved dependency markers SHA-256 | `d28947a676f83c2b12ef1b0e0ed946f344443192a7ceeba06ddc8dca3af53075` |
| Runner identity SHA-256 | `9d2402820337bdf55db1ead4c9d0f2e32be96a6941d8d73f2e91ef00dcec95f9` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | 0 | no | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 test` |
| Selected | 0 | no | `corepack pnpm@11.21.0 build && corepack pnpm@11.21.0 lint && corepack pnpm@11.21.0 test:types && corepack pnpm@11.21.0 exec vitest run --typecheck.only && corepack pnpm@11.21.0 exec vitest run --coverage test/drivers/s3-list.test.ts test/drivers/s3.test.ts` |

## Maintainer Review

| Question | Answer |
| --- | --- |
| Command coverage | Selected command came from the observation report. If the repository needs a runner-specific command, rerun with an explicit selected command that covers the complete DiffCI selection. |
| Cache state | warm; reset/preparation applied before each arm. |
| Invalid evidence handling | Failed commands or unstable checkout provenance are labelled diagnostic only above. |
| Next step | Fix the checkout/provenance issue and rerun before treating this as savings evidence. |

## Interpretation Notes

- This is paired runtime evidence, not a production-savings claim.
- Full and selected commands were run sequentially in the same checkout.
- Net selected runtime includes DiffCI analysis overhead.
- Runtime evidence is preliminary until at least three alternating, cache-prepared repetitions agree.
