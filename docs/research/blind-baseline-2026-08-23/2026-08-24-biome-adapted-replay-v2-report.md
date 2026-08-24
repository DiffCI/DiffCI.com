# DiffCI ADAPTED REPLAY v2 — biomejs/biome, test-visibility fix (2026-08-24)

Builds on the v1 adapted replay (`2026-08-24-biome-adapted-replay-report.md`: crash fixed, but
`totalTestsInGraph: 0` on every merge). This run adds one more targeted fix and re-tests biome
specifically. Adapted manifest v2 (`2026-08-24-diffci-adapted-build-manifest-v2.json`, `engineChecksum`
`f6fd3ec007181beb...`), typecheck clean, 990/990 local tests. Same 30 merges, `standard-4`, 6/6 shards,
zero errors. Raw rows: `2026-08-24-biome-adapted-replay-v2-rows.jsonl`.

## The fix

Root cause (confirmed empirically, not guessed): biome's per-package tsconfigs **deliberately exclude
their own test directory** from the TypeScript program - verbatim from
`packages/@biomejs/js-api/tsconfig.json`: `"exclude": ["./tests", "./dist"], "include": ["./src"]`.
`totalTestsInGraph` is driven purely by the TS program's own file list (`createProgram()`), which never
includes files a package's tsconfig excludes - no amount of nested-tsconfig *discovery* (the v1 fix)
changes that, because the exclusion is honored correctly once a config is found. Source-root discovery
itself was already correct (a 2026-08-21 fallback already lists `packages`/`crates` as roots for this
monorepo shape) and `profile.testFilePaths` (the separate, tsconfig-agnostic glob walk) already found
the test files - the graph just never incorporated what that walk found.

**Fix**: `src/repo/graph.ts` now unions `profile.testFilePaths` into the graph's node set after program
extraction, for any test file not already present, as a leaf node (`isTest: true`, no dependency edges
- honestly absent, not fabricated, since the type-checker was never asked to resolve that file's
imports). Reproduced and fixed against biome's exact real tsconfig shape before touching biome data;
4 focused tests added, including one that proves the exact same repo's `.rs` files remain completely
untouched (not Rust support).

## Result

| | v1 (crash fixed only) | v2 (+ test visibility) |
|---|---|---|
| `ok: true` | 30/30 | 30/30 |
| `totalTestsInGraph` | **0 on every merge** | **12 on every merge** |
| `SAFE_TO_PROPOSE` | 2 (vacuous, 0/0) | 2 (same PRs, now 0/12 - still 0 selected, but a real, non-vacuous universe) |

The JS/TS test universe biome's own build deliberately hides from its type-checker (bindings/API
packages: `js-api`, `backend-jsonrpc`, `prettier-compare`, `tailwindcss-config-analyzer`) is now visible
- 12 real tests, consistently across all 30 merges. Neither `SAFE_TO_PROPOSE` merge (#11449, #11410)
selects any of them (their diffs don't touch this thin JS layer at all - most of biome's real
development activity is in `crates/`), so the SAFE count is unchanged, but this is now an honest "0 of
12 relevant" rather than the previous meaningless "0 of 0."

## Explicit scope statement (per instruction: do not mistake this for full Rust support)

**This fixes JS/TS test visibility only.** Biome's actual test suite - the overwhelming majority of its
real CI surface - is Rust: `cargo test`, `insta` snapshot tests, and fixture-based
formatter/analyzer/parser tests under `crates/*/tests/`. None of that is modeled, none of it was
touched by this fix, and none of it is claimed to be. 12 JS tests found versus biome's real Rust test
count (thousands, per its CI workflow structure) makes the scope of what remains unaddressed
unmistakable. Rust support remains entirely out of scope for this benchmark generation, exactly as
stated in every prior report on this repository.

## Conclusion

A real, verified, narrowly-scoped fix, working exactly as designed - test-universe visibility restored
for the JS/TS surface a tsconfig-exclude convention was hiding, with zero new false positives (Rust
untouched, confirmed by test) and zero fabricated dependency information (leaf nodes only).
