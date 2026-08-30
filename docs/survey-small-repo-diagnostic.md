# Why DiffCI declined to narrow on the three small repositories

**Non-canonical post-result diagnostic.** Developer host, Windows, node v24.16.0. Same agent bytes
(`sha512-mlNTeK…`, generation B), same pinned commits, same 25 candidates.

**Valid for exactly one question:** what did the already-frozen selector decide, and with what `mode`,
`reason` and `selected/total`. **Not valid for** CPU, wall time, reproducibility, qualification, safety
or economics, and used for none of them.

## The finding

> **DiffCI requires a `tsconfig.json`.** Without one it refuses at the eligibility stage, before any
> graph is built.

Verbatim from the observation report:

```
status: REFUSED
stage:  eligibility
reason: DiffCI can only analyse TypeScript/JavaScript projects today: no tsconfig.json
        anywhere in the repository - there is no TypeScript project to build a graph from
```

## The 75 decisions

| repository | `tsconfig.json` | decisions | selected |
|---|---|---|---|
| `webpack/css-loader` | **absent** | 25 REFUSED | — |
| `prettier/eslint-config-prettier` | **absent** | 25 REFUSED | — |
| `kentcdodds/cross-env` | present | 12 FULL, 3 SELECTIVE, 10 REFUSED | **0/4 on all three SELECTIVE** |

cross-env's ten refusals are its oldest candidates, from before a `tsconfig.json` existed in the tree.
Its three SELECTIVE decisions carry `SAFE_TO_PROPOSE` and select **zero of four** test files — which is
why the `no-candidates` guard fired: SELECTIVE, but with an empty selection.

**Realised optimisation opportunity is zero on all three, for two distinct reasons** — ineligible for
analysis, or eligible and selecting nothing.

## Local and canonical agree

This diagnostic ran on a developer host, so agreement with the canonical runs matters:

| repository | canonical (container) | local (this diagnostic) |
|---|---|---|
| css-loader | 25 observations, none SELECTIVE with a non-empty selection | 25 REFUSED |
| eslint-config-prettier | same | 25 REFUSED |
| cross-env | same | 12 FULL / 3 SELECTIVE at 0 selected / 10 REFUSED |

Every canonical run reached the same conclusion the local runs explain. The diagnostic adds the
*reason*, not a different answer.

**One confound found and removed:** the first local pass ran without installed dependencies and returned
`REFUSED` everywhere, which would have been the wrong explanation. After `npm ci`, css-loader still
returned 25/25 REFUSED — so the install was never the cause, and the `tsconfig` requirement is.

## Why this reframes the survey

The survey's six gates test **the harness**: can it find a runner, run from the root, address files by
name, get a green baseline, read a file count. None of them ask **whether DiffCI's analyser will accept
the repository at all.**

That gate exists, it is upstream of all six, and it was never measured. Two of the five repositories
that passed *every* survey gate are refused outright by the analyser.

So the assessment reach rate of **5/34 is optimistic.** On the evidence here, at most 3 of those 5 can
produce any selection, and one of the three selects nothing.

## What it does not say

- **Not a size effect.** css-loader has 625 tests and is refused; cross-env has 63 and is eligible. The
  variable is `tsconfig.json`, not scale — the "selectable structure, not size" reading, and more
  specific than expected.
- **Nothing about prettier or ts-jest.** Both **do** have a `tsconfig.json` at their pinned commits, so
  the economics experiment on the two workloads that carry the economic information remains meaningful.
- **Nothing about safety or economics** anywhere. No mutation ran and no suite was executed.

## Status

Diagnostic complete. The three failed economics runs (`se-css-loader-01`,
`se-eslint-config-prettier-01`, `se-cross-env-01`) stand as recorded and are **not** re-run: their
canonical observations already established 25/25 non-selective each.
