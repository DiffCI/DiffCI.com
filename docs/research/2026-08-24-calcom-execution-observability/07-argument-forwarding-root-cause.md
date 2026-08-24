# Report — argument-forwarding root cause: confirmed

**Run:** `exec-calcom-29940-argprobe1` (harness commit `fd92519`, deployed `c6608e9d`; `engineChecksum` unchanged, harness-only). Raw record: `raw-exec-calcom-29940-argprobe1-final-record.json`. cal.com's real `vitest`: **4.1.8**, Node **v22.23.2** (confirmed directly from the stack traces below).

## The user's hypothesis: confirmed, unambiguously

Every command using `yarn test -- <args>` (the harness's real invocation shape) silently ran the **entire ~260-second suite**, exit 0, regardless of what followed the `--`. Every equivalent command **without** the `--` completed in **1–2 seconds**, either succeeding or failing with a real, specific Vitest error. This is not a marginal or probabilistic result — it is exactly the binary signature the hypothesis predicted, across every single comparison:

| Command | Exit | Wall time | What happened |
|---|---:|---:|---|
| `yarn test -- --help` | 0 | **262,965 ms** | Ran the full suite. No help text. |
| `yarn test --help` | 0 | 1,723 ms | Printed real Vitest 4.1.8 help text. |
| `yarn test -- --project "@calcom/lib" --list` | 0 | **265,525 ms** | Ran the full suite. |
| `yarn test --project "@calcom/lib" --list` | 1 | 1,444 ms | `CACError: Unknown option \`--list\`` |
| `yarn test -- --definitely-invalid-diffci-option` | 0 | **258,899 ms** | Ran the full suite. **The smoking gun.** |
| `yarn test --definitely-invalid-diffci-option` | 1 | 1,621 ms | `CACError: Unknown option \`--definitelyInvalidDiffciOption\`` |

The smoking-gun pair is exact: the same nonsense flag is silently ignored (full suite runs) with `--`, and correctly rejected with a real CLI error (`CACError: Unknown option`, from Vitest's own `cac` argument parser, quoted verbatim above) without it.

**Root cause, precisely stated:** it is not that Vitest itself treats a literal `--` in its own argv as "end of options" (the mission's original phrasing). The evidence points to Yarn's own script-argument-forwarding: something about this repository's Yarn version/invocation, when given `yarn test -- <args>`, does not forward `<args>` to the underlying `TZ=UTC vitest run` command at all - the resulting invocation behaves identically to `vitest run` with **zero** extra arguments (matching a bare full-suite run exactly: same ~260s, same silent success, same total absence of `--reporter=json`'s output file). This is consistent with, though not proven to be, a Yarn Berry `--` consumption quirk in this installed Yarn version - the exact mechanism inside Yarn was not traced further, since the practical fix (drop the `--`) is unambiguous regardless of Yarn's internal reason.

**This single bug explains every anomaly found in this mission to date**: the ineffective file-path filter, the ineffective `--project` flag, and the missing JSON report (`--reporter=json --outputFile.json=...` was never forwarded either) - not three independent bugs, one shared cause.

## A second, independent bug found underneath it

Once the `--` is removed, real Vitest errors become visible for the first time - and they reveal `--project "@calcom/lib"` was never going to work anyway, for an unrelated reason:

```
yarn test --no-isolate --project "@calcom/lib" packages/lib/getReplyToHeader.test.ts
  -> Startup Error: No projects matched the filter "@calcom/lib".

yarn exec vitest list --project "@calcom/lib"
  -> Collect Error: No projects matched the filter "@calcom/lib".
```

The second of these goes through `yarn exec vitest list` directly - **completely bypassing Yarn's `test` script and any `--` question entirely** - and still fails identically. This proves the `--project` failure is a **separate, independent problem** from the argument-forwarding bug: Vitest 4.1.8 genuinely does not recognize `"@calcom/lib"` as a project name, even though `vitest.workspace.ts` literally declares `name: "@calcom/lib"`.

**Leading hypothesis (not yet confirmed):** Vitest 4 is documented to have significantly changed workspace configuration (the `vitest.workspace.ts` + `defineWorkspace()` API is deprecated in favor of a `test.projects` array directly inside `vitest.config.ts`). cal.com's own `vitest.config.mts` has no `projects` field - only `vitest.workspace.ts` defines the 15 named projects analyzed in Report 6. It is plausible Vitest 4.1.8 is not reading `vitest.workspace.ts` as a source of named projects at all for `--project` matching purposes, even if it's still used for some other run path - which would also cleanly explain why every unscoped full run (with the bug fixed or not) shows a broad, single-config-driven file count rather than a workspace-aggregated one. **Not yet verified**; flagged as the next thing to check if `--project`-based scoping is still wanted, but not blocking the file-filter fix below.

## The practical fix, and what's still unverified

**Drop the `--` from the harness's command construction.** This is now well-evidenced, not a guess. What remains genuinely unverified: whether a **plain file-path filter with no `--project` and no `--`** actually narrows execution once the forwarding bug is removed - every corrected-command test in this probe still included `--project "@calcom/lib"`, which fails before file filtering is ever reached. The probe's report-check step confirms no JSON file was written in either corrected-command attempt (`NO_REPORT_FILE`), but that's fully explained by the startup error aborting before any tests ran - it does not yet tell us whether the file filter itself works.

**This is the one remaining open question, and it's cheap to test:** `yarn test --no-isolate packages/lib/getReplyToHeader.test.ts` (no `--`, no `--project`, just the real file path) - see the follow-up probe.
