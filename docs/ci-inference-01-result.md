# CI_CONFIGURATION_INFERENCE_01 — the six-row benchmark

Inference from repository-owned evidence only, at the pinned tree, against the six frozen E2 REDs.
**Nothing was executed and no repository was repaired.**

## The rows

| repository | known failure | verdict | what the engine inferred |
|---|---|---|---|
| `jantimon/html-webpack-plugin` | install `ERESOLVE` | **CORRECT_INFERENCE** | `npm ci --legacy-peer-deps` — from the workflow |
| `vuejs/eslint-plugin-vue` | install crash, no lockfile | **INCORRECT_INFERENCE** | `npm install` — differs from the generic only in flags that cannot affect it |
| `lint-staged/lint-staged` | 2 e2e tests failed | INSUFFICIENT_EVIDENCE | proposes the repo's own command; avoidance undecidable without executing |
| `testing-library/jest-dom` | contradictory execution evidence | INSUFFICIENT_EVIDENCE | `npm run validate` — the repo's real command, not a synthesised vitest call |
| `vuejs/vue-loader` | 5 tests failed | INSUFFICIENT_EVIDENCE | `pnpm pretest:webpack4 && pnpm test:webpack4` |
| `ant-design/ant-design` | build OOM | INSUFFICIENT_EVIDENCE | a resource limit evidence alone cannot predict |

```
CORRECT_INFERENCE      1
INCORRECT_INFERENCE    1
INSUFFICIENT_EVIDENCE  4
CORRECT_REFUSAL        0
```

## The one unambiguous win

`html-webpack-plugin`'s real CI runs **`npm ci --legacy-peer-deps`**. The generic derivation ran
`npm ci`, which failed `ERESOLVE` in 1.5 s. The engine recovered the flag **from the workflow, without
being told the failure** — exactly the capability this step exists to build.

## The honest failure

`eslint-plugin-vue` is scored `INCORRECT_INFERENCE` against my own engine. It inferred `npm install`
where the generic used `npm install --no-audit --no-fund` — a difference in flags that cannot affect an
arborist crash. The engine produced a confident plan that would have failed the same way.

## Three scoring iterations, and why the first two were wrong

This matters more than the scores.

**Iteration 1 reported 6/6 success** — five `CORRECT_REFUSAL` plus one inference. It was false. All five
refusals carried the *same* reason, which was the signal: the engine was not analysing repositories, it
was failing to recognise them. Its rule required an install line **and** a test line as `run:` steps in
one job. Real CI does neither reliably — `ant-design` installs with `ut` (utoo), `jest-dom` installs via
the composite action `bahmutov/npm-install`, and `html-webpack-plugin`'s test script is `test:coverage`,
which the rule did not match. **The most informative row in the benchmark was hidden behind a refusal
scored as a success.**

**Iteration 2 reported 3 correct inferences.** Also too generous: it scored a win whenever the inferred
command *differed* from the generic one. That awarded `eslint-plugin-vue` a win for `npm install` versus
`npm install --no-audit --no-fund`.

**Iteration 3 requires demonstrable avoidance** — a different package manager, or a flag that changes
dependency *resolution*. `--no-audit`/`--no-fund` only suppress output and now count for nothing. Where
avoidance cannot be decided without executing, the row says so instead of claiming a win.

A benchmark that scores its own engine 6/6 on first run should be disbelieved, and this one was.

## The schema, built alongside rather than after

`src/ci-inference/schema.ts` separates **observed facts** from **inferences** at the type level. A
workflow line saying `npm ci` is an `ObservedFact` with file, line and literal text. "This is the
canonical install command" is an `InferredOperation` carrying `evidence[]`, `confidence`
(`OBSERVED`/`DERIVED`/`ASSUMED`), `unresolved[]` and an optional `refusalReason`.

`validateOperation` rejects the contradictions structurally: `OBSERVED` confidence with no evidence, an
empty command with no refusal, or a refusal that still proposes a command.

The output is an **execution graph**, not a command list — `checkout → install → … → test` as nodes with
`dependsOn`, so it grows into lint/typecheck/build/security/package/deploy/verify without being rebuilt.

## What is not yet true

- **No refusals fired at all.** `CORRECT_REFUSAL` is defined, scored as a success, and untriggered.
  Knowing when it does not understand a pipeline is the capability the engine most needs and has not
  demonstrated.
- The `unknown` operation kind is doing real work — `lint-staged`'s first executable step is
  `npm run typecheck`, and the engine has no notion that a job's *test* step matters more.
- Matrices, services and reusable workflows are collected as facts and not yet interpreted.
- 7 unresolved items on `ant-design` alone, all preserved rather than papered over.
