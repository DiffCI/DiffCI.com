# DiffCI blind multi-repository baseline — cross-repository aggregate (2026-08-24)

Frozen DiffCI build: `gitHead` `8890e1a5`, `engineChecksum` `e0f20b722d880d59775ab79453d4d214fa944d5b197d3ab76330abc90f77bdd3`,
typecheck clean, 908/908 local tests, `verify-frozen-engine.cjs` MATCH confirmed repeatedly across this
entire run (before/after every deploy, every pack, every collect). No policy, classification, test
pattern, graph-confidence, or engine change was made between or during any of the four holdout runs.
Full build manifest: `2026-08-23-diffci-frozen-build-manifest.json`.

**deepseek-ai/deepseek-harness is DiffCI's development repository and is explicitly excluded from the
holdout count below.** It was used only as the environment-parity check
(`2026-08-24-deepseek-harness-environment-parity-report.md`: 30/30 rows match the local
correctness-complete replay exactly) - proof the Cloudflare container environment does not change the
frozen engine's behavior versus local execution, run before any holdout.

**Fifth target repository: unresolved, per instruction.** The original task said to search existing
plans/records for "the fifth repository previously selected for this benchmark portfolio" and, if not
explicitly recorded, not substitute one silently. No such record was found anywhere in this repository's
`docs/`, memory files, or prior research documents (searched explicitly at the start of this task).
**This requires user confirmation** before a fifth repository is run. The four repositories below are
complete.

## Blind generalization result (lead line)

Using a frozen DiffCI build with no repository-specific adaptation, **DiffCI produced a real analysis
verdict on 61 of 120 historical merges across 4 repositories (turborepo 30/30, biome 0/30, cal.com
0/30, nx 30/30), and authorized selective execution on 11 of those 61** (turborepo 4, nx 7). Test-
universe modeling was **complete for 0 of the 4 repositories and incomplete for all 4** - so none of
the 4 are yet candidates for execution-level safety validation without further engine work. Two
repositories (biome, cal.com) produced **zero** verdicts at all, blocked by a single, now-understood,
generalizable engine defect (missing root `tsconfig.json` handling). Even where verdicts were produced,
a distinct, higher-severity correctness bug was found on nx (and confirmed on a second repository,
deepseek-harness) that silently under-selects on test-only changes.

## Portfolio table

| Repository | Merges | Real verdicts (`ok:true`) | `SAFE_TO_PROPOSE` | `FALLBACK` | Median selected % (SAFE only) | Median recognized tests | Median graph-build | Median total wall | Blocking issue |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---|
| vercel/turborepo | 30 | 30 | 4 | 26 | 0.9% | 106 | 2.0 s | 3.0 s | - |
| biomejs/biome | 30 | **0** | - | - | - | - | - | - | **tsconfig crash (30/30)** |
| calcom/cal.diy | 30 | **0** | - | - | - | - | - | - | **tsconfig crash (25/30) + git-lock race (5/30)** |
| nrwl/nx | 30 | 30 | 7 | 23 | **0.0%** | 502-505 | 7.9 s | 9.1 s | - |
| **Portfolio (verdicted only)** | **120** | **61** | **11** | **50** | - | - | - | - | - |

**Do not average the selected percentages across repositories** - turborepo's 0.9% and nx's 0.0% are
each medians over very different, small (4 and 7), possibly-unrepresentative SAFE samples, computed
over different-sized test universes (106 vs. ~500), and (see below) nx's entire SAFE sample is
independently suspect due to the test-self-selection bug. A blended "portfolio selection rate" number
would misrepresent both repositories and is deliberately not reported.

## Test-universe completeness: incomplete for all 4 (0/4 complete)

