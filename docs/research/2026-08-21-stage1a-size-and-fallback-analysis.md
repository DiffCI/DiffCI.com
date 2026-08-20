# Stage 1A — Phase 7 & 8: repository-size analysis and fallback-composition analysis

## Phase 7: does repository size predict poor performance independent of graph confidence?

**Scope note, stated honestly up front**: a full 20-repository graph-complexity dataset (node/edge
counts, dependency density for every repository) was not collected in this phase - that would require
a much larger forensic sweep than was practical within Stage 1A's time budget. What follows combines
Stage 0's existing `sourceFiles`-based size data (all 20 repositories) with the new forensic
graph-edge-count data gathered in Phase 3 (the 7 UNSAFE repositories, in depth) plus 4 additional
spot-check repositories chosen to be `COMPLETE`-confidence at both size extremes. This is a **partial**
answer to Phase 7's question, not a definitive one - stated as such throughout, not overclaimed.

### The confound, restated precisely

Stage 0's final report found small repos (`sourceFiles` below the corpus median) show 44.9% aggregate
reduction vs PATH, large repos show -0.95%. Cross-referencing against Phase 3's UNSAFE forensic data:
**all 7 fully-UNSAFE repositories are also in Stage 0's "large" bucket** (`date-fns`, `mikro-orm`,
`nestjs`, `execa`, `trpc`, `typeorm`, `unocss` all have above-median `sourceFiles`). This means Stage
0's own size split is measuring, in large part, the SAME thing as the UNSAFE/fallback-rate split - they
are not independent variables in this 20-repository sample.

### New data point: graph size among `COMPLETE`-confidence repositories only

Restricting to repositories that are NOT UNSAFE (so genuinely comparable - real graph-driven
selectivity, not blanket fallback), a small additional sample:

| Repository | `sourceFiles` (Stage 0 bucket) | Internal-source graph edges (this sample) | Agg. reduction vs PATH (Stage 0, full corpus) |
|---|---|---|---|
| `unjs/defu` | small | 6 | 7.5% |
| `pmndrs/zustand` | small | 63 | 25.5% |
| `unjs/unstorage` | large | 171 | 25.3% |
| `TanStack/query` | large | 0 (unrepresentative sample - see note) | 84.2% |

`TanStack/query`'s single sampled delta for this comparison happened to be an atypically small, early
commit in its history (near-empty graph) - not representative of the monorepo's actual current scale,
and excluded from the interpretation below rather than misused as if it were.

**The one clean, usable data point here is `unjs/unstorage`**: it is in Stage 0's "large" `sourceFiles`
bucket, has a real 171-edge graph, `COMPLETE` confidence, and shows a strong **25.3%** aggregate
reduction - closely matching `pmndrs/zustand`'s 25.5% (a "small" repository). **This is a real,
if single, counter-example to "size itself causes poor performance"**: a large-by-`sourceFiles`
repository with a genuinely `COMPLETE`, well-resolved graph performs just as well as a small one.

### Answer to Phase 7's central question

**Repository size, on its own, does not appear to be the causal factor** - `unjs/unstorage` is direct
evidence against that. What Stage 0's size split is much more likely measuring, per Phase 3's forensic
findings, is that **larger, more structurally complex codebases in this specific 20-repository sample
happen to correlate strongly with the specific UNSAFE-triggering patterns found in Phase 3**: monorepo
structures with nested tsconfigs and per-example path aliases (`trpc`), tsconfig scoped to declaration-
only validation (`execa` - notably, execa is NOT large by `sourceFiles`, showing this specific cause is
not itself a size effect), codegen/generated-file dependencies more common in larger, more tooling-heavy
projects (`unocss`, `mikro-orm`), and dynamic imports in more elaborate build tooling (`date-fns`). **Size
is a correlate/proxy for "more surface area for one of Phase 3's specific structural patterns to occur
somewhere in the repository," not an independent causal factor itself** - consistent with, and now
somewhat more precisely evidenced than, Stage 0's own explicit caveat that it "does not establish
DiffCI inherently fails on large repositories."

This remains a partial answer given the limited additional sample - a genuine Stage 1B/1C research task
would be to build the full 20-repository graph-complexity table Phase 7 originally called for, ideally
stratified explicitly by size AND by UNSAFE-cause-category, to fully separate the two variables.

## Phase 8: fallback-composition analysis

Every global fallback trigger was traced to its exact source in `src/repo/impact.ts` /
`src/git/git-diff.ts`. Classified per the task's exact framework - diagnosis only, no rules changed.

