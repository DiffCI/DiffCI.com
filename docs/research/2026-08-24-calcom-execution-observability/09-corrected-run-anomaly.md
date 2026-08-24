# Report — corrected-run anomaly: `--no-isolate` may never have been safely exercised full-suite

**Run:** `exec-calcom-29940-corrected1` - **cancelled**, not completed. Cancelled manually after the `full-baseline` step's underlying Vitest process ran for **1,231 seconds (20.5 minutes)** with no error and an actively-updating heartbeat (confirmed not orphaned - the DO's poll loop was alive and responsive throughout), versus **~250-260 seconds** observed in every prior run of what was believed to be the same command. This is a real, unresolved anomaly, not a harness bug being papered over - documented here plainly rather than silently retried.

## The discovery this surfaces: no prior "full suite" measurement in this mission ever actually used `--no-isolate`

Re-examining every full-suite timing figure gathered across this entire mission (`diag2`, `projfilter1`, and every `--`-prefixed command in `argprobe1`) against the now-confirmed root cause (Report 7: `yarn test -- <anything>` silently drops everything after `--`, running plain `vitest run` with **zero** extra arguments): **every one of those "full suite" runs was actually running with Vitest's default `--isolate` behavior (isolation ON, one process per file), not `--no-isolate` as intended.** The consistent ~250-260s timing across all of them is the cost of running cal.com's ~406-424 test files **in isolation**, not the `--no-isolate`-optimized cost real CI relies on.

`exec-calcom-29940-corrected1` is the **first run in this entire mission where `--no-isolate` genuinely reached Vitest for a full, unfiltered suite run** (the corrected `repo-execution-profiles.ts` from Report 8 has no `--`, and this run supplied no file filter for its `full-baseline` step). Instead of being faster (which is `--no-isolate`'s entire purpose - shared worker processes instead of one-per-file), it ran for at least 20.5 minutes with no sign of finishing.

## What this could mean (stated as hypothesis, not fact)

Plausible, not yet confirmed:
- **`--no-isolate` may have real reliability/performance risk for cal.com's full suite specifically** - without per-file process isolation, shared module/mock state across 406 files could accumulate (memory pressure, leaked timers/mocks, cross-test interference) in ways that degrade badly at full-suite scale, even though it works perfectly for a 1-2 file selective run (confirmed fast and correct in Report 8).
- This would also explain something otherwise unremarked-on: cal.com's own `.github/workflows/unit-tests.yml` gives the **entire** unit-test job (install + prisma generate + `--no-isolate` full run + a second timezone-mode `--no-isolate` full run) a **20-minute** timeout budget - generous enough to suggest the team already expects real variance or occasional slowness in this exact command shape, possibly for exactly this reason.
- Alternatively, this could be infrastructure-level (Cloudflare container resource contention on this specific run, unrelated to `--no-isolate` itself) - not yet distinguished from the above.

**Not claimed as confirmed.** The evidence supports "something about running `--no-isolate` across the full 406-file suite is much slower than running it against 1-2 files, or than running the full suite with isolation" - it does not yet establish which of the above explanations is correct.

## Why this run was cancelled rather than left running

The harness has a real, previously-unflagged gap: test-run steps (`stepTestRun` in `execution-shard-do.ts`) poll indefinitely via `POLL_MS` with no maximum step duration - if the underlying process never terminates, the DO would poll forever, consuming real Cloudflare compute with no self-recovery. This run was manually cancelled at the 20.5-minute mark (matching cal.com's own CI timeout convention as a reasonable ceiling) specifically because that gap exists. **Recommended follow-up, not yet implemented:** a configurable maximum step duration in `ExecutionStepDeps`/`RepoExecutionProfile`, after which a test-run step self-terminates with a clear `timedOut`/`errorClass`, rather than relying on manual intervention.

## What is and isn't affected by this

- **Report 8's selective-execution finding stands unaffected.** `HONORED_EXACTLY`, 1-2 files, 3.4-3.7 seconds each, is real, fast, directly observed, structured-report-confirmed evidence - nothing about the full-suite anomaly calls that into question.
- **No economics or recall numbers exist yet under the corrected command shape** - this run was cancelled before `selected-baseline` (which, per Report 8, should still be fast) or the mutant steps ever ran. Reports 3-6's economics figures (all using the un-corrected, accidentally-isolated `--` command) remain the only numbers gathered so far, and per Report 8's own note, do not reflect real CI behavior either.
- **The "should DiffCI activate selective execution for cal.com" question is still open**, now for a different reason than before: not because selection doesn't work (it does), but because a trustworthy *full-suite baseline* to compare it against has not yet been successfully measured under the real, corrected command.

## Recommendation

Do not immediately retry the identical full-suite run and hope it resolves. Before spending more Cloudflare compute:
1. Investigate the `--no-isolate` full-suite slowdown directly and cheaply - e.g. a diagnostic probe running `--no-isolate` against a deliberately small subset of the suite (10-20 files, not all 406) to see if the slowdown scales linearly, superlinearly, or is a hang independent of file count.
2. Add the maximum-step-duration safeguard above before running another full-suite attempt, so a repeat of this situation self-terminates with clear evidence instead of requiring manual cancellation.
3. Only then re-attempt the full controlled baseline/selected/mutant run this report's run was meant to produce.
