# E2 funnel — frame continuation, ranks 41–140

Sequential in rank order under the rule frozen at `ad4b4f6`; registration rule frozen at `7d8e213`.
Stops at the fifth GREEN. **Every attempt is retained, including those that produced no verdict.**

```
100 frame entries → 10 E1 (addressable) → 10 E3 (unmeasured) → E2 in rank order
```

| rank | repository | run | outcome | detail |
|---|---|---|---|---|
| 46 | `lint-staged/lint-staged` | `e2-01` | *UNREGISTERED* | apparatus gap — registry had no entry. Not a verdict. Superseded by `7d8e213`. |
| 46 | `lint-staged/lint-staged` | `e2-02` | **RED** | 2 tests failing on both runs (2, 2) — deterministic. `test/e2e/stdin-config.test.js`, `test/e2e/no-stash.test.js`. 75/77 files, 459/461 tests green. |
| 58 | `jantimon/html-webpack-plugin` | `e2-03` | **RED** | install failed at 1.5s: `npm error code ERESOLVE`. |
| 62 | `eslint-community/eslint-plugin-promise` | `e2-04` | **GREEN 1** | 18 suites, 564 tests. exit 0 both runs. 7.83 / 4.55 CPU-s. |
| 75 | `webpack/postcss-loader` | `e2-05` | **GREEN 2** | 9 suites, 136 tests (4 skipped), 258 snapshots. 16.40 / 13.07 CPU-s. |
| 80 | `vuejs/eslint-plugin-vue` | `e2-06` | **RED** | install crashed at 15.6s: `Cannot read properties of null (reading 'edgesOut')`. Derivation shows **no lockfile**, so the rule fell through to `npm install`. |
| 112 | `ezolenko/rollup-plugin-typescript2` | `e2-07` | **GREEN 3** | 11 suites, 44 tests. 42.34 / 37.28 CPU-s. |
| 115 | `webpack-contrib/extract-text-webpack-plugin` | `e2-08` | **GREEN 4** | 5 suites, 40 tests, 27 snapshots. 3.05 CPU-s. |
| 116 | `testing-library/jest-dom` | `e2-09` | *INFRASTRUCTURE* | bootstrap: "interrupted while the platform was updating the sandbox runtime". |
| 116 | `testing-library/jest-dom` | `e2-10` | *INFRASTRUCTURE* | bootstrap: "The sandbox container stopped while the operation was pending." |
| 116 | `testing-library/jest-dom` | `e2-11` | *INFRASTRUCTURE* | bootstrap: same message. |
| — | *(platform probe, not a population repository)* | `platform-probe-01` | *INFRASTRUCTURE* | `apparatus-determinism-gen-c` — a job that passed identically twice before — failed with the same message. |
| 119 | `ant-design/ant-design` | — | not attempted | blocked behind rank 116 |
| 120 | `vuejs/vue-loader` | — | not attempted | blocked behind rank 116 |

**Standing: 4 GREEN of 8 repositories attempted. One more needed.**

## The platform is currently unable to run containers

Three consecutive rank-116 failures, all at bootstrap, all before any repository code was touched, were
not sufficient to conclude anything — three wrong inferences from exactly this evidence shape are
already recorded in `laboratory-defects.md`, and the "decisive" probe that time was malformed.

So a **discriminating** probe was run: `apparatus-determinism-gen-c`, re-executed as
`platform-probe-01`. It is not a population repository, its result cannot enter the funnel, and it had
already passed **identically twice**. It failed with the same message.

That is a well-formed discriminator. A known-good job failing identically means the fault is **not
specific to `jest-dom`**. What is established: the container platform is presently failing runs at
bootstrap. What is NOT established: why, or for how long.

## Why rank 116 is not RED, and why 119 was not started

`jest-dom` has **no qualification verdict**. Nothing was installed and no suite ran. Recording it RED
would be the same false-exclusion mistake as defects 20 and 21 — attributing an apparatus or platform
event to a repository.

Rank 119 was NOT started to make progress while 116 is stuck. Evaluating 119 before 116 could change
which repository becomes the fifth GREEN, and rank order is the single guarantee the traversal makes.
Skipping to keep moving would trade the property the experiment exists to protect for the appearance of
progress.

**Held here.** Resumes at rank 116 when the platform recovers.
