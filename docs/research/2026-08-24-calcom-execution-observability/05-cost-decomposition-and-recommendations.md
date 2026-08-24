# Reports 7+8+9/9 — Cost decomposition, execution-unit recommendation, limitations & next experiment

## Cost decomposition and break-even (Report 7)

Real numbers from `exec-calcom-29940-diag2` (both runs; the original run's numbers, `260.4s`/`260.5s`/`8.5s`, are consistent within noise):

| Component | Value |
|---|---|
| Analysis overhead (self-derived selection, real measurement) | 10,089 ms |
| Full-suite wall time | 244,594 ms |
| "Selected"-suite wall time | 247,866 ms |
| Gross "savings" | **−3,272 ms** (selected was slower) |
| Uncertainty margin (2% of full duration, single-sample — conservative but still nonzero) | 4,892 ms |
| Required savings to activate (overhead + margin) | 14,981 ms |
| Net savings | **−18,253 ms** |

Run through `decideActivation()` (`src/analysis-fanout/activation-gate.ts`, verified by `tests/analysis-fanout/activation-gate.test.ts`):

```
correctnessSafe: true   (the frozen engine's own analysisStatus was SAFE_TO_PROPOSE)
economicallyBeneficial: false
decision: SAFE_TO_PROPOSE   (NOT EXECUTE_SELECTIVELY)
lowConfidence: true   (1 sample)
```

**The gate correctly refuses to activate selective execution for this merge.** This is true regardless of the runtime-selection bug — even setting that aside, the measured numbers alone would not clear the bar. Once the selection-narrowing bug (Report 3) is fixed, this decomposition must be recomputed from scratch; today's numbers describe "two full-suite runs plus overhead," not "a genuine selective run."

## Best safe execution unit for cal.com (Report 8)

Given what is now confirmed:
- File-level positional filtering (`vitest run <path1> <path2>`) does not narrow execution in cal.com's Vitest 4 workspace-mode configuration.
- `--project <name>` exists and is documented, but filters by **named project**, not by individual file — cal.com's workspace defines ~15 projects, several of which are large (`@calcom/lib` alone spans most of `packages/**`), so project-level filtering would be a much coarser unit than DiffCI's own file-level selection, though still likely far narrower than the full 406 files.
- No experiment has yet been run confirming that **any** command shape narrows execution for this repository — this is not yet known, only hypothesized.

**No execution unit can be recommended yet.** Recommending one now would be guessing ahead of evidence, which the mission explicitly prohibits. Report 9 below specifies the exact next experiment needed to answer this.

## Remaining limitations (Report 9, part 1)

1. **The JSON reporter still doesn't produce a readable report**, even with the `--outputFile.json=` dot-notation fix — `observabilityStatus: "missing-report"` on all four test-run steps of the diagnostic rerun. The `default` console reporter is the only working structured(ish) signal today. Root cause not yet found; a custom Vitest reporter (as the mission allows as a fallback) has not yet been attempted.
2. **`stdoutTail`'s 8000-character cap is too short to capture failure attribution** on a 4126-test run — it reliably captures the final summary but not the `FAIL`/`✗` block for an individual failing test, which prints much earlier in a large run's output. This blocked confirming which test the mutation-recall failure was (Report 6).
3. **Runtime-selection classification (`classifyRuntimeSelection`) only compares structured-report file counts** — it cannot classify from console text alone, so it correctly (conservatively) returned `UNMEASURABLE` on this run even though a human reading the captured console output can see `IGNORED_OR_BROADENED` with high confidence. A console-text fallback parser would close this gap.
4. **DiffCI's own `totalTestsInGraph` (424) vs. Vitest's real file count (406)** — a modest, unexplained discrepancy, out of scope for this mission but worth its own investigation.
5. **Only one merge (PR #29940) has been examined.** Per the mission's explicit instruction, this must not be generalized to "cal.com's execution is/isn't economical" — that claim is not made anywhere in this report set.

## Exact next recommended experiment (Report 9, part 2)

Per Phase 4's "smallest faithful experiment" principle, before any further full Cloudflare pipeline run:

1. **A minimal, cheap, LOCAL-repo-config-inspection step (no target-repo execution — reading `vitest.workspace.ts`'s `include` globs against known file paths) to determine which of cal.com's ~15 named projects `apps/web/app/api/verify-booking-token/__tests__/route.test.ts` and `packages/lib/getReplyToHeader.test.ts` actually belong to.** This is pure static analysis, consistent with "always use Cloudflare" (that rule concerns *running* target-repo code, not reading its config files) and costs seconds, not minutes.
2. **One bounded Cloudflare diagnostic run** (not the full 11-step pipeline — a cheap, targeted probe once the harness supports it) testing three candidate command shapes against the SAME two files, each compared against its own console summary line:
   - (a) `--project <name(s) from step 1>` combined with the existing file-path positional filter (narrower project scope + file filter together).
   - (b) A direct, per-project `vitest run` invocation (`cd <project root or use --dir>`) bypassing workspace-mode filtering entirely, if cal.com's project structure allows it.
   - (c) The current shape again, as a control, to confirm reproducibility (was `IGNORED_OR_BROADENED` a one-off flake or does it reproduce reliably?).
3. **Fix or replace the JSON reporter** (Limitation #1) before or alongside this — a working structured report turns "eyeball the console summary" into an automated, auditable `classifyRuntimeSelection()` verdict, and is needed regardless of which command shape wins.
4. **Only after a command shape is confirmed (via structured report, not console-reading) to produce `HONORED_EXACTLY` or `HONORED_WITH_FRAMEWORK_EXPANSION`** should the full 7-invocation statistical timing protocol (Phase 5) run — on that shape, not the current broken one.
5. **Bounded next sample, predeclared rule (not favorable-savings-biased):** once a working command shape exists, the next 3–5 cal.com merges should be the ones with the smallest `changedFiles` count and `SAFE_TO_PROPOSE` verdict from the existing 30-merge selection manifest, in manifest order — chosen for being simplest to reason about and cheapest to run, not for expected savings.

**Do not run this next experiment automatically as a continuation of the current mission** — it involves new command-shape guesses that should be reviewed before spending further Cloudflare compute, per the mission's own "do not optimize the numbers" and "do not expand scope prematurely" discipline.
