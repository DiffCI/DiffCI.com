# Reports 4+5/9 — PR #29940 controlled rerun & runtime-selection verification

**Run:** `exec-calcom-29940-diag2` (harness commit `a07fc26` + `8884493`'s activation-gate, deployed at `365c5004`; `sandboxContainerId` fix committed but deliberately NOT deployed until this run finished, to avoid orphaning its in-flight process). Same merge, same base, same frozen `engineChecksum` (`f6fd3ec0...`, byte-identical to the original run — confirmed by a fresh `pack`). Persisted record: `runs/exec-calcom-29940-diag2/calcom__cal.diy/execution-176037d0af.json`.

**This is a single instrumented rerun, not yet the full 7-invocation statistical protocol Phase 5 specifies** — see "What this report does not do" below for why, and the recommended next step in Report 9.

## The central question, answered

> **Did Vitest actually execute only the two selected tests?**

**No.** Both `baseline.full` and `baseline.selected` console output (captured via `getProcessLogs`, for the first time ever on this harness) show **identical results**:

| | Full baseline | Selected baseline (2 files requested) |
|---|---|---|
| Test Files | 401 passed, 5 skipped **(406)** | 401 passed, 5 skipped **(406)** |
| Tests | 4076 passed, 47 skipped, 3 todo **(4126)** | 4076 passed, 47 skipped, 3 todo **(4126)** |
| Vitest's own reported duration | 241.53s | 234.28s |
| Harness-measured wallMs | 244,594 | 247,866 |

The "selected" invocation, despite being given exactly two file paths on its command line, ran the **entire cal.com unit-test workspace** — the same 406 files and 4126 individual tests as the full run, within measurement noise. This is unambiguous: not a marginal overage (which `HONORED_WITH_FRAMEWORK_EXPANSION` would tolerate), the full suite ran.

## Classification: `IGNORED_OR_BROADENED` (confirmed, not `HONORED_*`)

The automated `classifyRuntimeSelection()` recorded `UNMEASURABLE` on this run, **not** `IGNORED_OR_BROADENED` — because the structured JSON report itself never parsed (`observabilityStatus: "missing-report"` on all four test-run steps, even after the `--outputFile.json=` dot-notation fix; see "Root cause, partially resolved" below), and the classifier only compares the parsed report's `files` count, not console text. This is a known, accepted limitation of the current classifier (it does not parse the `default` reporter's human-readable summary) — but the manual evidence above is unambiguous enough that this report classifies the runtime selection as **`IGNORED_OR_BROADENED`** by direct human inspection of the preserved console output, overriding the automated (more conservative) `UNMEASURABLE` label for the purpose of this analysis. The raw evidence (both full stdout blocks) is preserved verbatim in the persisted `ExecutionRecord` for independent verification.

**Outcome A, per the mission's own classification, is confirmed:** selection was ignored. Per the mission's explicit instruction for this outcome, **the original 99.5% reduction is static-analysis-only** — it describes what DiffCI's graph believed was relevant, not what actually ran. Runtime selection is not effective for cal.com's current command shape, and equal timing must **not** be attributed primarily to fixed bootstrap cost (Outcome B's explanation) — the real cause is that both invocations did the same work.

## Root cause, partially resolved

Two independent root causes were in play, and this rerun resolved one but not the other:

1. **The JSON report never parsed, on any of the four runs, even with `--outputFile.json=<path>` dot-notation.** `observabilityStatus: "missing-report"` throughout. This means the `--outputFile.json=` hypothesis from Report 1/2 (the leading candidate for *why the report went missing*) is **not confirmed as sufficient** — something about the JSON reporter's file output still isn't landing where/how this harness expects, even corrected for the dot-notation syntax. The `default` reporter's stdout WAS successfully captured (proving the process itself ran and Vitest's console output is real and readable) — so this is specifically a JSON-reporter/`--outputFile` issue, not a general process-observability failure. **Unresolved**; flagged as the top follow-up for the reporting layer.

2. **The positional file-path filter had no effect in cal.com's Vitest workspace mode.** Per Vitest's own documentation (fetched live during this investigation): the filter is "a simple inclusion check... matching any file whose path contains the provided string" — a substring match, which `apps/web/app/api/verify-booking-token/__tests__/route.test.ts` should satisfy trivially against itself. Vitest's docs **do not describe** how this interacts with workspace/projects mode, and empirically, in cal.com's 15-named-project workspace, it did not narrow execution at all. This is the primary, now-confirmed root cause of the flat timing in both the original and this rerun.

## Secondary finding: DiffCI's `totalTestsInGraph` undercounts cal.com's real test-file universe

DiffCI's static graph reported `totalTestsInGraph: 424`. Vitest's own real run found `406` test files (`401 passed + 5 skipped`) containing `4126` individual test cases. 424 vs. 406 files is a modest (~4%) discrepancy, plausibly explained by DiffCI counting some non-executed/duplicate-path nodes or a slightly different file-discovery glob than Vitest's own `include`/`exclude` workspace config. Not investigated further in this report (out of scope for the execution-observability mission) but noted as a real, independent discrepancy worth a separate, focused look.

## What this report does not do

Per the mission's own "do not expand scope prematurely" and "do not optimize the numbers" rules:
- **Does not** run the full 7-invocation statistical timing protocol (warm-up + randomized full/selected order + median/dispersion) — doing so on a selection that's confirmed to run the identical full suite either way would measure full-vs-full noise, not full-vs-selected savings, and would not be a meaningful use of the additional ~30+ minutes of Cloudflare compute it requires. Once the filter-narrowing root cause is fixed (see Report 9's recommended next experiment), the statistical protocol becomes meaningful and should be run then, not before.
- **Does not** attempt a `--project`-flag or per-project-invocation experiment inline in this run — Report 9 specifies this precisely as the next bounded experiment rather than guessing live against production Cloudflare compute.
- **Does not** conclude cal.com's execution-unit question (Report 8) — that depends on first confirming whether ANY command shape can actually narrow execution, which remains open.

## Mutation results for this rerun

See Report `04-mutation-recall-evidence.md` for the full-mutant/selected-mutant results and recall attribution — captured once this diagnostic run reaches its terminal state.