| Fallback reason | Instances (of 2,826 delta-reason pairs, 1,900-record dataset) | Exact trigger | Classification | Why |
|---|---|---|---|---|
| UNSAFE graph confidence | 600 | `graphResult.confidence === "UNSAFE"` | N/A - this is Phase 3's subject, not a rule to reclassify | See the taxonomy report |
| Config file changed | 686 | Any file matching `CONFIG_PATTERNS` (tsconfig, eslint, prettier, vitest/jest/playwright/webpack/rollup/postcss/tailwind/next config) **anywhere in the delta** - a boolean OR over ~15 root-anchored regexes, with zero content-diff awareness | `PROBABLY_REQUIRED` as a class, with a real `POTENTIALLY_OVERCONSERVATIVE` sub-case | These configs genuinely can have repo-wide blast radius (a tsconfig change can alter module resolution everywhere) - defensible as a default. But the rule cannot distinguish a trivial/comment-only change from a behavioral one; a content-aware refinement (diff the parsed config, not just "the file changed") is a real, scoped possibility. |
| Dependency manifest changed | 412 | Any change to the **root** `package.json` (regex `^package\.json$` - monorepo sub-package manifests are NOT covered by this specific rule) | `POTENTIALLY_OVERCONSERVATIVE` | `package.json` contains fields with zero behavioral effect (`description`, `keywords`, `author`, `homepage`, `license`, `contributors`, `bugs`, `repository`) alongside ones that matter (`dependencies`, `devDependencies`, `scripts`, `exports`, `main`, `type`). The task's own question - "could a metadata-only change be distinguished?" - has a concrete, safely-implementable YES: parse old/new JSON, diff only the behaviorally-relevant fields. |
| Lockfile changed | 325 | Any change to `package-lock.json`/`yarn.lock`/`pnpm-lock.yaml`/`bun.lockb`, no content diffing | `PROBABLY_REQUIRED` as currently implemented, `POTENTIALLY_OVERCONSERVATIVE` for a content-aware future version | For a single-package repo, a lockfile change genuinely does usually mean "some real dependency changed" - hard to safely narrow further without semantic lockfile diffing. For monorepos, the task's own question ("could lockfile changes be mapped to affected packages") is plausible in principle (workspace-aware lockfiles do record per-package resolution) but nontrivial to implement safely. |
| Workflow changed | 167 | Any change under `.github/workflows/` | `CLEARLY_REQUIRED` | The CI pipeline's own definition changed - DiffCI cannot safely reason about whether its test-selection logic remains valid under a modified pipeline without understanding the semantic change to the workflow itself, a substantially harder problem than dependency-graph analysis. Matches the task's own stated expectation. |
| Unknown/unrecognized changed file | 434 | Any file that `classifyChangedFile()` cannot categorize as source/test/asset/docs | `CLEARLY_REQUIRED` as a *default*, with a narrow `POTENTIALLY_OVERCONSERVATIVE` sub-case | "If we don't understand what this file is, don't guess" is a defensible default-safe posture. But the actual files landing here in this corpus (`.gitignore`, `.nvmrc`, `pnpm-workspace.yaml`, editor/tool dotfiles like `tea.yaml`, `.husky/pre-commit`) are overwhelmingly low-risk and could plausibly be added to a small, explicit "known-inert" allowlist without materially weakening safety. |
| Deleted source/asset | 202 | `changeType === "deleted"` **and** the file is not present in the HEAD-state graph (it can't be, by definition, once deleted) | `POTENTIALLY_OVERCONSERVATIVE`, with a concrete but costly fix path | Traced to the exact message: `"Deleted source/asset ... not present in HEAD dependency graph; legacy dependents cannot be determined"`. This is a genuine structural limitation of a HEAD-only graph, not a policy choice - DiffCI would need the file's PRE-deletion reverse-dependents, which requires a **base-state graph**, not just a head-state one. The task's own question ("could deleted files be handled using the base graph?") has a real, understood answer: yes in principle, at the cost of roughly doubling per-delta graph-construction work (building graphs at both `baseSha` and `headSha`, not just `headSha`) - a genuine engineering tradeoff, not a free win. |

### Summary judgment

Of the 6 non-UNSAFE-confidence fallback categories, **3 have a concrete, safely-scoped path to
narrowing without weakening the defensible cases** (dependency manifest - field-level diffing; unknown-
file - small inert allowlist; deleted-source - base-graph reverse-dependent lookup, at a real
performance cost), **1 has a real but harder-to-safely-implement path** (lockfile - workspace-aware
dependency-to-package mapping), and **2 are best left as broad rules given the genuine repo-wide blast
radius they can have** (config files generally, workflow changes) - though even config-file fallback
could benefit from content-diff awareness as a longer-term refinement. None of the 6 rules were changed
in this phase, per the task's explicit instruction.
