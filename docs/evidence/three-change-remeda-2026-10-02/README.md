# Remeda three change DiffCI evaluation

This report evaluates DiffCI 0.3.1 on three frozen changes in [remeda/remeda](https://github.com/remeda/remeda), using a local Windows checkout on 2 October 2026. The purpose is to establish whether there is reproducible evidence worth offering the maintainer before asking for installation.

**Hold savings outreach.** All three changes required full validation before and after installing all workspace dependencies. Full library runs failed on this Windows host. Smaller intermediate affected-file lists under `FULL` do not authorize selective execution. No runtime savings are established.

## Changes and sampling

The default branch was frozen at `9955bb0eca98cc5d1bbb17dc4314dd38a10a28d5`. Before running DiffCI, the sample was chosen from the recent first-parent history: the latest source fix, latest source fix touching at least five implementation files, and latest dependency update. All parents were available and every analysis ran with its head checked out. These are three commit deltas, not an unbiased estimate of all changes or a promise of two selective results.

| Category | Date | Head and change | Parent |
| --- | --- | --- | --- |
| Source fix | 2026-09-14 | [b9ec4b0ac5ba](https://github.com/remeda/remeda/commit/b9ec4b0ac5ba86f2f687bae6e92d318db02eea24), resolve fixed-value conditions in `isNot` | `5d7dc5fc95b6a4c7ab21278f3ca85631d31bddae` |
| Broad source fix | 2026-09-07 | [09afe15535be](https://github.com/remeda/remeda/commit/09afe15535be715c13c437a1d4d06b08ba4cdbcd), narrow lazy callback data types across several utilities | `7f134659d0a03a4e77c631bf5fe0485e9359b092` |
| Dependency update | 2026-10-01 | [9955bb0eca98](https://github.com/remeda/remeda/commit/9955bb0eca98cc5d1bbb17dc4314dd38a10a28d5), update devalue in the lockfile | `e8292ddf03f8a334cf8b048983d518f89fe6be97` |

The [sampling history](raw/sampling-history.txt) preserves surrounding changes, including commits not chosen. The source changes primarily concern TypeScript behavior, so type tests matter to this evaluation.

## Initial results with library dependencies

| Change | Changed files | Discovered test files | Verdict | Reason |
| --- | ---: | ---: | --- | --- |
| Source fix | 7 | 175 | FULL | Dependency graph confidence UNSAFE |
| Broad source fix | 28 | 175 | FULL | Dependency graph confidence UNSAFE |
| Dependency update | 1 | 175 | FULL | Configuration and lockfile change |

The raw reports contain affected lists of 11, 35, and 0 files respectively. These are diagnostic lists inside full-validation verdicts. None of the reports proposes an executable selective command. In particular, the dependency report's empty list means full validation is required.

`check` completed the analysis but could not infer a full command because the repository root has no `test` script. It therefore ran no tests automatically. This is a command-inference limitation, not a successful verification receipt. Normal library tests were run separately with `CI=true` and:

```sh
npm --workspace packages/remeda test -- --run
```

| Change | Library test files | Test results | External command wall time | Exit |
| --- | --- | --- | ---: | ---: |
| Source fix | 314 passed, 1 failed | 4800 passed, 1 failed, 10 expected failures, 1 todo | 23.037 s | 1 |
| Broad source fix | 313 passed, 1 failed | 4667 passed, 1 failed, 10 expected failures, 1 todo | 40.880 s | 1 |
| Dependency update | 314 passed, 1 failed | 4800 passed, 1 failed, 10 expected failures, 1 todo | 24.279 s | 1 |

All failures occurred in real-timer scenarios in `src/funnel.test.ts`, with different assertions across the runs. Their cause was not established. These durations include npm and runner startup, exclude dependency installation and DiffCI analysis, and describe failed baseline attempts. They are neither passing baselines nor paired savings measurements. A graph diagnostic overlapped the broad baseline, making that duration particularly unsuitable for comparison.

## Setup and graph diagnostics

The first analyses ran without target dependencies. The next pass installed the library and root workspaces with `npm ci --workspace packages/remeda --include-workspace-root --ignore-scripts --no-audit --no-fund`. All three verdicts remained FULL. This setup omitted docs dependencies, and the test logs warned that `astro/tsconfigs/strictest` could not be resolved.

The [broad graph diagnostic](raw/broad-graph-diagnostics.json), generated through the installed package's graph API, lists 44 unresolved imports using docs aliases such as `@/lib/utils`. It has zero critical integrity findings and 32 warnings. This records a limitation in that setup; it does not establish a defect in Remeda or prove which issue would remain with complete dependencies.

## Results with all workspace dependencies

A final pass used `npm ci --ignore-scripts --no-audit --no-fund` at each frozen head, including docs dependencies. All three changes still returned FULL. The source and dependency graphs increased to 627 nodes, and the broad graph to 624. Both source changes retained UNSAFE confidence. The dependency change retained its configuration and lockfile fallback. The missing root test script still prevented automatic command execution. Full dependency installation therefore did not resolve the graph and command-inference blockers.

| Change | Library test files | Tests passed and failed | External command wall time | Exit |
| --- | --- | --- | ---: | ---: |
| Source fix | 314 passed, 1 failed | 4800 passed, 1 failed | 38.842 s | 1 |
| Broad source fix | 313 passed, 1 failed | 4667 passed, 1 failed | 160.695 s | 1 |
| Dependency update | 312 passed, 3 failed | 4797 passed, 4 failed | 89.499 s | 1 |

Each run additionally reported 10 expected failures and 1 todo. The dependency head failed timer scenarios and a random-number test; the source head failed a debounce timer scenario; the broad head failed a random-number test. All recorded type checks reported no type errors. Installation completeness did not establish a passing baseline. These are single failed attempts with uncontrolled host and cache conditions, so their durations should not be compared as performance differences between revisions. All three complete baseline artifacts record empty before and after checkout status.

## CI scope and limitations

The pinned [library workflow](https://github.com/remeda/remeda/blob/9955bb0eca98cc5d1bbb17dc4314dd38a10a28d5/.github/workflows/ci-library.yml) separates source typechecking, build, runtime tests across Node versions, type tests across TypeScript versions, property tests, lint, formatting, and other release gates. This local experiment runs the library's combined Vitest projects on one Windows host with Node v24.16.0 and npm 11.13.0. It does not reproduce that Linux matrix, build checks, lint, coverage workflows, or deployment gates.

The observer's 175 discovered files are not the full library validation universe: Vitest reports 314 or 315 files across runtime, type, and property projects. The observer also includes a StackBlitz runtime test outside the library command. File counts must not be converted into percentage savings or individual test counts.

Lifecycle scripts were disabled during installation. No build or generated Astro types were produced. No failing tests were removed, no test thresholds were changed, and no source or CI configuration was edited. The observations record an unchanged worktree; source and dependency baseline artifacts also record empty before and after status. The first broad baseline artifact records only its post-run status; do not describe that artifact as a paired before-and-after check.

## Reproduction

Use [reproduce.ps1](reproduce.ps1) with a new directory outside your checkout. It fetches the exact revisions, installs each frozen full lockfile with lifecycle scripts disabled, and uses published DiffCI 0.3.1 with `--no-send`. Add `-RunLibraryTests` to run the combined library projects and retain logs, elapsed time, exit codes, and before/after checkout status. The script has been syntax checked; the equivalent commands were executed for this packet.

```powershell
.\reproduce.ps1 -OutputDirectory C:\temp\remeda-diffci-reproduction -RunLibraryTests
```

For analysis of one commit without installing target dependencies or executing target tests:

```sh
git clone https://github.com/remeda/remeda.git
cd remeda
git checkout --detach b9ec4b0ac5ba86f2f687bae6e92d318db02eea24
npx --yes @diffci.com/diffci@0.3.1 observe --base 5d7dc5fc95b6a4c7ab21278f3ca85631d31bddae --head b9ec4b0ac5ba86f2f687bae6e92d318db02eea24 --out ../source.json --no-send
```

The original reports, baseline attempts, installation logs, tool lockfile, and graph diagnostic are retained in [raw](raw/). `*-installed.json` denotes the library-workspace setup; `*-complete.json` denotes installation of all workspace dependencies; the unsuffixed observation JSON files denote the first pass without target dependencies. [Manifest](manifest.json) records the revisions and environment. Tool provenance is captured by `raw/tool-package-lock.json` and `raw/tool-code-hashes.json`.

## Outreach decision

This candidate is useful for qualification and compatibility work. It currently provides no evidence for a savings pitch. Before reconsidering outreach, establish complete workspace resolution, align discovery with runtime/type/property projects, provide a full workspace command without editing upstream, and obtain passing baseline runs in a suitable environment.

If a technical discussion becomes appropriate, an honest permission request would be:

> I evaluated DiffCI against three recent Remeda changes. It required full validation on all three, and I recorded the workspace and test-discovery limitations rather than claiming a reduction. Would the short reproducible compatibility report be useful to you?

This draft has not been sent. No maintainer PR, upstream DiffCI installation, endorsement request, or hosted pilot was initiated. The evaluation is recorded in the canonical [DiffCI Outreach Tracker](https://docs.google.com/spreadsheets/d/1TvZo9YnDawOLR75WTyPSAf95vQ5VdoBx6iBeqJF_d60/edit?gid=1400978172#gid=1400978172), row 55, as evaluated with outreach on hold.

## Unpublished safety follow-on

[Core draft PR 18](https://github.com/DiffCI/core/pull/18) resolves imports using each importer's nearest TypeScript configuration and supports declared npm workspaces. At the frozen source head b9ec4b0, unresolved imports fall to zero; graph confidence remains PARTIAL. The final command planner refuses file selection because the runtime/property projects disable isolation. Keeping state-sharing test files together takes precedence over reduction. The full library command failed one debounce timing assertion (314 files passed, one failed). No runtime savings are established. [CLI draft PR 21](https://github.com/DiffCI/DiffCI.com/pull/21) adopts the new core and verifies complete workspace comparisons. Results are in raw/remeda-local-safe-final.json and raw/remeda-safe-full.log. Neither PR has been merged or published in this follow-on.
