# Report — project-qualified command-shape experiment

**Run:** `exec-calcom-29940-projfilter1` (harness commit `aece854`, deployed `c4b09b90`; `engineChecksum` unchanged: `f6fd3ec0...`, byte-identical). Same merge, same base as every prior run in this mission. Raw record preserved at `raw-exec-calcom-29940-projfilter1-final-record.json`.

**Command shape tested:** `testArgvOverride: ["test", "--", "--no-isolate", "--project", "@calcom/lib"]`, applied symmetrically to both the "full" and "selected" test-run steps — a within-project comparison (full run of `@calcom/lib` vs. the same 2 files scoped to `@calcom/lib`), not a repo-wide-vs-narrow comparison, per the design reasoning in Report 5.

## Local pre-checks (steps 1–2, read-only, no execution)

Rigorously verified via Node's built-in `path.matchesGlob` against the real `vitest.workspace.ts` include/exclude arrays: both `apps/web/app/api/verify-booking-token/__tests__/route.test.ts` and `packages/lib/getReplyToHeader.test.ts` are owned by exactly one project, `@calcom/lib`, unambiguously — confirmed correct project name for this candidate.

## Result: disqualified — the combination does not narrow execution

| | `--project "@calcom/lib"` only | `--project "@calcom/lib"` + 2 files |
|---|---|---|
| Test Files | 401 passed, 5 skipped (**406**) | 401 passed, 5 skipped (**406**) |
| Tests | 4076 passed, 47 skipped, 3 todo (**4126**) | 4076 passed, 47 skipped, 3 todo (**4126**) |
| Duration | 250.30s | 246.06s |

Identical to each other, and identical digit-for-digit to the *unscoped* baseline from `exec-calcom-29940-diag2` (Report 3). Applying the mission's own success gate:

```
selection honored                    -> FAILS (406 executed vs. 2 requested)
AND structured report complete       -> FAILS (observabilityStatus: "missing-report", both runs)
AND mutation-relevant failure detected -> UNCONFIRMED (same attribution gap as before)
AND selected wall time < full wall time -> FAILS (246.1s vs. 250.3s - within noise, not a real reduction)
AND net savings > overhead + margin  -> FAILS (no real savings to net against overhead)
```

**This candidate is disqualified on the first condition alone.** File-path filtering has zero measured effect whether or not `--project` is also supplied.

## Mutation pass (for completeness)

Both `mutant.full` and `mutant.selected` again show identical results to each other: 406 files, 1 new failure (0→1, same signature as every prior mutation pass in this mission). Since both runs are confirmed to be executing the same 406-file set, this doesn't add new evidence about selection quality — it's the same "full suite twice" situation as Reports 3/4, just now also carrying the `--project` flag. `recallMeasurable: false`, same root cause (JSON report still doesn't parse).

## The ambiguity — resolved locally, at zero Cloudflare cost

Two explanations were initially consistent with "the numbers came out identical": (1) `--project` has no effect at all, or (2) `@calcom/lib` genuinely is cal.com's catch-all project, containing ~406 of ~406 total test files, so the flag works but this PR's files happened to pick the least-narrowing project available.

**Resolved by a local, read-only static count** (Node's `path.matchesGlob` against all 424 real test files on disk in the local clone, matched against every project's real `include`/`exclude` globs from `vitest.workspace.ts` — zero execution, zero Cloudflare compute):

| Project | Files owned (static count) |
|---|---:|
| `@calcom/lib` | **334** |
| `@calcom/ui` | 33 |
| `@calcom/web/modules/views` | 14 |
| `@calcom/embeds` | 10 |
| 6 other projects | 3 or fewer each |
| *(owned by no project — would be silently dropped in a real workspace run)* | 20 |

`@calcom/lib` is indeed the largest project by a wide margin, but it owns **334** files, not 406. The `--project "@calcom/lib"` run in this experiment executed **406** — matching the *full unscoped* workspace total (401+5 in Report 3), not the 334 that correct project-scoping would produce. **This confirms explanation (1): the `--project` flag had no measurable effect**, not merely "a big but real project." The 72-file gap (406 vs 334) is far too large to be noise or an imprecise glob reconstruction (the reconstructed globs' own summed total, 424−20=404, matches the real observed 406 within 2 files, confirming the reconstruction itself is accurate).

## Recommendation, updated

The next live experiment does **not** need to worry about picking a "fairer" project — the flag itself doesn't work, independent of which project's files are targeted. Before spending more Cloudflare compute on command-shape guessing:

1. The JSON-reporter gap (Report 2/3) remains open and independent of this question — worth fixing first, since it blocks confirmed evidence (not console-scraping) on any future candidate.
2. `--project` and the positional file filter have both been ruled out for this repository's `yarn test -- --no-isolate` invocation shape. Remaining untested candidates per the mission's own list: direct per-project invocation bypassing workspace mode entirely (e.g. a project-specific `vitest.config` invoked directly, if cal.com's structure permits it) — this is meaningfully different from `--project` (which apparently doesn't filter within workspace mode) and is the next reasonable thing to try, but should wait for explicit direction rather than being launched automatically.

## Updated recommendation

**Still no** — DiffCI should not activate selective execution for cal.com's current command shape. Both tested narrowing mechanisms (file-path filter, `--project` flag) are confirmed ineffective, not just untested-favorably. No further live cal.com merges should run until either a genuinely different command mechanism is identified and approved, or the JSON-reporter gap is fixed.
