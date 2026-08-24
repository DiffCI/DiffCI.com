# Report — plain file filter confirmed working; corrected command deployed

**Run:** `exec-calcom-29940-plainfilter1`. Raw record: `raw-exec-calcom-29940-plainfilter1-final-record.json`. `diagnosing` completed in **21 seconds** (vs. ~13 minutes for the `--project` probe) - the single strongest signal, on its own, that narrowing finally worked.

## Result: selective execution genuinely works once the `--` is dropped

| Command | Test Files | Tests | Wall time |
|---|---|---|---:|
| `yarn test --no-isolate packages/lib/getReplyToHeader.test.ts` | **1 passed (1)** | 8 passed (8) | 3.7s |
| `yarn test --no-isolate apps/web/.../route.test.ts` | **1 passed (1)** | 12 passed (12) | 3.4s |
| `yarn test --no-isolate` *(both files - the real DiffCI selection)* | **2 passed (2)** | 20 passed (20) | 3.7s |
| `yarn test --no-isolate packages/lib/this-file-absolutely-does-not-exist.test.ts` | **0** - "No test files found, exiting with code 0" | - | 2.2s |

Every result is exact: 1 file requested → 1 executed; 2 requested → 2 executed; a nonexistent file → 0 executed with a clean, correct exit, not a silent full-suite fallback. Runtime selection classification for the real 2-file case: **`HONORED_EXACTLY`.**

Per-file wall time also confirms the earlier "fixed bootstrap cost" hypothesis (originally proposed, then set aside once the `--` bug was found) genuinely applies **once selection actually works**: ~3.5s total per invocation, of which the real test execution is single-digit milliseconds (`9ms`, `18ms`, `54ms` in the Vitest summaries) - the rest is Vite/environment bootstrap, which is now a small, bounded cost instead of ~260 seconds.

## The JSON reporter also works now

```
yarn test --no-isolate --reporter=json --reporter=default --outputFile.json=/workspace/plain-report.json <2 files>
```

produced a real 7,735-byte report: `numTotalTests: 20, numPassedTests: 20, numFailedTests: 0, success: true`, with full per-test `assertionResults` including `getReplyToHeader with hideOrganizerEmail and customReplyToEmail uses customReplyToEmail even when hideOrganizerEmail is true` - directly the behavior this merge's fix touches. The JSON-reporter gap from Reports 2/3 is resolved as a side effect of the same `--` fix; no separate reporter change was needed.

## A parser bug found and fixed along the way

The report's `numTotalTestSuites` field read **14** for this genuine 2-file run - not 2. Vitest's JSON reporter counts nested `describe` blocks as "suites" in this version, not files (`getReplyToHeader.test.ts` alone has 6+ nested describe paths). `testResults.length` (one entry per file, both files present) is the correct, reliable file count. Fixed in `src/analysis-fanout/vitest-report.ts`: `files` now derives from `testResults.length` when non-empty, falling back to `numTotalTestSuites` only when `testResults` is absent/empty. Two new tests added (`tests/analysis-fanout/vitest-report.test.ts`), all 10 pass.

## Corrected command deployed as the new default

`src/analysis-fanout/repo-execution-profiles.ts`'s cal.com entry: `testArgv` changed from `["test", "--", "--no-isolate"]` to `["test", "--no-isolate"]`. This is not scoped to selective runs only - **every full-suite baseline measurement in this mission's history before this fix was also silently missing `--no-isolate`** (the same swallow bug applies with or without trailing file paths), so prior full-suite timing figures do not reflect real CI's actual behavior and must not be trusted for economics without a re-measurement under the corrected command.

## What this means for the mission's open questions

- **Does file-level selection reduce wall time for cal.com?** Now plausible and worth re-testing properly - the individual single-file runs (3.4-3.7s) versus what a corrected full-suite run will show is the real comparison to make, not yet measured.
- **Is `--project` still worth pursuing?** No longer necessary for file-level granularity - plain file filtering already achieves `HONORED_EXACTLY`. The separate `--project`/workspace-recognition question (Report 7) remains open but is now lower priority.
- **Next required step, per the mission's own "do not optimize the numbers" discipline:** a full, controlled baseline/selected/mutant run under the corrected `testArgv`, on `exec-calcom-29940` again (a fresh runId, same merge), to get real, trustworthy economics - not another diagnostic probe. This is the natural next action, not yet performed.
