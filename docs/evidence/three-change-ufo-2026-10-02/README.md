# UFO three change DiffCI runtime evaluation

DiffCI 0.3.1 was evaluated against three frozen changes in [unjs/ufo](https://github.com/unjs/ufo) on 2 October 2026. **UFO is unsuitable for a runtime savings pitch on this host.** Full runtime and type tests passed at each sampled commit, but the suite is small and analysis overhead exceeded the measured execution reduction.

This is a better qualified experiment than the Remeda attempt: it produced two valid paired runtime comparisons. It is still a negative acquisition result. No message was sent and no upstream configuration was changed.

## Results

| Change | DiffCI workload | Full runtime median | Selected runtime median | Analysis overhead | Selected plus analysis | Net result |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Latest source fix | 12 of 13 runtime files | 2.882 s | 2.654 s | 1.569 s | 4.223 s | 46.5% slower |
| Broader source and test formatting | 13 of 13 runtime files | 2.755 s | 2.541 s | 1.822 s | 4.363 s | 58.4% slower |
| Package manager configuration | FULL fallback | Not paired | Not applicable | Not paired | Not applicable | Full validation required |

Each paired comparison used three trials, alternating full/selected, selected/full, full/selected. Both arms passed in all six trials, with matching commit, worktree, and dependency snapshots. DiffCI labels both comparisons **PRELIMINARY** because caches and host conditions were uncontrolled. The reported analysis overhead comes from DiffCI's observation evidence; dependency installation and package download time are excluded.

The source change's full runtime arm ran 489 individual tests; its selected arm ran 465. The omitted file was `test/punycode.test.ts`, which directly imports the punycode implementation rather than the shared source barrel. The broad change ran the same 477 tests in both arms. Its approximately 8% execution-time difference is not evidence of a reduced workload: all runtime files were selected. Even the source comparison's full and selected duration ranges overlap. Do not market either gross timing difference as a reliable saving.

These measurements cover the runtime Vitest phase only. They do not establish a reduction in the full CI pipeline or general selection safety.

## Sample and provenance

The default branch was frozen at `f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6`. Categories were chosen before the comparisons: latest source fix, latest change touching at least three source/test paths, and latest dependency or package-manager configuration change in the frozen first-parent history.

| Category | Date | Head | Parent |
| --- | --- | --- | --- |
| Fix leading slashes in withoutBase | 2026-04-29 | [5cd9e676711a](https://github.com/unjs/ufo/commit/5cd9e676711af3f4e4b5398ddf6ca8d52c1c7e1f) | `a7b94e69ff6159de8ddfd4940c90db4708c0d67e` |
| Formatting in punycode and three test files | 2026-01-06 | [018167768365](https://github.com/unjs/ufo/commit/018167768365752f0bbe5b0867818cf9a1fbea50) | `9d1833b8a53e2347abc404d8e3db76a8f676bd4c` |
| Update pnpm to 10.33.2 | 2026-04-29 | [a5ae11a45c22](https://github.com/unjs/ufo/commit/a5ae11a45c2269e5af793432eacba15b5a0d349f) | `78070102134fc18db2e850bace89b169da9fd796` |

These are the latest matching changes in this repository, but they are several months old. The broader case is formatting, not a multi-module behavior change. This packet therefore does not represent a busy recent development period. [Sampling history](raw/sampling-history.txt) preserves surrounding commits rather than hiding them.

All final observations ran with the analyzed head checked out and used published DiffCI 0.3.1 with `--no-send`, Node v24.16.0 on Windows, and frozen lockfiles. Installations disabled lifecycle scripts. pnpm honored the frozen package manager declarations: 10.33.2 for the source and configuration cases, 10.27.0 for the broader case. [Manifest](manifest.json) records the exact ranges and scope; [tool lockfile](raw/tool-package-lock.json) records the installed tool packages.

The initial `source-screen.json` is preliminary screening evidence from before detaching to the source commit. It is not used for timing or the final verdict table. The final `source.json` and its bound runtime artifact are authoritative for that case.

## Full validation and scope

The full test command with type checking passed at every sampled head:

```sh
pnpm exec vitest run --typecheck
```

| Head category | Files passed | Tests passed | Type errors |
| --- | ---: | ---: | --- |
| Source fix | 14 | 491 | None |
| Broader formatting | 14 | 479 | None |
| Configuration | 14 | 487 | None |

DiffCI discovers 13 runtime test files. The extra file in these full validations is `test/types.test-d.ts`; its two type tests were run separately through the command above and are outside the timing comparisons. Keep type validation mandatory when evaluating adoption.

The repository's `pnpm test` script combines lint with `vitest run --typecheck`. Its lint stage failed on this checkout, including formatting warnings for CRLF files even though the editor configuration requests LF. Changing the clone's `core.autocrlf` setting and restoring through Git did not resolve the warnings; `git ls-files --eol` still showed LF index content and CRLF worktree content. No formatter was used to rewrite upstream files, and no lint result is described as passing.

The default DiffCI `check` command was run on all three changes. Its inferred full arm was `pnpm test`, while the selected command covers runtime tests only. The source and broad default comparisons were invalid because the full arm failed lint while the selected runtime arm passed. They are preserved as `*-savings.json` but must not be used as savings or missed-behavior evidence. The configuration check ran full validation once and failed at lint. An exit code alone is insufficient; inspect artifact validity and command scope.

The explicit runtime comparisons resolve that scope mismatch: the full arm is `pnpm exec vitest run`, and the selected arm is the same runner plus the exact file list from the observation. The selected command was read from the original report, not manually narrowed. Required lint, type, build, and coverage stages remain outside this proposed reduction.

The pinned [CI workflow](https://github.com/unjs/ufo/blob/f06c800d0c59f2a4a1b9ba65eb6cb61a84419be6/.github/workflows/ci.yml) uses Linux/Node 20 and separately runs lint, build, Vitest coverage, and coverage upload. This Windows/Node 24 experiment does not reproduce that pipeline. No mutation recall, omitted-test safety study, production runner measurement, or coverage equivalence was established.

## Reproduction and evidence

Use [reproduce.ps1](reproduce.ps1) with a new output directory outside the checkout. Corepack and pnpm shims must be available. The script installs each frozen lockfile, runs the default check, validates the full runtime/type suite, and performs three matched runtime trials for SELECTIVE results. It has been syntax checked; equivalent commands were executed for this packet.

```powershell
.\reproduce.ps1 -OutputDirectory C:\temp\ufo-diffci-reproduction
```

For the source case, after checking out the exact head and installing its dependencies:

```sh
npx --yes @diffci.com/diffci@0.3.1 check --base a7b94e69ff6159de8ddfd4940c90db4708c0d67e --head 5cd9e676711af3f4e4b5398ddf6ca8d52c1c7e1f --out ../source.json --no-send --timeout-ms 120000
pnpm exec vitest run --typecheck
npx --yes @diffci.com/diffci@0.3.1 verify-savings --repo . --full "pnpm exec vitest run" --selected-from-report ../source.json --out ../source-runtime.json --repetitions 3 --cache-state unknown
```

[Raw evidence](raw/) includes observations, invalid default comparisons, valid runtime comparisons with exact commands and provenance hashes, passing full/type logs, installation logs, and the sampling history. The runtime files use `diffci.verifySavings.v3`; both have `comparison.evidenceValid=true` and three trials.

## Candidate screening and next choice

Other candidates were screened before this experiment. Their results are retained so the selection process is visible:

- Immer's default script includes source tests, build tests, and Flow validation. It was not installed or timed.
- Radashi's default script requires coverage, and its source screen selected all 295 discovered paths, including benchmark paths. It was not installed or timed; a SELECTIVE label alone would be misleading. See [screen](raw/radashi-screen.json).
- es-toolkit's default script includes coverage, and its observer screen discovered zero tests despite the repository's `.spec.ts` tests. Its fail-closed result is a compatibility finding. It was not installed or timed. See [screen](raw/es-toolkit-screen.json).

Keep UFO as a negative economics example. For the next acquisition candidate, prioritize a materially longer full runtime suite and tests importing specific modules rather than a shared export barrel. First verify that DiffCI's discovered universe matches the runner. Preserve the Remeda, es-toolkit, and Radashi findings for compatibility work without turning this outreach experiment into product debugging.

UFO is recorded in the canonical [DiffCI Outreach Tracker](https://docs.google.com/spreadsheets/d/1TvZo9YnDawOLR75WTyPSAf95vQ5VdoBx6iBeqJF_d60/edit?gid=1400978172#gid=1400978172) as evaluated with no net runtime saving. No outreach was sent.
