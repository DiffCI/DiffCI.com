# Stage 0 medium-batch corpus selection (2026-08-21)

Written before running any of the new candidates, per the medium-batch spec's explicit requirement:
"Document the selection criteria before looking at benchmark results." Repositories were NOT chosen
because DiffCI was expected to win on them - selection is purely structural/diversity-driven.

## Constraint

The spec explicitly forbids expanding language support or tsconfig-less-JS support to hit the
repository count: "Do NOT add Python/Go/Rust/Java support merely to satisfy the repository count. Do
NOT implement tsconfig-less JavaScript support merely to increase the benchmark population." So the
candidate pool is TypeScript/JavaScript repositories with a root `tsconfig.json` only - the current
product's actual, honest capability boundary, not an expanded one.

## Kept from the previous larger study

Per "Keep existing valid repositories unless there is a legitimate exclusion reason" - all 6 repos that
were real, graph-capable analyses in the 2026-08-20 larger study are kept unchanged:
`axios/axios`, `pmndrs/jotai`, `pmndrs/zustand`, `sindresorhus/ky`, `unjs/h3`, `unjs/ofetch`.

## New candidates and their selection rationale

Six new candidates, chosen for structural diversity against the six proven repos (all of which are
small-to-medium single-package libraries) - specifically targeting dimensions the spec calls out:
"small/medium/larger test suites; libraries/frameworks; single-package repos; monorepo-like structures;
project references where supported; shallow/deep source trees; different test layouts; different
GitHub Actions structures; narrow and broad PATH mappings."

| Repo | Structural role |
|---|---|
| `colinhacks/zod` | Single-package, but deep/nested source tree (locale files, versioned `v3`/`v4`-style subdirectories) and a medium-to-large test suite - depth counterpoint to the mostly-shallow proven set. |
| `sindresorhus/execa` | Single-package, shallow source tree, small test suite - deliberate counterpoint to zod's depth, keeps a "small library" structural class represented among the new additions. |
| `trpc/trpc` | TS monorepo (pnpm workspaces) - the study's first attempt at "monorepo-like structure" and "project references where supported"; broader PATH mapping expected across multiple packages. |
| `vitest-dev/vitest` | TS monorepo (`packages/*`) - second monorepo/project-reference target, different GitHub Actions structure expected (matrix testing across Node versions is standard for a testing framework's own CI). |
| `unjs/defu` (backup) | Tiny single-package utility, minimal test suite - only used if a primary candidate is excluded, to keep a "very small" structural class represented. |
| `remix-run/react-router` (backup) | Large TS monorepo, broad PATH mapping - only used if a primary candidate is excluded. |

12 candidates total (6 proven + 4 primary new + 2 backup), targeting **at least 10 successfully
analyzable** per the spec. `trpc` and `vitest` are monorepos and may not have a root `tsconfig.json`
(some monorepos only carry per-package configs) - if either is excluded on that basis, that is itself a
legitimate, reportable finding (not a reason to retroactively swap it out), and one or both backups
cover the resulting gap. No candidate will be added or removed after seeing its actual analysis result.

## What is explicitly NOT being done

- Not adding Python/Go/Rust/Java repositories to pad the count.
- Not modifying `src/repo/graph.ts`'s tsconfig-root-only requirement to admit tsconfig-less JS repos.
  The tsconfig-less-JS gap (`express`, `fastify`, `kleur`, all excluded in the larger study) is a real
  product/generalization limitation, reported separately in the medium-batch report, not patched around.
