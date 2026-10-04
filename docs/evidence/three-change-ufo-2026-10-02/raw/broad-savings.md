# DiffCI Verify Savings: ufo

Produced at: 2026-10-02T08:36:28.779Z
Repository label: ufo
Selection source: diffci-observation

Selected tests: 13 of 13

> WARNING: Full failed while selected passed. Do not treat this selected command as safe until the full-run failure is understood.


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

Comparison invalid: command failure. Do not interpret the timing difference as savings.

| Measure | Value |
| --- | ---: |
| Full runtime | 49.40s |
| Selected runtime | 7.29s |
| Test execution change vs full | +85.2% |
| DiffCI analysis overhead | 1.82s |
| Net selected runtime | 9.11s |
| Delta vs full | 40.29s faster |
| Percent change vs full | +81.6% |
| Runtime evidence | invalid |
| Repetitions | 1 |
| Full runtime range | 49.40s / 49.40s / 49.40s (min/median/max) |
| Selected runtime range | 7.29s / 7.29s / 7.29s (min/median/max) |

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
| Base SHA | `9d1833b8a53e2347abc404d8e3db76a8f676bd4c` |
| Head SHA | `018167768365752f0bbe5b0867818cf9a1fbea50` |
| Observation SHA-256 | `d333b0ca8590f227ca7bbfb623ac22f28bcd930c337be7fb82041a6e7789401d` |
| DiffCI observer version | 0.3.1 |
| Checkout stable across both arms | yes |
| Dependency inputs SHA-256 | `1218f5f8c6995443a29915d09629f0c06e9fc9fde701dfd821d28b7db4bd2a6c` |
| Resolved dependency markers SHA-256 | `6301642731075af5cce42477bed071e2a36dbb74555abbe6c2bf59dbe78070e1` |
| Runner identity SHA-256 | `a59018791e67833b225a7cead8b58e2eb06c46efc9e1660981303729eb335807` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | 1 | no | `pnpm test` |
| Selected | 0 | no | `pnpm exec vitest run test/base.test.ts test/double-slash.test.ts test/encoding.test.ts test/is-same.test.ts test/join.test.ts test/normalize.test.ts test/parse.test.ts test/punycode.test.ts test/query.test.ts test/resolve.test.ts test/trailing-slash.test.ts test/url.test.ts test/utilities.test.ts` |

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
