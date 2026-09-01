# CI_CONFIGURATION_INFERENCE_02 — epistemic control

Same six frozen repositories. No new repositories, no new command patterns, nothing repaired by hand.

## The six rows

| repository | optimisable | verdict | why |
|---|---|---|---|
| `jantimon/html-webpack-plugin` | **YES** | **CORRECT_INFERENCE** | executable install `npm ci --legacy-peer-deps` (OBSERVED) |
| `vuejs/eslint-plugin-vue` | **NO** | **CORRECT_REFUSAL** | install has no pinned dependency basis — no lockfile, no `packageManager` |
| `testing-library/jest-dom` | **NO** | **CORRECT_REFUSAL** | install via a third-party composite action; `npm run validate` resolves to the opaque wrapper `kcd-scripts` |
| `vuejs/vue-loader` | **NO** | **CORRECT_REFUSAL** | install blocked by an unresolved script reference |
| `ant-design/ant-design` | NO | INSUFFICIENT_EVIDENCE | 8 operations non-executable; the OOM itself is a **resource-prediction** problem, kept separate |
| `lint-staged/lint-staged` | YES | INSUFFICIENT_EVIDENCE | judged optimisable; whether its plan avoids a genuine test failure needs execution |

```
CORRECT_INFERENCE 1 · CORRECT_REFUSAL 3 · INSUFFICIENT_EVIDENCE 2 · INCORRECT_INFERENCE 0
```

**The milestone: the first genuine refusals, without losing the `html-webpack-plugin` recovery.**
INFERENCE_01 had zero refusals and one `INCORRECT_INFERENCE`. That incorrect row is now a refusal, for a
stated reason, and the one real recovery is unchanged.

## The negative control behaved correctly

`eslint-plugin-vue` was the test of whether the engine would manufacture another command. It did not:

```
install is not executable: missing "a pinned dependency basis (lockfile or packageManager field)"
```

It has neither a lockfile nor a `packageManager` field, so *any* install command is irreproducible — the
same command resolves differently over time, which is precisely how the original arborist crash happened.
The engine still **reports** `npm install` as its best belief; it refuses to let that belief be a plan.

That distinction — reportable but not executable — is the capability INFERENCE_01 lacked entirely.

## `jest-dom`: the graph now explains the wrapper

INFERENCE_01 found `npm run validate` and called it progress. INFERENCE_02 follows it:

```
SCRIPT_REFERENCE  validate → kcd-scripts validate
  UNRESOLVABLE: resolves to the wrapper `kcd-scripts`, whose behaviour is not defined in this repository
COMPOSITE_ACTION  bahmutov/npm-install
  UNRESOLVABLE: a third-party action; its steps are not in this repository and are not fetched
```

Both blockers are named, with evidence. Knowing the command is `npm run validate` is not the same as
knowing what executing it does, and the graph now says so instead of implying understanding.

## Confidence is derived, not assigned

`confidenceFromCompleteness` computes it: `OBSERVED` now requires that the command was seen verbatim
**and** every reference it depends on is resolved. Under INFERENCE_01 a plausible `npm install` could be
labelled `OBSERVED` while the thing that made it irreproducible went unrecorded.

Reference kinds are first-class nodes with evidence, resolution state and unmet requirements:
`LOCAL_ACTION`, `COMPOSITE_ACTION`, `REUSABLE_WORKFLOW`, `MATRIX_EXPANSION`, `SERVICE`,
`SCRIPT_REFERENCE`, `ENV_REFERENCE`, `EXECUTION_OPERATION`.

## The hard boundary, in code

```
incomplete causal execution path  ⇒  optimisable = false
```

`InferredPipeline.optimisable` is false when any non-checkout operation is non-executable, with
`optimisationRefusal` naming the operations and their missing requirements. A decision engine may read
`operations` for what the engine believes; only `optimisable` licenses acting.

## Configuration inference ≠ resource prediction

`ant-design`'s OOM is scored `INSUFFICIENT_EVIDENCE` with that stated explicitly. No amount of workflow
parsing predicts that a build will exceed 12 GiB. That is a runtime/resource learning problem and is
deliberately not folded into this benchmark's success measure.

## What is still wrong

- **`lint-staged` is judged optimisable while proposing `npm run typecheck`.** The engine has no notion
  that a job's *test* step matters more than its first executable step. It is not wrong about the
  command; it is wrong about which operation the pipeline is *for*.
- `vue-loader`'s refusal cites a reference id (`script-4`) rather than a sentence in the summary line.
- Matrices, services and reusable workflows are modelled as nodes and still not expanded.
- Third-party actions are `UNRESOLVABLE` by design; resolving them means fetching, which this step does
  not do.

## Provenance kept

Every INFERENCE_01 iteration is retained, **including the flattering 6/6**. Those are not embarrassing
intermediates — they are worked examples of an inference system becoming confidently wrong because its
evaluator was weak, which is exactly the failure mode the learning substrate must be able to recognise.