| Repository | Assessment |
|---|---|
| turborepo | Only 106 unit tests found; Rust test suite (majority of the codebase) and the `turborepo-tests/` fixture-based integration suite both invisible. |
| biome | Not assessable - no analysis completed. |
| cal.com | Not assessable - no analysis completed (the repository best positioned to exercise the correctness-complete engine's newer capabilities never got the chance to). |
| nx | Only 502-505 unit tests (Jest) found; E2E suite (`e2e-matrix.yml`) and Nx's own executor-based test model both outside what was discovered. |

**No repository in this portfolio is a valid candidate for execution-level safety validation yet** -
per the task's own rule, a `SAFE_TO_PROPOSE` verdict against an incomplete test universe is
"policy-safe within modeled tests," never "production-safe."

## Findings that generalized across multiple repositories

1. **Missing/incomplete root `tsconfig.json` crashes the engine entirely (biome, cal.com - 2/4
   repositories, 55/60 of their combined merges).** `createProgram()` (`src/repo/graph.ts:351`) throws
   an uncaught exception instead of falling back when no tsconfig is discoverable at the repository
   root. Confirmed on two structurally different repositories: a ~90%-Rust project with a thin JS
   wrapper (biome) and a large, mainstream, overwhelmingly-TypeScript Next.js/Turbo monorepo (cal.com) -
   the common trait is **per-package `tsconfig.json` with none at the root**, an extremely common
   real-world monorepo layout. **Category: general engine bug. Highest-impact fix available** - would
   likely unlock a large fraction of real-world monorepos this benchmark generation cannot currently
   analyze at all.
2. **A directly-modified test file is never selected to run unless another file depends on it (nx,
   confirmed independently on deepseek-harness).** Traced to `processChangedPath()`/`processSourceChange()`
   in `src/repo/impact.ts` having no "the changed file IS itself a test -> select it" branch - only
   transitive dependents of a changed file are checked, and a leaf test file has none. Directly observed:
   nx PR #36723, a single-file test-only change, produced `SAFE_TO_PROPOSE` with `affectedTests: 0`. Rare
   in real PR samples (1/30 on both nx and deepseek-harness) because most PRs touch source and test
   together, which masks it - but confirmed reproducible on two unrelated repositories. **Category:
   general engine bug, high severity** - unlike the tsconfig crash (fails loud) or graph-UNSAFE (fails
   safe/conservative), this one **fails unsafe**: a confident SAFE verdict with zero coverage of the
   exact file that changed. Recommended as the top-priority fix, ahead of the tsconfig crash.
3. **Missing-language-support gaps recur wherever a repository has substantial non-JS/TS surface**
   (deepseek-harness: none observed - pure TS/JS; turborepo: Rust `crates/`; biome: Rust `crates/`).
   Manifests as `.rs` files (and similar) landing in the `unknown` category, correctly triggering a
   conservative FALLBACK rather than a wrong verdict - safe, but means DiffCI currently offers zero
   selection value on the non-JS/TS portion of any polyglot repository.
4. **Fixture/snapshot ownership only recognizes one directory convention.** The deepseek-harness work
   (Phase 3) built `tests/<snapshots|fixtures>/` ownership; nx's Jest snapshots use the ecosystem's more
   common **sibling `__snapshots__/` next to the source `.spec.ts`** convention, which the current
   resolver does not recognize at all (24 `.snap` files landed as `unknown` on nx). Category: missing
   fixture/companion ownership - a well-scoped, likely-simpler follow-up than the `tests/` case (owner
   is always the same-named spec file one directory up).

## Findings that were repository-specific (did not generalize, or not yet checked elsewhere)

- turborepo's severe path-alias graph-UNSAFE signature (108-110 relevant-unresolved imports per
  affected merge, 10/30 merges) - far larger than anything seen elsewhere (nx's graph-UNSAFE merges had
  only 1 relevant-unresolved each). Not yet root-caused to a specific alias pattern; flagged, not fixed.
- nx's `.mdoc` (Markdoc) documentation extension and `__tmpl__` generator-template file conventions -
  plausible, low-risk generalizable fixes for the first (treat as a documentation extension) but
  currently only observed on nx.
- cal.com's `git checkout` `.git/index.lock` race (5/30 merges) - a fan-out **harness** issue (not
  engine, not DiffCI logic), not reproduced on the other three repositories' runs, not root-caused.

