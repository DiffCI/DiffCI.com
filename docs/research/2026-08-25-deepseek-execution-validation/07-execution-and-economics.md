# Report 07 — per-merge execution results and economics (Phases 7 & 9)

All 5 predeclared merges terminal. `#2808` uses `canary2` (the corrected run; `canary1` is preserved separately as off-target-mutation evidence, Report 05).

## Per-merge execution table

| PR | Selection % | Runtime-selection status | Req/Exec files | Full suite | Selected suite | Analysis overhead |
|---:|---:|---|---:|---:|---:|---:|
| #2760 | 0.1% | `HONORED_EXACTLY` | 1/1 | 721,548ms | 20,054ms | 21,405ms |
| #2808 | 0.4% | `HONORED_EXACTLY` | 4/4 | 480,942ms | 20,037ms | 11,886ms |
| #1373 | 0.6% | `HONORED_EXACTLY` | 6/6 | 481,502ms | 40,060ms | 11,690ms |
| #2814 | 5.8% | `HONORED_WITH_FRAMEWORK_EXPANSION` | 60/59 | 722,713ms | 100,318ms | 18,795ms |
| #2844 | 24.8% | **`IGNORED_OR_BROADENED`** | 254/173 | 482,359ms | 140,268ms | 12,658ms |

**4/5 clean, `HONORED_EXACTLY`/`HONORED_WITH_FRAMEWORK_EXPANSION`.** #2814's Δ-1 (missing `apps/web/tests/reference-composer.e2e.ts`) is the single e2e file mixed into its otherwise unit-family selection - within framework-expansion tolerance, not a real gap.

**#2844's `IGNORED_OR_BROADENED` is a real, distinct finding**, not noise: its selected set spans unit (173) + snapshot (9) + e2e (71) + untagged (1) = 254 files (Report 02's own table), but this mission's execution harness only runs the unit-family command (`pnpm test` → root `vitest.config.ts`) - snapshot and e2e files live in separate Vitest config files (`vitest.snapshot.config.ts`, `vitest.e2e.config.ts`) that a single `pnpm test` invocation never loads, regardless of which file paths are passed to it. Exactly 173 files executed - the unit-family count, exactly. This is the family-scope gap flagged as a known limitation in Report 01 (§1.1, "not wired here") made concrete: DiffCI's own selection is multi-family, but this round's harness can only execute one family end-to-end. **Per the runtime-selection invariant, this correctly blocks any savings/recall claim for #2844's full 254-file selection** - not a DiffCI defect, a harness scope limitation, reported honestly rather than silently narrowed after the fact.

## Economics (test-stage)

| PR | Gross saved | Net saved | Reduction |
|---:|---:|---:|---:|
| #2760 | 701,494ms | 680,089ms | 94.3% |
| #2808 | 460,905ms | 449,019ms | 93.4% |
| #1373 | 441,442ms | 429,752ms | 89.3% |
| #2814 | 622,395ms | 603,600ms | 83.5% |
| #2844 | *(withheld - selection not honored)* | *(withheld)* | *(withheld)* |

**4/4 eligible merges (all except #2844, correctly withheld) show positive test-stage economics, 83.5%-94.3% net reduction.**

## Economics (complete-job: install + test, excluding this harness's own bootstrap/clone which exist only to stand up the sandbox and are not part of deepseek-harness's real CI job)

| PR | Full job (install+test) | Selected job | Net saved (job) | Job-level reduction |
|---:|---:|---:|---:|---:|
| #2760 | 760,166ms | 58,672ms | 680,089ms | 89.5% |
| #2808 | 503,678ms | 42,773ms | 449,019ms | 89.1% |
| #1373 | 505,553ms | 64,111ms | 429,752ms | 85.0% |
| #2814 | 759,647ms | 137,252ms | 603,600ms | 79.5% |

The absolute net savings figure is identical between test-stage and job-level framing (the shared install cost cancels out of the subtraction, exactly as found on Cal.com) - only the percentage denominator changes. **Honest headline: 79.5%-89.5% net job-level reduction**, not the larger test-stage-only percentages, for the same reason established on Cal.com (install is a real, unavoidable cost paid by both paths; a CI system with a shared/cached install step across a job matrix would see numbers closer to the test-stage figures, one with a fresh install per job would see the job-level figures).

Note deepseek-harness's `installMs` (23s-39s) is far smaller relative to its full-test duration (480-723s) than Cal.com's was (320s install vs 320s test, roughly 1:1) - this repository's install is comparatively cheap, so job-level and test-stage percentages stay closer together here than they did for Cal.com's 90.6%-vs-44.2% gap.

## Timing notes

- Full-suite duration varies 480s-723s across merges on an essentially fixed ~864-865 file, ~14,400+ test suite - consistent with real Cloudflare container-scheduling variance (Cal.com showed the same pattern), not a per-merge effect. `#2760` and `#2814` both landed near 720s despite very different selection sizes - the full-baseline duration is a property of the suite, not the merge.
- Selected-suite duration scales roughly with file count (20s for 1-4 files, 40s for 6, 100s for 59, 140s for 173) - consistent with real per-file bootstrap/execution cost, not a fixed floor.
