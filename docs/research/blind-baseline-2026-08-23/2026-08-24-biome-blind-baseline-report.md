# DiffCI blind baseline — biomejs/biome (2026-08-24)

Frozen DiffCI build (`gitHead` `8890e1a5`, `engineChecksum` `e0f20b722d880d59...`, verified MATCH before
and after this run). Run on `diffci-analysis-fanout`, `standard-4`, 6 shards / 6 concurrent, all 6
shards reached `done` with zero container-level errors, zero resource kills, zero timeouts - **but every
one of the 30 individual per-merge analyses inside those shards failed.**

Manifest: `2026-08-23-biome-blind-baseline-selection-manifest.json` (30 most recent merged PRs on `main`
as of 2026-08-23T00:00:00Z, all 30 verified merged via the GitHub API, `mergeListSha256`
`ca458715bd8b0716...`). Raw rows: `2026-08-23-biome-blind-baseline-rows.jsonl`.

## Headline

**No blind-baseline verdict was produced for this repository.** Using a frozen DiffCI build with no
repository-specific adaptation, DiffCI failed to complete analysis on 30 of 30 historical biome merges -
not from a container/resource problem, but from an **unhandled engine exception**, uniformly:

```
Error: No tsconfig.json found in /workspace/biomejs__biome
    at createProgram (/opt/diffci/src/repo/graph.ts:351:11)
    at buildDependencyGraph (/opt/diffci/src/repo/graph.ts:512:77)
```

All 30 rows: `ok: false`, `errorClass: "exit:1"`, identical error message. Median harness wall time
4.4 s (i.e. it fails fast, consistently, not intermittently or under load).

## Root cause

`biomejs/biome`'s repository root genuinely has **no `tsconfig.json`** - confirmed directly from the
repo's root file listing: `.biome.json`, `Cargo.toml`, `Cargo.lock`, `package.json`,
`pnpm-lock.yaml`/`pnpm-workspace.yaml`, `justfile`, `crates/`, `packages/`, `plugins/`, `xtask/` - no
`tsconfig.json` at the top level. The repository is ~90% Rust (a Cargo workspace under `crates/`) with a
thin JS/TS layer, likely with its own `tsconfig.json` files inside individual `packages/*/` directories,
never at the root. `buildDependencyGraph()` -> `createProgram()` (`src/repo/graph.ts:351`) requires
finding a tsconfig at (or discoverable from) the repository root and **throws an uncaught error when it
cannot**, which propagates all the way out of `scripts/diffci-benchmark-external.ts`'s `main()` and
crashes the whole analysis for every commit pair - there is no fallback path.

## Category

**General engine bug** (primary) - a conservative engine should treat "no discoverable root TypeScript
project" as a `FALLBACK`/full-validation condition (or, if the repository has zero JS/TS surface,
something like "not statically addressable"), not an unhandled exception that prevents ANY verdict,
including on merges that never touch a `.ts`/`.js` file at all. Compounding: **missing language
support** (Rust, the repository's actual majority language, has no dependency-graph/test-discovery
support at all - see the deepseek-harness and turborepo reports for the same gap in smaller doses).

**UPDATE - this GENERALIZES:** the same exact `createProgram` exception, same message shape, hit
**calcom/cal.diy** as well (25 of its 30 merges - see `2026-08-24-calcom-blind-baseline-report.md`) - a
large, overwhelmingly TypeScript, mainstream monorepo with no Rust involvement at all. The common trait
is not "Rust project" but **"per-package `tsconfig.json`, no root `tsconfig.json`"** - a very common
real-world monorepo layout. 2 of the 4 blind holdout repositories were entirely blocked by this one
code path. This raises the priority of item 1 in "What would need to change" below considerably.

Per the task rules, this was **not fixed** during the blind pass - documented as a finding for the
adapted-replay roadmap and the limitations/capability-gap matrix.

## Test-universe completeness: NOT ASSESSABLE

No analysis completed, so nothing about biome's actual test surface (inline `#[cfg(test)]` Rust unit
tests, integration tests, `insta` snapshot tests, fixture-based formatter/analyzer tests referenced in
`.github/workflows/pull_request*.yml`, or any JS-side tests under `packages/`) could be evaluated this
pass. Per the original brief's own rule ("Investigate whether the frozen engine understands... Do not
add Rust support during the blind baseline"), this is recorded as the expected outcome of running an
engine with no Rust support against an overwhelmingly-Rust repository, compounded by the tsconfig crash
blocking even the JS-side subset.

## What would need to change to get a real result here (not implemented)

1. `createProgram`/`buildDependencyGraph` should catch "no root tsconfig" and return a result the caller
   can turn into `FALLBACK` (or a new explicit "no TypeScript project detected" status), not throw.
2. Separately, whether to search `packages/*/tsconfig.json` for a per-package project (closer to what a
   real multi-package repo with no root tsconfig would need) is a design question, not a one-line fix -
   flagged for the roadmap, not decided here.
3. Rust support remains entirely out of scope for this benchmark generation.

## Not yet done for this repository

Native-tooling comparison (biome doesn't have a Turbo/Nx-equivalent affected-graph tool to compare
against) and the full Phase 1 feasibility inventory write-up are both deferred - moot until item 1 above
is addressed, since no per-merge DiffCI output exists to compare against anything.
