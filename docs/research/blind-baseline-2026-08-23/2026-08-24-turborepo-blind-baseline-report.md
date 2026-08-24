# DiffCI blind baseline — vercel/turborepo (2026-08-24)

Frozen DiffCI build (`gitHead` `8890e1a5`, `engineChecksum` `e0f20b722d880d59...`, verified MATCH before
and after this run), no repository-specific adaptation. Run on the `diffci-analysis-fanout` Cloudflare
Worker, `standard-4` containers, 6 shards / 6 concurrent, all 6 completed with zero errors, zero
resource kills, zero timeouts. 30/30 rows produced, all `ok: true`.

Manifest: `2026-08-23-turborepo-blind-baseline-selection-manifest.json` (30 most recent merged PRs on
`main` as of 2026-08-23T00:00:00Z, all 30 verified merged via the GitHub API, `mergeListSha256`
`cb900f8e...`). Raw rows: `2026-08-23-turborepo-blind-baseline-rows.jsonl`.

## Headline

Using a frozen DiffCI build with no repository-specific adaptation, DiffCI authorized selective
execution on **4 of 30** historical turborepo merges. Test-universe modeling was **incomplete** for
this repository, so even the 4 authorized merges should be read as "policy-safe within modeled tests,"
not production-safe — see below.

| Metric | Value |
|---|---|
| Merges analyzed | 30 / 30 |
| `SAFE_TO_PROPOSE` | 4 |
| `FALLBACK` | 26 |
| Median recognized tests | 106 (unit only - see gap below) |
| Median selected % (authorized merges) | 0.9% (1/106 in 3 of 4 cases) |
| Median analysis wall time | 3.0 s total / 2.0 s graph-build / 25 ms impact step |
| Errors / resource kills / timeouts | 0 |

## Test-universe completeness: INCOMPLETE

The frozen engine recognized **only 106 unit tests, in the `unit` family alone** - no `e2e`, `snapshot`,
or other family was found on any of the 30 merges. This repository's actual test surface is much larger
and mostly outside what the engine can see:

- **Majority-Rust codebase** (`Cargo.toml`/`Cargo.lock` workspace, `crates/`) - the engine has no Rust
  dependency-graph or test-discovery support at all (category: **missing language support**). Rust test
  files (`crates/turborepo/tests/graceful_shutdown_test.rs`, `crates/turborepo-lib/src/commands/ls.rs`,
  etc.) are invisible to it, and worse, changes to `.rs` files are classified `unknown` (see below) -
  triggering a safe fallback, but silently, not as a recognized-but-unaddressable test surface.
- **`turborepo-tests/` integration suite** (fixture-based, its own runner convention, referenced in the
  repo root listing) was not discovered as a test family at all - category: **missing test-family
  discovery**. Not investigated further in this pass (would need reading its actual invocation
  mechanism, deferred to the adapted-replay roadmap).
- The 106 unit tests found are real and correctly recognized (JS/TS side, `apps/`/`packages/` per
  `pnpm-workspace.yaml`), but they are a small fraction of this repository's actual CI surface.

**Conclusion: a `SAFE_TO_PROPOSE` verdict on this repository is "policy-safe within the ~106 modeled
unit tests," not evidence the full turborepo CI surface (Rust test suite, integration tests) would be
safe to skip.**

## Fallback-reason frequency (30 merges, non-exclusive)

| Reason | Merges |
|---|---:|
| Unknown changed file | 14 |
| Graph confidence UNSAFE | 10 |
| Config (root `package.json`/`tsconfig`/etc.) | 7 |
| Lockfile (`pnpm-lock.yaml`/`Cargo.lock`) | 6 |
| Deleted file, legacy dependents unknowable | 10 (individual deletions across several merges) |
| Workflow | 1 |
| Dependency manifest | 1 |

**Unknown-file dominant pattern: Rust source, by far.** 48 unknown-file instances across 14 merges; 27
are `.rs` files (the missing-language-support gap above, made concrete). The remainder are legitimately
unrecognized non-code conventions - nested `.gitignore`/`.npmrc`/`.vercelignore`/`pnpm-workspace.yaml`
inside example/fixture directories, and root `Cargo.lock`. None of the non-Rust unknowns look like a
fixable classification gap the same way `.i18n.yaml` was on deepseek-harness - they're genuinely
ambiguous (a fixture directory's own lockfile isn't this repo's dependency lockfile, for instance) and
the conservative fallback is correct behavior here, not a bug (category: **legitimate conservative
fallback**).

## Graph-confidence UNSAFE: systematic path-alias gap

10 of 30 merges hit `Dependency graph confidence is UNSAFE`. Every one of the sampled causes shows the
**same signature**: a large `path-alias` unresolved count (108-110 relevant unresolved imports per
merge) plus a handful of `relative-missing`/`relative-non-ts-asset`. This is far higher than anything
seen on deepseek-harness (which had 0-5 relevant-unresolved on its worst merges, all traced to one root
cause and fixed - see the companion deepseek reports). Turborepo's monorepo path-alias configuration
(likely `tsconfig` project references or a workspace-wide alias scheme across `apps/`/`packages/`) is
not being resolved by the frozen engine's alias handling at anywhere near the rate it resolves on
smaller/simpler repositories. Category: **general engine bug or unsupported build-system semantics**
(not yet root-caused to one specific config pattern the way the deepseek `?inline`-suffix fix was -
flagged for the adapted-replay roadmap, not fixed in this blind pass).

## The 4 authorized merges

PRs #13797, #13791, #13784, #13772 - each selected exactly 1 unit test out of 102-106 total, with no
fallback trigger present. Small, low-risk-looking diffs by file count (median changed files across all
30 merges: 9) that happened to avoid every fallback category. Given the test-universe gap above, treat
these as narrow existence proofs that the classification/selection machinery itself functions on this
repository, not as a representative "4/30 would have been safe to skip."

## Not yet done for this repository

- **Native Turbo comparison** (`turbo ls --affected` / `turbo run test --dry-run=json --affected` per
  merge) - not run in this pass. Needed to compare DiffCI's file/test-level selection against Turbo's
  own package/task-level affected-graph for the same commit pairs, and to state plainly where the two
  are and aren't comparable (granularity differs; DiffCI is not "better" merely for selecting individual
  tests where Turbo selects whole tasks).
- **Full Phase 1 feasibility inventory** (build system, exact test-runner invocation for
  `turborepo-tests/`, CI workflow job structure) - only partially inventoried (languages, root config
  files, workflow names) before this run; not written up as its own document.

Both are open items for the adapted-replay roadmap, not implemented here.
