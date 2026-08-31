# The RED qualification corpus — a separate causal question

Six repositories failed E2 during the generation-C traversal. They are preserved as their own corpus,
**deliberately not mixed into anything that trains or evaluates test selection.**

## Why they are kept apart

These rows answer *"can this repository's legitimate baseline be reproduced from generic command
derivation?"* — an environment and configuration question.

Selection evidence answers *"given a reproduced baseline, which tests must run?"* — a dependency and
impact question.

Training one model on both teaches false causation: that a repository is unsuitable for selection
because `npm install` crashed, or that work was unnecessary because a build ran out of memory. Same
records, different objectives, different models.

## The corpus

| rank | repository | failure | layer | derivation evidence |
|---|---|---|---|---|
| 46 | `lint-staged/lint-staged` | 2 tests failing on both runs (2, 2); 75/77 files green | test outcome | — |
| 58 | `jantimon/html-webpack-plugin` | install `ERESOLVE` at 1.5s | install | derivation not collected (predates `register.log`) |
| 80 | `vuejs/eslint-plugin-vue` | `Cannot read properties of null (reading 'edgesOut')` | install | **no lockfile** → rule fell through to `npm install` |
| 116 | `testing-library/jest-dom` | exit 1, 8 test files failed, **no tests ran**; `CONTRADICTORY_EXECUTION_EVIDENCE` | invocation | repo drives vitest via `kcd-scripts test`; rule derived a direct `vitest run` |
| 119 | `ant-design/ant-design` | build OOM after 235s install + 83s build | resource | build script present, included uniformly per the rule |
| 120 | `vuejs/vue-loader` | 5 tests failing on both runs (5, 5) | test outcome | — |

**Four of six failed before producing any test result.** Only `lint-staged` and `vue-loader` reached a
genuine test outcome.

## What makes them valuable rather than noise

Each is a worked example of **real repository CI configuration diverging from generic command
derivation**, and each carries the derivation record showing exactly what evidence produced the command
that failed. That is the input/label pair an inference system needs:

```
manifest + lockfiles + scripts + declared runners   →   commands that actually work
```

`jest-dom` is the sharpest case: the manifest declares vitest, so the rule derived a direct vitest
invocation, but the repository runs it through a wrapper (`kcd-scripts`) that supplies configuration the
direct call never sees. No amount of dependency analysis fixes that; it needs an understanding of how
the repository actually builds and tests.

## Standing constraints

- **Not repaired.** No `--legacy-peer-deps`, no `--max-old-space-size`, no wrapper adaptation, no test
  exclusion. Repairing them inside a sealed qualification would have changed the experiment.
- **Not re-attempted.** One attempt per repository under the frozen rule.
- **Not eligible.** They are outside the frozen population and stay outside it.
- **Never merged** into selection-model training or evaluation.

## Related

- `docs/label-distinctness-principle.md` — why RED, `INFRASTRUCTURE`, `UNREGISTERABLE` and `NO_VERDICT`
  must remain distinct.
- `src/validation-env/execution-receipt.ts` — `outcome.layer`, which lets these be separated by a
  recorded field rather than by later judgement.
