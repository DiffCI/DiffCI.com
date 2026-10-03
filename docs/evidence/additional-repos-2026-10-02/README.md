# Additional repository screen — 2026-10-02

Seven repositories were initially checked with unpublished local DiffCI: CLI `721bc390024853ef9850fe634360e2a0d1a77596`, core `6bd9a23caeca850997806f4aa3501f8e7197139f`, Node 24.16.0 on Windows. That initial screen established no verified runtime savings. The [2026-10-03 Unstorage follow-up](../unstorage-runtime-2026-10-03/README.md) resolves discovery and integration-test blockers and records 50.9% net local savings for a patched fixture with explicit guard rules. Selection counts below describe the original screening discovery, not executed tests or measured CI savings.

| Repository | Local result | Baseline / qualification |
| --- | --- | --- |
| Redux | SELECTIVE, 9/34 discovered files; complete graph | Full `yarn test`: 7 failed suites, 11 passed; package/alias resolution failures. Four proposed example files are outside the runner's configured `test` directory. |
| Reselect | SELECTIVE, 17/17 discovered files; complete graph | No reduction; installation and runtime comparison not attempted. |
| H3 | SELECTIVE, 46/71 discovered files; complete graph | Frozen install passed. Full `pnpm test` stops on formatting of committed `docs/5.migration/0.index.md`, after clean-checkout line endings were normalized. |
| Unstorage | SELECTIVE, 2/40 discovered files; complete graph | Build, lint and types pass. Full runtime: 3 failed files, 26 passed, 12 skipped; 7 failed tests, 538 passed, 226 skipped. Failures include Windows filesystem rename permissions, Netlify key expectations and a database hook timeout. |
| Zod | Compatibility screen | Nub command wrapper and dynamic Vitest projects are unsupported by the safe comparison path. No runtime comparison. |
| Hono | Compatibility screen | TypeScript plus Vite Plus (`vp test`) pipeline requires additional execution support. No runtime comparison. |
| date-fns | Compatibility screen | No root full-test command; nested workspace projects and custom test filenames require additional execution support. No runtime comparison. |

Unstorage's initial selected runtime qualification passed: 15 mocked S3-list tests passed, while 19 credential-dependent S3 tests were skipped. This was a runtime-only qualification, not a paired full-pipeline comparison. The full runner's extra file was subsequently identified as a separate type suite and retained in the follow-up comparison. All 34 S3 tests were subsequently exercised against a local emulator. Do not infer an execution percentage or safety guarantee from the original discovery counts.

Linux validation was unavailable during the initial screen because Docker's Linux engine could not be reached. The follow-up uses an isolated Linux filesystem under WSL and documents an evaluation-only database fixture patch. Frozen dependency installations and generated build outputs were confined to owned evaluation clones. Main workspace changes were preserved.

## Revisions

| Repository | Base | Head |
| --- | --- | --- |
| Redux | ea81ac429272c1931a8af3126db058b747725a09 | 9b21de4947de93dcc7a8234b243aa263b9e8fd22 |
| Reselect | f4a5eba22e289522cc5fe7ad1adc83c45876b865 | 099dcf89c84e0614f1f7b1cf83b5ae2b37b42616 |
| H3 | 3cfd7491f91c794402e13506253e8d04cd36317d | 26bac524c80be279187bfa68cb8bf41f164813b1 |
| Unstorage | 88f8e43b40ea5533a96118770784ecb58d945243 | c9361afa5833d601cf262d137f068e3907fd8c9d |
| Zod | Compatibility only | 004d800c9e3cd4c79930f55aa4ad080225b22efd |
| Hono | Compatibility only | f23b146afcec63606144cde50b5fbd360dd60238 |
| date-fns | Compatibility only | 717ce0a807ea4c6b540d015b5c408723175b2838 |

Raw observations, compatibility screens and baseline logs are in this directory. Installation logs remain in `C:\Users\Swati Kale\.codex\diffci-evidence\2026-10-02`.
