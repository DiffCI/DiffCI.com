# Stage 0 full experiment — corpus selection (2026-08-21)

Written before running any of the 10 new candidates, per the spec's explicit requirement. 20 primary
repositories + 2 backups, targeting ~100 deterministic commits each for ~2,000 total analyzed deltas.

## Kept unchanged from the medium batch (10 repositories)

Per "Keep known negative/weak cases where they are valid members of the corpus. Do not remove trpc
merely because DiffCI performs worse than PATH there" - all 10 repositories the medium batch actually
analyzed are kept exactly as-is, including the two known-negative/known-unreliable cases:
`sindresorhus/execa` (100% mandatory fallback - a real, valid negative case, not excluded) and
`trpc/trpc` (100% UNSAFE graph confidence, negative aggregate result vs PATH - explicitly NOT removed).
`sindresorhus/ky`'s test-count metrics remain excluded from aggregate/opportunity calculations for the
same reason established in the medium batch (AVA-convention test files, not fixed).

## New candidates (10 repositories)

Chosen purely for structural diversity against dimensions not yet well-represented in the 10 kept
repositories, and to close a real gap in the ORIGINAL 20-repository corpus.json (`honojs/hono`, which
was only ever analyzed by the 2026-08-19 local pilot, never the real Cloudflare pipeline). None chosen
because DiffCI was expected to win on them.

| Repo | Structural role |
|---|---|
| `honojs/hono` | Closes the original corpus gap; medium web framework. |
| `nestjs/nest` | Large TS application framework - broader PATH mapping and monorepo-adjacent structure than anything in the kept 10. |
| `typeorm/typeorm` | Large single-package ORM - deep dependency structure. |
| `TanStack/query` | Large TS monorepo, likely project references, different CI/test-framework structure. |
| `date-fns/date-fns` | Huge small-unit-test-suite library (traditionally one test file per exported function) - the narrowest, deepest structure in the corpus. |
| `mikro-orm/mikro-orm` | Medium ORM, different domain from typeorm for a same-category comparison point. |
| `unjs/unstorage` | Third `unjs`-family repo - tests whether the org's analyzability pattern (h3, ofetch, defu all graph-capable) holds for a fourth. |
| `unocss/unocss` | TS monorepo utility/framework - different GitHub Actions structure expected (matrix builds typical for a CSS engine). |
| `pmndrs/valtio` | Third `pmndrs`-family repo - same org-consistency check as unstorage. |
| `redis/ioredis` | Single-package TS database client - a domain (database drivers) not yet represented. |

## Backups (2 repositories)

`sindresorhus/got` and `remeda/remeda` - used only if a primary candidate is excluded (no root
`tsconfig.json`, unsupported language, or size limits), following the exact same "documented backup,
not a post-hoc replacement" pattern the medium batch used for `vitest`/`react-router`.

## What is explicitly NOT being done

Same constraints as the medium batch, restated: no expansion of language support, no tsconfig-less-JS
support, no AVA-convention test-discovery fix, no graph-confidence tuning for `trpc`-shaped monorepos -
all preserved as known capability gaps, not patched to inflate corpus coverage or the headline numbers.

## Target

20 repositories x ~100 commits = ~2,000 candidate deltas. Given the medium batch's own resumability
already covers all 10 kept repositories' first ~65 commits each, the incremental NEW analysis work for
this experiment is smaller than a naive 2,000-delta estimate - real telemetry (not a re-derived
estimate) will be reported per gate.
