# E2 funnel — frame continuation, ranks 41–140

Sequential in rank order. Stops at the fifth GREEN. Every attempt is retained, including the ones that
did not produce an eligible repository.

| # | rank | repository | run | outcome | detail |
|---|---|---|---|---|---|
| 1 | 46 | `lint-staged/lint-staged` | `e2-01-lint-staged` | **UNREGISTERED** | apparatus gap, not a repository property — the registry had no entry. Superseded by the registration step at `7d8e213`; not a verdict about lint-staged. |
| 2 | 46 | `lint-staged/lint-staged` | `e2-02-lint-staged` | **RED** | 2 tests failing at HEAD on both runs (2, 2) — deterministic, not flaky. `test/e2e/stdin-config.test.js`, `test/e2e/no-stash.test.js`. 75 of 77 files passed, 459 of 461 tests. |
| 3 | 58 | `jantimon/html-webpack-plugin` | `e2-03-html-webpack-plugin` | running | |

## Notes carried with the RED

`lint-staged` is **deterministically red under the tested canonical environment**, not "broken". Its two
failures are e2e tests that likely depend on git or shell state the container does not reproduce. That
distinction matters and is not investigated further: under the frozen rule there is **one attempt per
repository**, and adjusting commands or excluding a failing directory to reach green would be tuning
until green — the exact thing the rule exists to prevent.

The traversal continues to the next rank. No repository is re-attempted.
