# DiffCI blind baseline — nrwl/nx (2026-08-24)

Frozen DiffCI build (`gitHead` `8890e1a5`, `engineChecksum` `e0f20b722d880d59...`, verified MATCH before
and after this run). Run on `diffci-analysis-fanout`, `standard-4`, 6 shards / 6 concurrent, all 6
completed with zero errors, zero resource kills, zero timeouts. **30/30 rows `ok: true`** - the only one
of the four blind holdouts where every merge actually produced a DiffCI verdict (nx has a root
`tsconfig.json`, unlike biome and cal.com - see those reports).

Manifest: `2026-08-23-nx-blind-baseline-selection-manifest.json` (30 most recent merged PRs on `master`
as of 2026-08-23T00:00:00Z, all 30 verified merged via the GitHub API, `mergeListSha256`
`fc83366b8f983717...`). Raw rows: `2026-08-23-nx-blind-baseline-rows.jsonl`.

## Headline finding: a real, generalizing engine correctness bug - not an nx quirk

**A directly-modified test file is never selected to run unless another file also depends on it.**
Traced to `src/repo/impact.ts`: `processChangedPath()` has no branch for `category === "test"` - it
falls through every explicit check (fixture, unknown, docs, asset, config/workflow/infra/database,
deleted-not-in-graph) to the generic `processSourceChange()`, whose one test-aware line is:
```ts
if (!this.isTestFile(sourcePath)) { affectedSources.set/push(... DIRECT_CHANGE ...) }
```
which correctly SKIPS adding a changed test file to `affectedSources` - but there is **no corresponding
branch that adds it to `affectedTests`**. The function only walks `graph.transitiveDependentsOf(sourcePath)`
and adds any test found THERE; a leaf test file essentially never has dependents, so its own change is
never recorded anywhere.

**Observed directly:** PR #36723 ("cleanup(angular): bump e2e es2015 bundle size threshold...") changed
exactly one file, classified `category: "test"`, `changedFileCategories: {"test":1}` - and got
`affectedTests: 0`, `SAFE_TO_PROPOSE`, 100% work reduction. A commit that only edits a test's own
assertions (fixes a flaky test, tightens a threshold, adds a case) selects **zero tests to run**.

**This is not repository-specific.** Checked the same "changedFileCategories is `{test: N}` only, and
`affectedTests === 0`" pattern against the other completed raw row files:

| Source | Matches |
|---|---|
| nx (this report) | 1 / 30 |
| deepseek-harness (`2026-08-23-...-replay-complete.jsonl`) | 1 / 30 |
| turborepo | 0 / 30 |

It is real and reproduces on a second, unrelated repository, just rare - most real PRs touch a test
alongside the source it exercises, which masks the bug (the source file's own dependent-traversal may
happen to reach a *different* test, or the diff is simply never test-file-only). A pure test-only diff
is the exact case that exposes it cleanly.

**Category: General engine bug (severity: high).** Unlike the tsconfig-crash finding (which blocks
analysis entirely and is loud/obvious) or the graph-UNSAFE path-alias gap (which forces a conservative
FALLBACK, i.e. fails safe), this bug fails **unsafe**: it produces a confident `SAFE_TO_PROPOSE` with
zero tests selected when the correct answer is "run at least the test that was just edited." **Not
fixed here** per the blind-baseline rules (no policy/classification changes during blind execution) -
flagged as the highest-priority item for the adapted-replay roadmap, ahead of the tsconfig and
path-alias findings.

## Standard results

| Metric | Value |
|---|---|
| Merges analyzed | 30 / 30, all `ok: true` |
| `SAFE_TO_PROPOSE` | 7 |
| `FALLBACK` | 23 |
| Median recognized tests | 502-505 (unit family only) |
| Median selected % (authorized merges) | 0% - **every one of the 7 authorized merges selected 0 tests** (see below) |
| Median analysis wall time | 9.1 s total / 7.9 s graph-build / 107 ms impact step |
| Errors / resource kills / timeouts | 0 |

### The 7 "authorized" merges all selected zero tests

#36752, #36750, #36748, #36636, #36724, #36723, #36711 - every single `SAFE_TO_PROPOSE` verdict on this
repository came with `affectedTests: 0`. #36723 is the test-only-change bug above. The rest are small
diffs (median 3 changed files across all 30 merges) where the graph genuinely found no reachable test
dependents - plausible for isolated doc/config-adjacent or narrowly-scoped source changes, but combined
with the bug above, **every reported "authorized" merge on nx should be treated as unverified** until
the test-self-selection gap is fixed and this repository is re-run.

