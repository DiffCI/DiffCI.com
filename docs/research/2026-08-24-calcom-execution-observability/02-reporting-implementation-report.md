# Report 3/9 — Reporting/parser implementation report

Implements the fixes and new capabilities the forensic analysis (Report 1) identified as necessary before any further recall or savings claim is trustworthy. Commits: `a07fc26` (observability gate), `8884493` (container-id fix + activation gate). Harness-only — the frozen engine's `engineChecksum` (`f6fd3ec0...`) is byte-identical before and after (confirmed via a fresh `pack` run: same checksum, different `tarballSha256`/`tarballKey` since harness files changed, content-addressed so no collision).

## What changed and why

### 1. Process log capture (`getProcessLogs`)

`src/analysis-fanout/sandbox-like.ts` — added `getProcessLogs(id): Promise<{stdout, stderr}>` to the `SandboxLike` structural interface, matching the real, previously-unused `@cloudflare/sandbox` SDK method.

`src/analysis-fanout/cloudflare/execution-shard-do.ts`, `stepTestRun()` — after a test-run process reaches a terminal state, the harness now calls `sandbox.getProcessLogs()` and captures the last ~8000 characters of stdout/stderr onto `TestRunResult.stdoutTail`/`stderrTail`, **regardless of whether the structured report parsed**. This directly answers Phase 1 Q5 ("did Vitest report file/test counts through console output even though JSON was absent?") for every future run, and gives an audit trail for exactly the failure mode the original run hit.

Kept best-effort: a log-retrieval failure is caught and does not fail the step (`stdoutTail`/`stderrTail` simply stay `undefined`), matching the existing anti-fabrication discipline — missing evidence is represented as missing, not as an empty string implying "nothing happened."

### 2. `--outputFile.json=<path>` instead of `--outputFile=<path>`

`buildTestArgv()` now uses Vitest's dot-notation form. This is **general and repository-independent** — it targets the `json` reporter by name regardless of how many *other* reporters are configured, so it doesn't regress if a profile lists additional reporters (which cal.com's profile now does — see below) and doesn't depend on `json` being the only reporter registered. Chosen over investigating a hand-rolled custom Reporter class (which the mission allows as a fallback) because it is the smaller, more general change, and Phase 1's own evidence had not yet ruled out a straightforward flag-syntax cause — writing a custom reporter first would have been solving a problem not yet confirmed to exist.

### 3. A second, human-readable reporter for cal.com

`src/analysis-fanout/repo-execution-profiles.ts` — cal.com's `reporterArgv` is now `["--reporter=json", "--reporter=default"]`. The `json` reporter alone prints nothing to stdout; adding `default` means the process's own console output (now captured per #1) contains Vitest's normal human-readable summary line (`Test Files  N passed (N)` / `Tests  M passed (M)`), which is the direct cross-check Phase 4.4 asks for ("compare console output with structured output") and Phase 1 Q5 needs answered.

### 4. `ObservabilityStatus` — missing vs. malformed, never conflated with "zero"

New type on every `TestRunResult`: `"complete" | "missing-report" | "malformed-report"`. Computed as: `parsed.parsed ? "complete" : (raw is undefined OR raw is empty-after-trim) ? "missing-report" : "malformed-report"`. The empty-string case was deliberately folded into `"missing-report"` (not `"malformed-report"`) after a test-writing exercise surfaced that a zero-byte file and a genuinely-thrown "file not found" are the same failure mode operationally (no report was ever produced) and should not be diagnosed as if a parser bug were involved.

Every downstream consumer (`computeEconomicsAndRecall`) now checks this status explicitly rather than treating an absent `.failed`/`.passed` field as an implicit zero.

### 5. The execution-selection invariant (`classifyRuntimeSelection`)

New pure function, exported for direct unit testing: compares `requestedTestFiles.length` (what DiffCI asked for) against the parsed report's own `files` count (what Vitest says it ran), classifying as `HONORED_EXACTLY` / `HONORED_WITH_FRAMEWORK_EXPANSION` (±3 files, an explainable framework-required overage) / `IGNORED_OR_BROADENED` (larger overage, **or** a shortfall — a shortfall is also flagged, not silently accepted, since it can indicate a path/pattern mismatch) / `UNMEASURABLE` (no parseable report). Wired into `selectedBaseline`'s `applyResult`, so `record.runtimeSelection` is populated automatically on every future selected-baseline run.

### 6. Economics gated on the invariant

`computeEconomicsAndRecall()` now only populates `record.economics` when `runtimeSelection.status` is `HONORED_EXACTLY` or `HONORED_WITH_FRAMEWORK_EXPANSION`. An `IGNORED_OR_BROADENED` or `UNMEASURABLE` classification means `economics` stays `undefined` — the harness can no longer report a "savings" number computed from a selection that wasn't actually honored at runtime. Verified by two new tests that assert `economics === undefined` under both disqualifying classifications, with baseline wall-times that would otherwise have produced a plausible-looking (positive) savings number.

### 7. Recall requires genuine observability on both mutant runs

`computeEconomicsAndRecall()`'s recall computation now checks `observabilityStatus === "complete"` for each of `mutant.full`/`mutant.selected` before treating a missing `.failed` field as "no failure" — previously `(record.mutant.full.failed ?? 0) > 0` silently treated an unparsed report the same as a genuine zero-failure pass. `recallMeasurable` is now `fullObservable && fullCaught === true` explicitly, not merely `fullCaught` (which could itself have been a coerced `false` from an absent field).

### 8. Concurrent-run collision fix (`sandboxContainerId`)

Found while enumerating the Phase 3 test list ("concurrent runs do not collide"): the sandbox container name was `exec-${repoSlug}-${mergeSha.slice(0,10)}`, keyed only on repository + merge SHA — **not** `runId`. Two different runs targeting the same merge (exactly this mission's own diagnostic-rerun scenario) would land on the identical underlying container and identical `/workspace/*.json` report paths, silently overwriting each other's evidence mid-run. Fixed by folding a sanitized, truncated `runId` into the container name. **Deployed only after the in-flight diagnostic run (`exec-calcom-29940-diag2`, still using the old naming scheme) reached a terminal state** — redeploying mid-run would have orphaned its process (the DO recomputes the container handle fresh on every `alarm()`).

### 9. Economic activation gate (`activation-gate.ts`)

New, fully independent pure module (`decideActivation()`): `SAFE_TO_PROPOSE` (correctness only) vs. `ECONOMICALLY_BENEFICIAL` (timing math alone) vs. `EXECUTE_SELECTIVELY` (both) vs. `RUN_FULL_SUITE` (correctness-unsafe). Policy: `gross savings > analysis overhead + planning overhead + uncertainty margin`, where the margin scales with predicted full-suite duration (not a flat constant) and any run with fewer than 3 samples is labeled `lowConfidence: true` rather than silently treated as reliable. Directly verified against cal.com PR #29940's own real numbers as a regression test: correctly resolves to `SAFE_TO_PROPOSE`, not `EXECUTE_SELECTIVELY`.

## Tests added, this report's scope

48 tests in `execution-shard-do.test.ts` (up from 30) + 8 in the new `activation-gate.test.ts` = 56 net-new/modified assertions covering items 1–9 above. Full breakdown and suite-wide totals are in Report 3 (targeted-tests report), not duplicated here.

## What this report does not claim

This report describes what was **built**, not what the diagnostic rerun **found**. No claim is made here about whether cal.com's original run actually ran 2 tests or 424 — that is Report 4/5's job, using this implementation's own output.
