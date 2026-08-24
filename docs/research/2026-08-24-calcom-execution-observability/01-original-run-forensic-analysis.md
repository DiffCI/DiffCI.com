# Report 1/9 — Original-run forensic analysis

**Run under investigation:** `exec-calcom-29940-1787565401` (cal.com PR #29940, merge `176037d0af`, base `b2c28a23ab`)
**Persisted record:** `runs/exec-calcom-29940-1787565401/calcom__cal.diy/execution-176037d0af.json`
**This document does not modify that record or any other original file.** All conclusions below are derived by re-reading it and by re-reading the harness source code as it existed at commit `1742381` (the commit that produced this run).

## Evidence gathered

### 1. Exact full and selected commands

Reconstructed from `TestRunResult.command` on the persisted record and `buildTestArgv`/`buildTestCmd` in `execution-shard-do.ts` at that commit:

- **Full baseline:** `cd /workspace/calcom__cal.diy && TZ=UTC corepack yarn test -- --no-isolate --reporter=json --outputFile=/workspace/full-baseline.json`
- **Selected baseline:** `cd /workspace/calcom__cal.diy && TZ=UTC corepack yarn test -- --no-isolate --reporter=json --outputFile=/workspace/selected-baseline.json apps/web/app/api/verify-booking-token/__tests__/route.test.ts packages/lib/getReplyToHeader.test.ts`

Both forward through Yarn's `--` passthrough to cal.com's own `package.json` script `"test": "TZ=UTC vitest run"`, confirmed byte-for-byte against the local read-only clone (`scratchpad/blind/calcom/package.json:77`). `--no-isolate` is real and CI-authentic — verified against `.github/workflows/unit-tests.yml`'s own `run: yarn test -- --no-isolate` step.

### 2. Working directory

`/workspace/calcom__cal.diy` for every step — `workDir()` is a pure function of `repoSlug(record.repository)`, consistent across clone/install/pretest/all four test-run steps. Not a source of the observed problem.

### 3. Selected paths passed to Vitest

Exactly two, both self-derived by the `deriving-selection` step (no prior analyze-mode row was supplied for this run):
- `apps/web/app/api/verify-booking-token/__tests__/route.test.ts`
- `packages/lib/getReplyToHeader.test.ts`

### 4. stdout/stderr

**Not captured at all.** The harness at commit `1742381` calls `sandbox.startProcess()` and, once terminal, only calls `sandbox.readFile(reportPath)` — it never calls `sandbox.getProcessLogs(processId)`, a real method that exists on the installed `@cloudflare/sandbox` SDK (confirmed by reading `node_modules/@cloudflare/sandbox/dist/sandbox-*.d.ts` directly — `getProcessLogs(id): Promise<{stdout, stderr}>` is present and documented). This is a genuine, previously-unknown gap in the harness, not a limitation of the sandbox platform. **This is root cause #1** of "we don't know what actually happened" — evidence existed and was never retrieved.

### 5. Exit codes and signals

- `baseline.full.exitCode: 0`, `baseline.selected.exitCode: 0` — both passed.
- `mutant.full.exitCode: 1`, `mutant.selected.exitCode: 1` — both failed after the mutation.
- No `timedOut: true` on any of the four (the process reached `status: "completed"`/`"failed"`, not `"killed"`/`"error"`).

These exit codes are real signal — Vitest's CLI exit code is 0 iff every test in that invocation passed — but they say nothing about *which* tests ran or failed, only that *something* did.

### 6. Generated filesystem artifacts / expected vs. actual report path

Expected: `/workspace/full-baseline.json`, `/workspace/selected-baseline.json`, `/workspace/full-mutant.json`, `/workspace/selected-mutant.json` (from `--outputFile=<path>`, one flat path per invocation — no collision between the four, since `reportName` differs each time).

Actual: `sandbox.readFile()` threw or returned unusable content for **all four** — the persisted `TestRunResult` objects have no `files`/`tests`/`passed`/`failed`/`failedTests` fields at all (JSON.stringify omits `undefined` keys; none of those keys appear in the raw record). **We cannot distinguish, from the original run alone, whether the file was never written (missing) or was written in an unexpected shape (malformed)** — this is root cause #2, and is exactly why Phase 2 of this mission separates `observabilityStatus` into `"missing-report" | "malformed-report" | "complete"` instead of one undifferentiated failure.

### 7. Vitest workspace/project configuration

cal.com uses **Vitest 4.1.8** (confirmed in `yarn.lock`: `vitest@npm:4.1.8`) in **workspace mode** (`vitest.workspace.ts`, ~15 named projects: `@calcom/lib`, `@calcom/features`, `@calcom/ui`, `@calcom/web/components`, etc.), each with its own `include` glob, `environment`, and `setupFiles`. The root `vitest.config.mts` also exists but workspace mode takes precedence for `vitest run` invocations from the repo root.

Vitest 4 is documented (in cal.com's own `vitest.config.mts` comment, verbatim) as having **tightened CLI flag validation**: *"Vitest 4.0 no longer allows custom CLI flags"* / *"Vitest 4.0 doesn't reject them when using yarn test"* — cal.com's own maintainers worked around this by moving custom mode-selection flags to an environment variable (`VITEST_MODE`) instead of CLI flags. This is circumstantial but relevant: Vitest 4's CLI parsing changed in ways that plausibly affect flag forms this harness was relying on.

### 8. The `--outputFile` flag: the most likely single root cause

Vitest's documented behavior for `--outputFile` **when more than one reporter's output could be written, or in some multi-project/workspace configurations, requires dot-notation targeting a specific reporter by name** (`--outputFile.<reporterName>=<path>`), not a bare `--outputFile=<path>`. The original run's profile (`repo-execution-profiles.ts` at that commit) used a single reporter (`--reporter=json`) with a bare `--outputFile=<path>` — plausible under Vitest ≤3 semantics, but Vitest 4's stricter parsing is a credible reason a bare `--outputFile` silently failed to bind to the `json` reporter's output in workspace mode. **This is not yet proven** (Phase 4/5 of this mission will confirm it empirically via the diagnostic rerun, not by this reasoning alone) — flagged here as the leading hypothesis, not a conclusion.

### 9. Shell quoting / argument forwarding through Yarn

Re-read `argvToShellSafe()` and `buildTestCmd()`: paths and flags are quoted only when they contain characters outside `[A-Za-z0-9_.\/=:-]` — none of the four flags or two file paths in this run contain such characters, so quoting is not implicated.

### 10. Did the selected invocation actually run the full suite?

**Unknown from the original run alone.** This is precisely why `runtimeSelection` (the execution-selection invariant, Phase 2) exists and why this mission's Phase 4/5 diagnostic rerun — not further reasoning about the original run — is required before any claim either way. The near-identical wall times (260.4s full vs. 260.5s selected) are *consistent with* either (a) the selection being silently ignored/broadened to the full suite, or (b) the selection being honored exactly but dominated by fixed workspace-bootstrap cost across cal.com's ~15 named projects. **Both remain open until structured evidence — not wall time — resolves it.**

## What this report does NOT conclude

Per the mission's own claim-discipline rule, this report does not claim:
- That the selection was ignored (Outcome A) or honored (Outcome B) — that requires the diagnostic rerun's structured evidence.
- That fixed bootstrap cost is *the* explanation for the flat timing — that also requires confirmed executed-test counts.
- Any recall verdict beyond what the original record already states (`recallMeasurable: false`).

## Cross-reference

See `02-reporting-implementation-report.md` for the concrete fixes made in response to findings #4 and #8 above, and the (pending, at time of writing) diagnostic-rerun report for the empirical resolution.