## Test-universe completeness: INCOMPLETE

Only the `unit` family was recognized (`jest.config.cts` at the root, one config, `family: null` since
it's the default/no-suffix config - see `src/repo/test-discovery.ts`'s family-inference rule). Its
`scripts` field came back empty - nx's actual `test` invocation goes through the `nx` task-runner
(e.g. `nx test <project>` / Nx executors), not a literal `jest` substring in a `package.json` script,
so the discovery's script-matching heuristic found no invoking script (informational only; does not
affect which files are treated as tests, only the metadata about how to run them). nx's real CI
(`e2e-matrix.yml`) plainly runs E2E suites that this pass never discovered as a distinct family -
category: **missing test-family discovery**, consistent with what was already known from Phase 1 (Nx's
own project-graph/executor model of "what is a test" doesn't map onto a single Jest/Vitest config the
way this engine's discovery expects).

## Unknown files: two distinct, generalizable patterns (48+40+ instances, not one bucket)

80 unknown-file instances across 18 merges, dominated by three kinds:

1. **`.snap` files (24 instances)** - Jest snapshot files under `__snapshots__/<name>.spec.ts.snap`,
   sitting **beside** their source `.spec.ts` file (Jest's own default convention), not inside a
   `tests/<snapshots|fixtures>/` directory. `src/repo/test-fixture-ownership.ts`'s
   `resolveTestFixtureOwners()` only recognizes the latter (nearest ancestor directory literally named
   `tests`/`test`/`__tests__`) - it has **no support for Jest's native sibling `__snapshots__/`
   convention**, arguably the single most common snapshot-testing layout in the JS ecosystem. Category:
   **missing fixture/companion ownership** - a real, well-scoped gap, and a strong candidate for the
   adapted-replay roadmap (the ownership relationship is even simpler than the `tests/` case: the
   snapshot's owner is always the same-named `.spec.ts`/`.test.ts` file one directory up).
2. **`.mdoc` files (40 instances)** - nx's docs site (`astro-docs/`) uses Markdoc, not Markdown;
   `isDocumentationFile()` only recognizes `.md`/`.mdx`/`docs/`-prefixed paths. Category: **repository-
   specific convention**, though a generalizable fix (treating `.mdoc`/`.adoc`/`.rst` alongside
   `.md`/`.mdx` as documentation extensions) is plausible and low-risk, similar in spirit to (but
   simpler than) the deepseek `.i18n.yaml` companion-relationship fix.
3. **Generator template files (8 instances: `.ts__tmpl__`, `.tsx__tmpl__`, `.js__tmpl__`,
   `.json__tmpl__`)** - Nx's code-generator scaffolding deliberately uses a non-standard double
   extension so these are never parsed as real source. Category: **repository-specific convention** -
   correctly conservative; these genuinely could affect generator tests if templates change, so leaving
   them `unknown` -> `FALLBACK` is defensible, not a bug.

## Graph-confidence UNSAFE: minor, different signature from turborepo

6 of 30 merges, but each sampled cause shows only **1** relevant unresolved import (`relative-missing`),
nowhere near turborepo's 108-110-per-merge path-alias pattern. Not root-caused further in this pass
(low volume, low priority relative to the two findings above).

## Fallback-reason frequency (30 merges, non-exclusive)

| Reason | Merges |
|---|---:|
| Unknown changed file | 18 |
| Graph confidence UNSAFE | 6 |
| Config | 6 |
| Lockfile | 5 |
| Dependency manifest | 4 |
| Workflow | 1 |
| Deleted file, unknowable | 1 |

## Not yet done for this repository

- **Native Nx comparison** (`nx show projects --affected`, `nx affected -t test --graph=stdout` per
  merge) - not run this pass; would require installing nx's own dependencies inside the container
  within the shard's step budget, not attempted. This is the one repository in the portfolio where a
  native affected-tooling comparison would be most directly informative (Nx's own project-graph model
  vs. DiffCI's file-level graph), and is the top candidate for follow-up.
- Full Phase 1 feasibility write-up (native affected/caching technology inventory, exact test-invocation
  mechanism via Nx executors) - partially known from repo inspection, not written up standalone.
