# DiffCI Verify Savings: immer

Produced at: 2026-10-02T09:11:51.202Z
Repository label: immer
Selection source: diffci-observation

Selected tests: 21 of 22


This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result


| Measure | Value |
| --- | ---: |
| Full runtime | 53.71s |
| Selected runtime | 7.80s |
| Test execution change vs full | +85.5% |
| DiffCI analysis overhead | 2.61s |
| Net selected runtime | 10.41s |
| Delta vs full | 43.30s faster |
| Percent change vs full | +80.6% |
| Runtime evidence | preliminary |
| Repetitions | 1 |
| Full runtime range | 53.71s / 53.71s / 53.71s (min/median/max) |
| Selected runtime range | 7.80s / 7.80s / 7.80s (min/median/max) |

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
| Classification | none |
| Confidence | not-applicable |
| Explanation | Every measured arm passed. |

## Provenance

| Field | Value |
| --- | --- |
| Base SHA | `6c7a3deb5b2cacf625d8f99263af627ae69f36e3` |
| Head SHA | `b00474e3755954f6b27a392dcb4bce97254c100c` |
| Observation SHA-256 | `64b52bf36bb7da55dd5e94c577ee85e662ed7d7b8a79f43c8628be9e4c1a1df5` |
| DiffCI observer version | 0.3.1 |
| Checkout stable across both arms | yes |
| Dependency inputs SHA-256 | `b88494d3a4bebe7e25847fef1a7f1b65c341569800e083faf2540ef59cab99fe` |
| Resolved dependency markers SHA-256 | `unavailable` |
| Runner identity SHA-256 | `a59018791e67833b225a7cead8b58e2eb06c46efc9e1660981303729eb335807` |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | 0 | no | `yarn test` |
| Selected | 0 | no | `yarn run vitest run --config vitest.config.ts __tests__/base.js __tests__/current.js __tests__/curry.js __tests__/draft.ts __tests__/empty.ts __tests__/frozen.js __tests__/immutable.ts __tests__/isDraftable.js __tests__/manual.js __tests__/map-set.js __tests__/not-strict-copy.ts __tests__/null.js __tests__/original.js __tests__/patch.js __tests__/plugins.js __tests__/produce.ts __tests__/readme.js __tests__/redux.ts __tests__/regressions.js __tests__/type-external.ts __tests__/updateScenarios.js` |

## Maintainer Review

| Question | Answer |
| --- | --- |
| Command coverage | Selected command came from the observation report. If the repository needs a runner-specific command, rerun with an explicit selected command that covers the complete DiffCI selection. |
| Cache state | unknown; not independently controlled. |
| Invalid evidence handling | Failed commands or unstable checkout provenance are labelled diagnostic only above. |
| Next step | Repeat at least three times with alternating order and a cache-preparation command to establish controlled cache state before making a production-savings claim. |

## Interpretation Notes

- This is paired runtime evidence, not a production-savings claim.
- Full and selected commands were run sequentially in the same checkout.
- Net selected runtime includes DiffCI analysis overhead.
- Runtime evidence is preliminary until at least three alternating, cache-prepared repetitions agree.
