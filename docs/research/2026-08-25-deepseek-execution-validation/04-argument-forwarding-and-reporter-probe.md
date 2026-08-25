# Report 04 — argument-forwarding and structured-reporting probe (Phase 4)

**Target:** PR #2808 (`c71ff384cc80f8cfba5f364c5e2fefec1d69f28d`), 9 diagnostic commands, run via the diagnostic-probe DO mode (raw shell commands, no full baseline/mutant pipeline) - the same cheap-before-expensive discipline used for Cal.com. Raw record: `raw-deepseek-argprobe3-final-record.json`.

## Infrastructure note: a real harness bug found and fixed first

Before any diagnostic command ran, **two independent attempts (`deepseek-argprobe1`, `deepseek-argprobe2`) stalled forever at `step: "bootstrapping"`**, `heartbeatAt` frozen at the exact seed timestamp for 21+ and 2.4+ minutes respectively with zero progress. Root-caused via a controlled experiment, not guessed: a same-Worker, same-DO-class Cal.com diagnostic probe (`calcom-alarmtest1`) started in between advanced through five real steps in under two minutes, ruling out a general Cloudflare alarm outage.

**Actual cause**: `sandboxContainerId()` only bounded the `runId` component (cap 24 chars) of the container name, silently assuming `repoSlug(repository)` would always stay short. `calcom__cal.diy` (13 chars) kept the total comfortably under container-name limits for every Cal.com run this mission. `deepseek-ai__deepseek-harness` (30 chars) does not: with a realistic runId the id landed at **exactly 64 characters - one over the classic 63-char DNS-label limit**. Because `alarm()` calls `getSandbox()` (which resolves by this id) *before* the line that updates `heartbeatAt`, a failure there is invisible from outside - the DO just never advances.

**Fixed** (`src/analysis-fanout/cloudflare/execution-shard-do.ts`, commit `16da551`): both segments now bounded (repoSlug to 20 chars, runId to 20 chars), guaranteeing the total stays under 63 regardless of input length. 2 new regression tests, 155/155 suite green. Redeployed (`46bae508`). `deepseek-argprobe3`, launched immediately after, advanced past `bootstrapping` within one poll (~10s) and ran to completion normally - confirms the fix, not a coincidence (two prior attempts under the old code both failed identically).

This is a genuine harness defect this mission's own discipline caught before it could silently block every future DeepSeek run - documented in full rather than quietly patched.

## Probe results (9 commands, all against the real `frontend-static.spec.ts`/`web-app` files DiffCI actually selected for PR #2808)

| # | Command | Result |
|---:|---|---|
| 0 | corepack activation + `pnpm --version` | `11.7.0`, confirms corepack pins the right version |
| 1 | `pnpm test --help` (no `--`) | **Exit 0, printed vitest's real `--help` text** (confirmed via stderr: `$ vitest run --help`). Bare trailing args ARE forwarded to the underlying script. |
| 2 | `pnpm test -- --help` (**with** `--`) | **Exit 124 (killed at the 5-minute cap)** - stdout shows dozens of real test files actively executing (`popup-view.client.spec.tsx`, `tool-bash/tests/integration.spec.ts`, ...). The `--` silently swallowed `--help` and ran the full ~1000+ test suite instead. |
| 3 | `pnpm test --definitely-invalid-diffci-option` (no `--`) | `EXIT_CODE=1` - Vitest's own CLI parser correctly rejected the unknown option. Not silently absorbed into a full run. |
| 4 | `pnpm test this/path/does/not/exist.spec.ts` | `EXIT_CODE=1`, 171 bytes of output total (`RUN v4.1.8` then immediate failure) - correctly narrowed to "no tests matched," never fell back to the full suite. |
| 5 | `pnpm test <1 real file> --reporter=json --reporter=default --outputFile.json=...` | Exit 0, JSON report: **exactly 1 file (`frontend-static.spec.ts`), 1 test, passed.** `HONORED_EXACTLY`. |
| 6 | `pnpm exec vitest run <same file>` (bypass the `test` script layer entirely) | Exit 0, **identical result** to #5 - script-layer and direct invocation are equivalent for this repo; no script-layer surprise to guard against. |
| 7/7b | `pnpm test <4 real files> --reporter=json ...` (multiple files) | Exit 0; the first run (`deepseek-argprobe3`) truncated its captured stdout before confirming the file count, so a dedicated follow-up (`deepseek-argprobe4`) re-ran the identical command with a compact count-only readout: **`{"files":4,"names":["browser-open.spec.ts","trusted-hosts.spec.ts","web-app.spec.ts","frontend-static.spec.ts"],"totalTests":16}`** - exactly the 4 requested files, `HONORED_EXACTLY`. |
| 8 | `pnpm test --project thread-safe <1 real file> --reporter=json ...` | Exit 0, JSON report: **exactly 1 file, 1 test, passed** - `--project` filtering works correctly *and* combines correctly with the file filter, in contrast to Cal.com (which has no `projects` array at all). Not needed for this mission's selective execution (file-path filtering alone already works), but confirmed safe and available. |

### The Cal.com `--` lesson generalizes, inverted

Cal.com's bug was `yarn test -- <args>` silently dropping everything after `--`. deepseek-harness's pnpm equivalent is the **same failure class with the opposite trigger**: here, `--` is what breaks it (#2), while the bare form (#1, #5-#8) forwards correctly. This is exactly why the mission's rule is "verify per repository, never assume a fix generalizes" - a naive port of Cal.com's exact conclusion ("drop the `--`") would have been coincidentally right for the wrong reason if reasoned from analogy alone; it is right here because it was independently measured, not inherited.

**`testArgv: ["test"]` (bare, no `--`) - already the profile's configured value (Report 01/commit `0cee1cb`) - is confirmed correct.** No change needed to the harness profile.

## Runtime-selection invariant classification

All file-filtered probes (#5, #6, #7/7b, #8): `HONORED_EXACTLY` - requested file count equals executed file count equals reported test count, on a genuinely parsed structured JSON report (`testResults.length`, matching the `vitest-report.ts` fix already proven on Cal.com).

## Structured reporting

The default Vitest JSON reporter (`--reporter=json --outputFile.json=...`) produces a complete, parseable report with per-file `testResults`, per-assertion `status`/`duration`/`failureMessages` - no custom reporter adapter needed for this repository, matching Cal.com.

## No live full-suite run has started yet

Per the mission's explicit gate ("No live full-suite run should begin until selection enforcement is proven locally"): this report satisfies that gate for the unit family. The canary run (Phase 6) is next.
