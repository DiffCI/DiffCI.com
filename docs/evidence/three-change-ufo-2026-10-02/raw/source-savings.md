# DiffCI Verify Savings: ufo

Produced at: 2026-10-02T08:33:31.213Z
Repository label: ufo
Selection source: diffci-observation

Selected tests: 12 of 13

> WARNING: Full failed while selected passed. Do not treat this selected command as safe until the full-run failure is understood.


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

Comparison invalid: command failure. Do not interpret the timing difference as savings.

| Measure | Value |
| --- | ---: |
| Full runtime | 5.20s |
| Selected runtime | 2.07s |
| Test execution change vs full | +60.1% |
| DiffCI analysis overhead | 1.57s |
| Net selected runtime | 3.64s |
| Delta vs full | 1.56s faster |
| Percent change vs full | +29.9% |
| Runtime evidence | invalid |
| Repetitions | 1 |
| Full runtime range | 5.20s / 5.20s / 5.20s (min/median/max) |
| Selected runtime range | 2.07s / 2.07s / 2.07s (min/median/max) |

## Measurement Protocol

| Field | Value |
| --- | --- |
| Alternating arm order | no |
| Declared cache state | unknown |
| Cache preparation command | not provided |
| Cache state controlled | no |

## Failure Assessment

| Field | Value |
| --- | --- |
| Classification | inconclusive |
| Confidence | low |
| Explanation | The full arm failed while the selected arm passed, but fewer than three repetitions cannot separate a stable miss from a flake. |

## Provenance

| Field | Value |
| --- | --- |
| Base SHA | `a7b94e69ff6159de8ddfd4940c90db4708c0d67e` |
| Head SHA | `5cd9e676711af3f4e4b5398ddf6ca8d52c1c7e1f` |
| Observation SHA-256 | `26446160e23582aaca7976d8df3ed507fe701c21be5b05d62de0d769ddf9dcda` |
| DiffCI observer version | 0.3.1 |
| Checkout stable across both arms | yes |
| Dependency inputs SHA-256 | `9d42cf2200e6df602e3042a792012005f484ec81f965224fdab691d401eda0f1` |
| Resolved dependency markers SHA-256 | `022bd75560a4341b94954f493e39f4bc72ffee360042f32dbe2974ece97e1bb3` |
| Runner identity SHA-256 | `a59018791e67833b225a7cead8b58e2eb06c46efc9e1660981303729eb335807` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | 1 | no | `pnpm test` |
| Selected | 0 | no | `pnpm exec vitest run test/base.test.ts test/double-slash.test.ts test/encoding.test.ts test/is-same.test.ts test/join.test.ts test/normalize.test.ts test/parse.test.ts test/query.test.ts test/resolve.test.ts test/trailing-slash.test.ts test/url.test.ts test/utilities.test.ts` |

## Maintainer Review

| Question | Answer |
| --- | --- |
| Command coverage | Selected command came from the observation report. If the repository needs a runner-specific command, rerun with an explicit selected command that covers the complete DiffCI selection. |
| Cache state | unknown; not independently controlled. |
| Invalid evidence handling | Failed commands or unstable checkout provenance are labelled diagnostic only above. |
| Next step | Inspect the failed command output and rerun before treating this as savings evidence. |

## Interpretation Notes

- This is paired runtime evidence, not a production-savings claim.
- Full and selected commands were run sequentially in the same checkout.
- Net selected runtime includes DiffCI analysis overhead.
- Runtime evidence is preliminary until at least three alternating, cache-prepared repetitions agree.
- Full failed while selected passed; inspect outputs before treating the selection as safe.
