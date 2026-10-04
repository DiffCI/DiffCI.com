# DiffCI Verify Savings: Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker, full source and declaration guards

Produced at: 2026-10-03T05:05:11.356Z
Repository label: Unstorage: unpublished DiffCI, Linux, local S3 emulator, one worker, full source and declaration guards
Selection source: diffci-observation

Selected tests: 5 of 40


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result


| Measure | Value |
| --- | ---: |
| Full runtime | 49.22s |
| Selected runtime | 15.34s |
| Test execution change vs full | +68.8% |
| DiffCI analysis overhead | 8.82s |
| Net selected runtime | 24.16s |
| Delta vs full | 25.05s faster |
| Percent change vs full | +50.9% |
| Runtime evidence | controlled |
| Repetitions | 3 |
| Full runtime range | 47.54s / 49.22s / 75.35s (min/median/max) |
| Selected runtime range | 14.54s / 15.34s / 18.24s (min/median/max) |

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
| Runner identity SHA-256 | `0a1f86143b381589065216700816f7b4f42bbc0724bfe54c0c0bb93efec2da5f` |

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
| Next step | Review the repeated-run distribution and failure assessment before considering a production trial. |

## Interpretation Notes

- This is paired runtime evidence, not a production-savings claim.
- Full and selected commands were run sequentially in the same checkout.
- Net selected runtime includes DiffCI analysis overhead.
- Runtime evidence used at least three alternating, cache-prepared repetitions.
