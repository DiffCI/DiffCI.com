# Immer runtime evaluation and Valibot screening

DiffCI 0.3.1 was evaluated on three frozen changes in [Immer](https://github.com/immerjs/immer) on 2 October 2026. Its runtime tests passed at every sampled head, but neither selective case produced a net runtime saving. Keep savings outreach on hold. A separate three-change screen of [Valibot](https://github.com/open-circle/valibot) found no runnable selected command at the monorepo root.

## Immer results

These are matched runtime-phase measurements. Both commands use the same Vitest config on the same checkout. Three paired trials alternate execution order; the table uses medians. Net selected time adds the observation's measured analysis time once.

| Change | Mode and runtime files | Full median | Selected median | Analysis | Net selected | Outcome |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Type compatibility fix | SELECTIVE, 21 of 22 | 5.952 s | 5.717 s | 2.613 s | 8.330 s | 40.0% slower net |
| Array-method behavior fix | SELECTIVE, 21 of 22 | 6.194 s | 6.184 s | 1.813 s | 7.997 s | 29.1% slower net |
| Dependency update | FULL | No paired reduction | — | — | — | Full validation passed |

The full runtime baseline at each head passes 22 files and 3,755 tests, with eight skipped. Selection omits `__tests__/spec_ts.ts`, which contains one test. Both selective analyses report a COMPLETE graph with 39 nodes. Their shared dependency graph reaches nearly all test files, leaving little workload to remove. This does not establish that Immer never offers savings; it establishes no net saving for these samples on this machine.

The source case changes a type declaration rather than runtime behavior. The broader case changes two source files and two test files. These August commits predate the evaluation by several weeks. Exact heads and first-parent bases are in [manifest.json](manifest.json), with commit links below.

- [Type compatibility fix](https://github.com/immerjs/immer/commit/b00474e3755954f6b27a392dcb4bce97254c100c)
- [Array-method behavior fix](https://github.com/immerjs/immer/commit/907395ad21aef22ed2c71d11f4fb4172683ab62a)
- [Dependency update](https://github.com/immerjs/immer/commit/6c7a3deb5b2cacf625d8f99263af627ae69f36e3)

## Why the default check saving is excluded

The repository's normal `yarn test` runs runtime tests, a build and tests of the built package, then Flow. The selected command runs only source runtime tests. All three normal test executions passed, but the default selective `check` comparisons cover different workloads. For example, its first comparison printed an 80.6% net saving against a 53.71-second full pipeline. That figure excludes required build and Flow work from the selected arm and is unsuitable as a savings claim.

The results above instead compare `yarn run vitest run --config vitest.config.ts` against the same command plus DiffCI's selected files. The dependency case conservatively requires full validation because the lockfile changes. Its normal test command passed in 14.42 seconds, and the separate source runtime baseline also passed. Coverage and performance scripts in upstream CI were not evaluated; runtime selection grants no permission to omit them or other required checks.

## Evidence and limitations

Measurements used Node 24.16.0, Yarn Classic 1.22.22, Vitest 3.2.6 and Windows, with `CI=true`. Installation used the frozen Yarn lockfile and ignored lifecycle scripts. The first registry download failed; the npm-registry retry succeeded without changing tracked repository files. Installation time is excluded from runtime measurements.

Both matched comparison reports have `evidenceValid: true`, successful commands, and stable checkout provenance. Their performance status is PRELIMINARY because cache state was uncontrolled. Source full trials range from 5.756 to 6.744 seconds, selected from 5.398 to 7.194 seconds; broad full from 5.664 to 6.589 seconds, selected from 5.732 to 6.933 seconds. These overlapping ranges do not substantiate the small gross median improvements. No missed failure appeared in these passing samples; this is not a fault-injection correctness study or a Linux CI benchmark.

Raw observations, default comparisons, matched comparisons, console logs and checkout-status files are under [raw/immer](raw/immer). The installed tool's lockfile is under [raw/package-lock.json](raw/package-lock.json). No upstream code changes, pull requests or outreach messages were made.

## Reproduce

With Node 24 and Yarn Classic 1.22.22 on PATH, run [reproduce.ps1](reproduce.ps1) with a fresh output directory. It checks out each exact head, installs frozen dependencies, runs the default DiffCI check and full runtime baseline, then measures selective cases with three pairs. The script was syntax-checked; the equivalent commands were executed in this evaluation. Network downloads and caches may change future results.

```powershell
./reproduce.ps1 -OutputDirectory C:/temp/immer-diffci-evaluation
```

For each selective observation, the matched comparison command is:

```powershell
npx --yes '@diffci.com/diffci@0.3.1' verify-savings --repo . --full 'yarn run vitest run --config vitest.config.ts' --selected-from-report <observation.json> --out <runtime.json> --repetitions 3 --cache-state unknown
```

## Valibot screening

Three analysis-only observations are retained under [raw/valibot](raw/valibot). Each analyzed head was actually checked out. Dependencies were not installed and no tests or timing comparisons were run.

| Change | Head | Result | Runtime files |
| --- | --- | --- | --- |
| UUID validation fix | `e90339fec658103adbfe0620ee12471603a24196` | SELECTIVE, no runnable command | 268 of 287 |
| Luhn and ISBN optimization | `d4da61a0ac696f8421f97328f329a560b67143a9` | SELECTIVE, no runnable command | 271 of 287 |
| Translation and dependency change | `140e5347146a2d89272ed8b435898f79ce61ef81` | FULL, configuration and lockfile fallback | Full required |

Valibot declares Vitest in nested packages, while its root script delegates to workspaces. DiffCI reports that no recognized framework is declared at the analyzed root, so it cannot construct a subset command. The graph confidence is PARTIAL. The selective results are planning output, not executable verification or demonstrated savings. Exact bases and analysis times are in [raw/valibot/cases.json](raw/valibot/cases.json). Do not present the runtime-file count as the complete upstream workload, which also includes type tests.

The next repository should have a recognized root test command, complete discovery, and a measured baseline long enough to absorb analysis overhead. Check that a real source change selects substantially fewer tests before spending time on a full three-change timing packet.

## Workspace routing prototype followup

Later on 2 October, [core PR 17](https://github.com/DiffCI/core/pull/17) added declared pnpm workspace routing. At the same UUID-fix head, dependencies were installed with the frozen lockfile and the new planner produced six separately executed commands. All passed: four batches covering 268 selected runtime files, all 250 library type-test files with 1,462 tests, and an empty converter type suite. Full type suites are retained independently of runtime selection, using Vitest's [type-only mode](https://vitest.dev/config/typecheck).

The normal full `pnpm -r run test` baseline failed 71 codemod assertions. No savings comparison is valid. The prototype does not change the earlier published 0.3.1 screening results, is not released to npm, and still needs dependency adoption and automatic multi-command CLI timing integration. Validation for the core change passed 324 tests, typecheck, build and the release-boundary audit. Execution logs and plans are under [raw/valibot-workspace-prototype](raw/valibot-workspace-prototype). The public target checkout remained clean after execution.

## Safety correction to the Valibot prototype

The earlier per-file routing prototype is superseded by [core draft PR 18](https://github.com/DiffCI/core/pull/18) and [CLI draft PR 21](https://github.com/DiffCI/DiffCI.com/pull/21). Valibot's library and converter configs disable isolation; passing a file subset does not establish that shared test state is equivalent. The new planner keeps each affected non-isolated workspace together in a single full invocation and retains type checks. At frozen head e90339f, the affected library/converter chain passes 536 runtime/type files and 5,009 tests. The root full baseline still fails, so the paired report explicitly records evidenceValid:false; no savings claim follows. Final records are under raw/valibot-safe-workspaces. Core validation passed 327 tests; CLI full verification passed 2,333 tests with seven skipped and safe_to_continue:true. These follow-on changes are not published.
