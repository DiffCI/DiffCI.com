# Stage 1A — Phase 2/3: UNSAFE taxonomy and forensic analysis of the 7 fully-UNSAFE repositories

## Phase 2: semantic taxonomy of `COMPLETE` / `PARTIAL` / `UNSAFE`

Source: `computeConfidence()`, `src/repo/graph.ts:751-777`. Five rules, checked in this exact priority
order (first match wins):

```
1. sourceFileCount === 0                    → UNSAFE
2. integrityCriticalCount > 0                → UNSAFE
3. dynamicUnresolvedCount > 0                 → UNSAFE
4. unresolvedCount > 0                        → UNSAFE
5. resolvedViaProjectReferences               → PARTIAL
   (otherwise)                                → COMPLETE
```

**What each condition means semantically, not just the branch name:**

1. **`sourceFileCount === 0`** - the graph builder found zero TypeScript/JavaScript source files under
   the discovered source roots. A deliberate fail-safe: an empty graph has nothing to flag as unresolved
   and would otherwise fall through to the confidently-wrong "COMPLETE" (per the code's own comment).
   Not observed as a real cause in any of the 7 UNSAFE repositories investigated - all have thousands of
   real source files.

2. **`integrityCriticalCount > 0`** - the graph's own internal self-consistency check
   (`validateDependencyGraph()`) found a structural defect in the constructed graph itself: a forward/
   reverse adjacency-list mismatch, a node with an empty or malformed (backslash-containing) path. This
   is a defensive check against bugs in graph CONSTRUCTION, not a property of the source code being
   analyzed - not observed as a cause in any of the 7 repositories.

3. **`dynamicUnresolvedCount > 0`** - at least one `import()`/`require()` call site uses a **non-
   literal** specifier (a template literal with an interpolated expression, a variable, string
   concatenation) that cannot be resolved to a specific file at static-analysis time by construction -
   the actual target depends on a runtime value. This is checked and disqualifies the ENTIRE repository
   graph's confidence, regardless of how many other imports resolved cleanly, and regardless of whether
   the dynamic-import file is anywhere near the changed files in a given delta.

4. **`unresolvedCount > 0`** - a **statically-analyzable** specifier (one TypeScript's own
   `ts.resolveModuleName()` was given a real, literal string for) still could not be mapped to an actual
   file. Crucially - traced precisely via `classifySpecifier()` (`graph.ts:361-373`) - this only applies
   to specifiers classified as `relative` (`./`, `../`), `absolute` (`/`), or `alias` (`@/`, `~/`, `#`
   prefixes specifically - the common Next.js/webpack/Node-subpath-import alias conventions). **A bare
   scoped-package-style specifier like `@nestjs/common` or `@myorg/core` is classified as `"package"`
   (the catch-all default) and is NEVER counted toward `unresolvedCount`, even if TypeScript's resolver
   fails to resolve it** - it silently falls through to `external-package` instead. This is a genuinely
   important, non-obvious finding: **workspace-package imports written as bare npm-style specifiers
   cannot, by this code's own design, ever be the direct cause of an UNSAFE verdict** - only relative
   paths, absolute paths, or the specific `@/`/`~/`/`#` alias conventions can.

5. **`resolvedViaProjectReferences`** - at least one import was resolved using TypeScript's project-
   references mechanism (a `tsconfig.json` with a `references` array pointing at sub-project
   `tsconfig.json`s). The code's own comment explains why this caps at `PARTIAL` rather than `COMPLETE`:
   project-reference resolution merges multiple sub-projects' compiler options into one best-effort
   approximation, not the exact per-sub-project settings TypeScript itself would use.

## Forensic findings across all 7 fully-UNSAFE repositories

Method: a new read-only forensic tool (`scripts/cloudflare-forensic-graph.ts`, dispatched via a new
`/v1/forensic/graph-diagnose` Worker route, 7 repositories run concurrently across the provisioned
Cloudflare fleet) runs the real `runDiffCIAnalysis()` pipeline - the exact function Stage 0 used -
against 3 representative sampled deltas per UNSAFE repository, but captures the FULL
`graphResult.unresolved` array (every unresolved specifier, its importer, and why), `integrity`
findings, and node/edge counts, which the Stage 0 `BenchmarkRecord` schema discarded down to a bare
`graphConfidence: "UNSAFE"` string. This is read/analysis-only against already-cloned repository state -
no Stage 0 evidence was touched, no D1/R2 writes occurred, and no benchmark numbers were recomputed or
replaced. All 3 sampled deltas per repository showed byte-identical unresolved-import lists in every
case - the root cause is a fixed property of the repository's structure at that point in its history,
not delta-specific noise.

### Repository 1: `date-fns/date-fns`

- **Structure**: pnpm monorepo (`pkgs/core`, `pkgs/tz`, `pkgs/utc`, `pkgs/docs`), no top-level `src`/
  `lib`/`tests` directory - `discoverSourceRoots()`'s fallback (scan every top-level directory) kicked
  in, treating `.devcontainer`/`.github`/`.opencode`/`.vscode`/`codemods`/`pkgs` all as "source roots."
- **Graph**: 4,554 internal-source edges, 644 external-package edges, 45 platform-builtin - a large,
  overwhelmingly well-resolved graph. **Exactly 1 unresolved specifier, and it is dynamic.**
- **UNSAFE root cause**: `pkgs/core/scripts/build/localeSnapshots/index.ts` contains
  `` import(`../../../src/locale/${code}/index.ts`) `` - a **dynamic template-literal import** whose
  target depends on a runtime loop variable (`code`, iterating over locale codes). This file is a
  **build-tooling script** (under `scripts/build/`) that generates locale-snapshot artifacts - not
  library code, not test code, and not reachable from any of the sampled deltas' actual changed files.
- **Classification**: `DYNAMIC_IMPORT`, in a build-tooling file outside the graph's practically-relevant
  surface. **Fixable?** The dynamic import itself is a genuine, unavoidable static-analysis limitation
  (no static analyzer can enumerate a runtime-interpolated path without executing the code). But the
  POLICY of letting one unresolvable dynamic import in an unrelated build script disqualify the entire
  99.98%-resolved graph is a separate, and clearly overly conservative, decision - see the cross-cutting
  finding below.

### Repository 2: `sindresorhus/execa`

- **Structure**: single package, ESM-only (`"type": "module"`), real `tsconfig.json` present (so
  correctly not excluded by Stage 0's "no tsconfig" rule) - but that tsconfig reads:
  ```json
  { "compilerOptions": { "module": "nodenext", "moduleResolution": "nodenext" }, "files": ["index.d.ts"] }
  ```
  An explicit `"files"` list containing **only the hand-authored type-definition file**, with no
  `"include"` glob at all. This tsconfig exists purely to `tsc`-validate the public API's `.d.ts`
  surface (confirmed by the `package.json` script `"type": "tsd && tsc"`), not to compile the library.
- **Graph**: `internalSource: 0`, `sourceFileCount: 0` across all 3 sampled deltas, despite real changed
  files like `lib/arguments/options.js`, `lib/methods/main-async.js` existing and being genuinely large.
- **UNSAFE root cause**: `profile.stats.sourceFiles` is overwritten by the graph's own node count after
  construction (`graph.ts`: `profile.stats.sourceFiles = graph.nodes.filter(n => n.isSource).length`).
  Because the TypeScript compiler Program DiffCI builds is scoped exactly to the repo's own tsconfig
  `"files"` list (just `index.d.ts`), the Program never loads any `.js` implementation file into its
  source-file set at all - the graph ends up with (effectively) zero real source nodes, tripping rule 1
  of the taxonomy (`sourceFileCount === 0`) regardless of how much real, testable code exists.
- **Classification**: `TSCONFIG_FILES_SCOPE_EXCLUDES_SOURCE` - **new**, distinct from the already-known
  "no tsconfig" gap (execa has one; it's just scoped to declarations only). **Fixable?** Plausibly, and
  without weakening safety: DiffCI's own independent glob-based repo scan (`analyzeRepository()`,
  `discoverTests`) already correctly found `lib`/`test` as real source roots with real files - the
  problem is specifically that the TypeScript-Program-driven graph construction defers entirely to the
  repo's own (narrowly-scoped) tsconfig `files`/`include`, rather than falling back to the independently
  discovered source roots when the tsconfig's own file list doesn't cover them. This looks like a
  genuinely common pattern for ESM-first, hand-written-`.d.ts` packages (a real, non-niche JS ecosystem
  convention), not an execa-specific quirk.

### Repository 3: `mikro-orm/mikro-orm`

- **Structure**: yarn monorepo, `scripts/` + `tests/` as discovered roots, 1,347 test files.
- **Graph**: 5,629 internal-source edges, 247 external, 117 platform-builtin. **Exactly 2 unresolved
  specifiers, both from the same importer.**
- **UNSAFE root cause**: `tests/features/reflection/production-cache/production-cache.test.ts` imports
  `./metadata-cache.json` and `./metadata.json` via plain relative specifiers - two files that do not
  exist in the git-tracked tree at this point in history. Given the test's name ("production-cache")
  and the file names, these are almost certainly **artifacts a prior build/cache-generation step is
  expected to produce**, not checked-in fixtures.
- **Classification**: `GENERATED_SOURCE` (test fixture depending on a build-time-generated file).
  **Fixable?** The underlying limitation (DiffCI cannot know a file will exist after a build step it
  doesn't run) is real, but is confined to exactly one test file's own fixture dependencies - it should
  not need to invalidate confidence for the other 5,627 correctly-resolved edges in the graph.

### Repository 4: `nestjs/nest`

- **Structure**: npm monorepo (`packages/`, `integration/`, `sample/`, `tools/`), 465 test files, no
  top-level `src` (root-level fallback scan applied, similar to date-fns).
- **Graph**: 2,903 internal-source edges, 293 external, 83 platform-builtin. **Exactly 1 unresolved
  specifier.**
- **UNSAFE root cause**: `integration/hello-world/e2e/middleware-run-match-route.ts` imports
  `../../../packages/testing.js` - a **`.js`-suffixed specifier** in what is otherwise an all-TypeScript
  monorepo. This matches the modern TypeScript/ESM convention where source is written referencing a
  sibling `.ts` file's compiled `.js` name (`"moduleResolution": "node16"/"nodenext"/"bundler"` all
  expect this). Whether DiffCI's resolver is failing to apply this convention correctly, or whether
  `packages/testing` genuinely lacks a resolvable entry at this historical commit, was **not confirmed
  with certainty** in this pass - it would require inspecting nest's exact tsconfig `moduleResolution`
  setting and the real file layout at that SHA, which is flagged as a concrete Stage 1B follow-up rather
  than guessed at here.
- **Classification**: `ESM_CJS_INTEROP` (tentative - ".js-specifier-resolves-to-.ts-file" convention),
  **not confirmed with full certainty**.

### Repository 5: `trpc/trpc`

- **Structure**: pnpm monorepo with `packages/`, `www/`, and (critically) `examples/` - many separate,
  independent Next.js example applications, each conventionally carrying its **own** `tsconfig.json`
  with its own `~/` path-alias mapping (the standard Next.js "project-root alias" convention).
- **Graph**: 2,171 internal-source edges, 816 external, 108 platform-builtin. **67 unresolved
  specifiers** - by far the largest count of any UNSAFE repository investigated.
- **UNSAFE root cause**: essentially all 67 are `~/`-prefixed alias imports (`~/server/trpc`,
  `~/server/routers/_app`, `~/utils/schemas`, etc.), overwhelmingly from files under `examples/*`
  (`examples/next-big-router/...`, `examples/next-edge-runtime/...`, `examples/next-formdata/...`).
  This strongly indicates DiffCI's graph builder resolves the **entire repository** against a single,
  root-level tsconfig's `compilerOptions`/`paths`, without picking up each `examples/*` subdirectory's
  own nested tsconfig - so aliases that are perfectly well-defined **within their own example's local
  project** are unresolvable when checked against the root project's (different, or absent) alias
  mapping.
- **Classification**: `MULTIPLE_TSCONFIG` (nested tsconfig not honored for module-resolution purposes).
  **Fixable?** Plausibly the highest-leverage single fix in this dataset by volume (67 of the ~85 total
  unresolved specifiers found across all 7 repositories in this investigation come from this one cause)
  - though whether it's *safe* to fix depends on whether trpc's actual test suite ever meaningfully
  depends on `examples/*` code paths (unconfirmed here; a real Stage 1B question, not assumed).

### Repository 6: `typeorm/typeorm`

- **Structure**: pnpm single-package-with-`extra/`-directory layout, `src`/`test` as discovered roots,
  940 test files.
- **Graph**: 11,619 internal-source edges (the largest graph of any UNSAFE repository investigated), 1,542
  external, 84 platform-builtin. **Exactly 2 unresolved specifiers**, both variants of the same target
  from the same importer.
- **UNSAFE root cause**: `test/github-issues/4219/shim.ts` imports
  `../../../../extra/typeorm-class-transformer-shim` (and, from a sibling file at a different nesting
  depth, the same target via one extra `../`). TypeORM ships an `extra/` directory for **optional peer-
  dependency compatibility shims** (`extra/` is not in DiffCI's default source-root convention list at
  all - `src, app, pages, lib, scripts, ops, tests, test, api` - though this doesn't block TS's own
  resolver, which works directly off the filesystem, not DiffCI's root list). Whether this specific file
  is missing at this historical commit, conditionally generated, or genuinely renamed was not confirmed
  with full certainty.
- **Classification**: `GENERATED_SOURCE` or `CONDITIONAL_PEER_DEPENDENCY` (tentative). **Confined to one
  regression-test fixture file** - 11,617 of 11,619 internal edges resolved cleanly.

### Repository 7: `unocss/unocss`

- **Structure**: pnpm monorepo, `packages-engine/`, `packages-integrations/`, `test/` as discovered
  roots, Vite-based build tooling.
- **Graph**: 1,053 internal-source edges, 1,099 external, 104 platform-builtin. **6 unresolved
  specifiers**, one of them dynamic.
- **UNSAFE root cause - two distinct causes in one repository**:
  1. **5 of 6** are `./generated/meta` (and `../generated/meta`) imports from
     `packages-integrations/vscode/src/*.ts` - a VS Code extension integration that imports a
     **build-time-codegenerated metadata file**, not checked into git. `GENERATED_SOURCE`/
     `FRAMEWORK_CODEGEN`.
  2. **1 of 6** (the dynamic one) is `test/preset-attributify.test.ts` importing
     `./cases/preset-attributify/case-1/input.html?raw` - a **Vite-specific `?raw` import-query
     suffix** (Vite's convention for importing raw file content as a string), which generic TypeScript
     module resolution has no concept of at all. `BUILD_TOOL_IMPORT_QUERY_SUFFIX` - genuinely distinct
     from every other cause found in this investigation, and likely to recur in any Vite-based test
     suite using this common pattern.

## Cross-cutting synthesis: 7 different problems, or a small number of systemic ones?

**Neither extreme.** This is not "one universal bug" (there are at least 4-5 structurally distinct
mechanisms: build-time dynamic imports, tsconfig file-scope too narrow, generated/non-committed
fixtures, nested-tsconfig-not-honored, and a build-tool-specific import syntax) - but it is also
nowhere near "7 unrelated problems requiring 7 unrelated fixes." **The single most important, unifying
observation across 6 of the 7 repositories (all but trpc) is that the unresolved-import count is tiny
relative to graph size**: 1 in 4,554 (date-fns), 2 in 5,629 (mikro-orm), 1 in 2,903 (nestjs), 2 in 11,619
(typeorm), 6 in 1,053 (unocss) - typically well under 0.1% of all internal edges, and in every one of
these 5 cases, the unresolved specifiers are confined to files **outside the core library/test surface**
that would plausibly matter for a real code-change's test selection: build-tooling scripts, generated
codegen artifacts, and isolated regression-test fixtures.

**This is the highest-leverage finding in this investigation.** The current confidence policy treats a
graph with 11,617 of 11,619 edges (99.98%) correctly resolved identically to a graph that could not be
analyzed at all - both become `UNSAFE`, both trigger 100% fallback for every single delta in that
repository, for the entire duration of Stage 0's sampling window (confirmed: all 3 sampled deltas per
repository showed identical unresolved-import lists). A confidence policy that accounted for *where* the
unresolved imports are - specifically, whether they are reachable from the actual changed files in a
given delta, or confined to an isolated corner of the graph unrelated to library/test code - could very
plausibly reclaim most of 5 of these 7 repositories' selective-testing value without weakening safety
for the actual paths that matter. `trpc` (67 unresolved, systemic root-tsconfig-vs-nested-tsconfig
mismatch) and `execa` (structural tsconfig-scope exclusion of all real source) are different in kind -
their unresolved-import problem is not confined to a small corner, and any fix there is a genuine
graph-construction capability gap, not a policy-tuning question. This distinction - "policy is too
blunt" vs "graph construction has a real capability gap" - directly answers Stage 1A's core diagnostic
question and should govern how any future engineering investment here is prioritized.