## Analysis overhead

Both repositories that produced real verdicts show graph-build time scaling with codebase size, as
expected: turborepo (106 tests found, smaller JS surface) at 2.0 s median graph-build vs. nx (502-505
tests, ~32 MB TypeScript) at 7.9 s median - both well within the containers' step budgets, both on
`standard-4` (4 vCPU / 12 GiB / 20 GB disk, the largest predefined Cloudflare Containers instance type).
No resource kill, timeout, or OOM occurred on ANY of the 120 analyzed merges across all four
repositories, at any concurrency level actually used in a completed run (6 concurrent shards per
repository, sequential across repositories - see the infrastructure note below).

## Native affected-system comparison: not completed this pass

Turbo (`turbo ls --affected` / `turbo run test --dry-run=json --affected`) and Nx (`nx show projects
--affected`, `nx affected -t test`) comparisons were planned but not run in this pass - both require
installing each tool's own dependencies inside the analysis container within a shard's step budget,
which was not attempted here given the volume of infrastructure and correctness work already surfaced.
Flagged as the top follow-up for turborepo and nx specifically (see roadmap).

## Infrastructure note (harness, not engine - included for completeness, not as a DiffCI finding)

The first attempt ran all four repositories concurrently (40 shards, `maxConcurrentShards: 40`) and hit
a Cloudflare Containers burst-provisioning limit - 32 of 40 shards failed to start with "the sandbox
container stopped while the operation was pending," correlated with release order, not repository size
or memory. Preserved as evidence (`2026-08-24-attempt1-40concurrent-run-state-FAILED.json` and per-repo
`*-attempt1-partial-40concurrent-FAILED.jsonl` files) and never merged into the canonical results above.
Re-run one repository at a time, 6 concurrent shards each, all four completed cleanly at the container
level. This is a Cloudflare Containers scheduling characteristic, not a DiffCI engine finding, and does
not affect any verdict reported above.

## Categorized discovery summary

| # | Category | Findings |
|---|---|---|
| 1 | General engine bug | tsconfig-crash (biome, cal.com); test-self-selection gap (nx, deepseek) |
| 2 | Missing language support | Rust (deepseek n/a, turborepo, biome) |
| 3 | Missing test-family discovery | turborepo (`turborepo-tests/`), nx (E2E/executor model), biome/cal.com (not assessable) |
| 4 | Missing fixture/companion ownership | nx sibling `__snapshots__/` convention |
| 5 | Unsupported build-system semantics | turborepo path-alias graph-UNSAFE signature (not root-caused) |
| 6 | Legitimate conservative fallback | turborepo non-Rust unknown files (nested lockfiles/gitignores in fixtures); nx generator `__tmpl__` files |
| 7 | Execution/environment limitation | cal.com git-lock race (harness); the 40-concurrent burst-provisioning limit (infrastructure) |
| 8 | Repository-specific convention | nx `.mdoc` docs extension |

## Recommendation: does the evidence support proceeding to executed validation?

**Not yet, for any of the four repositories as currently modeled.** Two are fully blocked (biome,
cal.com) by one fixable engine defect; the two that produced verdicts (turborepo, nx) both have
incomplete test-universe modeling, and nx's entire SAFE sample is compromised by the test-self-selection
bug until it is fixed. The recommended sequence, in priority order:

1. Fix the test-self-selection gap (highest severity - fails unsafe, confirmed on 2 repositories).
2. Fix/harden the tsconfig-discovery crash (highest reach - unlocks 2 of 4 repositories entirely, likely
   generalizes further).
3. Re-run all four repositories' blind manifests unchanged (same `mergeListSha256`) as an **adapted
   replay** (explicitly labeled, original blind rows permanently preserved) to measure the effect.
4. Only then consider execution-level validation (real full-vs-selected test runs), and only on
   repositories whose test-universe modeling is assessed complete at that point.
5. Resolve the fifth-repository question with the user before any further portfolio expansion.
