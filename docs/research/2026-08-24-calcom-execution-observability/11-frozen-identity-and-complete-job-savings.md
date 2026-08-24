# Report — frozen identity, complete-job savings, and predeclared next-merge selection

## 1. Frozen engine and harness identities

- **Frozen engine checksum:** `f6fd3ec007181beb779c7f078ee52aa4017d44af71e1423e2cabf700c0d9ae87` (`docs/research/blind-baseline-2026-08-23/2026-08-24-diffci-adapted-build-manifest-v2.json`) - **unchanged across every run in this entire mission**, from the first `exec-calcom-29940-1787565401` attempt through `exec-calcom-29940-isolated1`. Every fix made this session (`getProcessLogs`, `--outputFile.json=`, the execution-selection invariant, `sandboxContainerId`, `testArgvOverride`, the diagnostic-probe mode, the parser's `testResults.length` fix, dropping `--` from cal.com's `testArgv`, the max-step-duration safeguard, and universal failure persistence) is harness-only. This is verified, not assumed - every `pack` invocation this session re-ran `verify-frozen-engine.cjs` and reported the identical checksum.
- **Harness identity for the confirmed-positive result (Report 10):** git commit `c1b600f`, Worker deployment version `2c862770-7d75-4296-ac04-53696fc2c5c4`, cal.com profile `testArgv: ["test"]` via `testArgvOverride` (default isolation - the repo-execution-profiles.ts default is `["test", "--no-isolate"]`, not yet re-validated at full-suite scale per Report 9).
- **All raw artifacts preserved**, never overwritten: `raw-exec-calcom-29940-{1787565401,diag2,projfilter1,argprobe1,plainfilter1,corrected1,isolated1}-final-record.json`, plus the 10 markdown reports (`01` through `10`) documenting each stage's evidence and reasoning in order.

## 2. Complete-job savings, not just test-stage

Report 10 quoted a 90.6% reduction computed over the **test stage alone** (`fullTestMs` vs `selectedTestMs`). That is correct for what it measures, but overstates the real CI-job-level benefit, because it excludes `install` and `pretest` (`yarn prisma generate`) - fixed costs both the full and selected paths pay identically, and a real part of cal.com's actual CI job duration.

Recomputed over `install + pretest + test` (excluding this harness's own `bootstrap`/`clone` steps, which exist only to stand up DiffCI's sandbox and are not part of cal.com's real CI job at all):

| | Full path | Selected path |
|---|---:|---:|
| install | 319.7s | 319.7s *(identical, paid either way)* |
| pretest (`prisma generate`) | 17.1s | 17.1s *(identical, paid either way)* |
| test | 320.9s | 20.0s |
| **Job-equivalent total** | **657.7s** | **356.9s** |

```
grossSavedJobMs: 300,808   (identical in absolute terms to the test-stage figure - the fixed costs cancel out of the difference)
netSavedJobMs:   290,719   (same absolute net savings)
jobReductionPct:      45.7%   (gross, vs the test-stage-only 93.8%)
jobNetReductionPct:   44.2%   (net, vs the test-stage-only 90.6%)
```

**The honest headline number is ~44% net job-level reduction, not ~91%.** Both are real and both matter for different purposes (the test-stage number is what a CI system would see if install were already cached/shared across a job matrix, which is exactly how cal.com's own `unit-tests.yml` and most real CI setups actually work - a single `yarn-install` composite action runs once, with test/lint/build/etc. as separate jobs consuming the same cached `node_modules`). Both figures are reported here rather than picking the more flattering one.

## 3. Predeclared selection of 3-5 additional cal.com merges

Per the explicit instruction to select by a predeclared, non-cherry-picked rule - decided and written down **before** looking at what any of these merges would cost to run:

**Rule:** From the existing 30-merge blind-baseline manifest, take every row with `analysisStatus === "SAFE_TO_PROPOSE"` **and** at least one changed `source`-category file (excludes docs/asset/config-only changes - 24 of 30 rows qualify). Sort by `affectedTests` (DiffCI's own selected-set size - a structural property, never a timing prediction) ascending, PR number as a deterministic tiebreak. Select 5 merges evenly spaced by **rank position** across the sorted list (indices 0, 25%, 50%, 75%, 100% of 24 candidates) to maximize selected-set-size diversity without reference to expected wall-clock cost.

**Result** (this selection was not adjusted after seeing it):

| PR | Selected tests | Changed files | Subject |
|---:|---:|---:|---|
| #29529 | 1 | 3 | fix: remove console.log and improve type safety in tRPC routers |
| #29819 | 1 | 11 | feat: add Clara app (link-as-an-app, AI & Automation) |
| #29583 | 2 | 2 | fix: return 404 when booking does not exist |
| #29541 | 3 | 2 | fix(daily-webhook): use BookingRepository instead of direct prisma call |
| #28567 | 5 | 10 | refactor: rename getEventLocationType to getLocationByType for better clarity |

This spans the full observed selected-set-size range (1-5) and mixes small (1-3 file) and larger (10-11 file) changesets. "Different packages" was not used as a selection criterion (the manifest data available doesn't carry per-merge file paths at this stage) - it will be checked as a property of the selected set once each merge's `deriving-selection` step runs, not used to filter the selection itself.

## 4. What remains sequenced, not yet started

Given the scope of items 5-8 in the requested plan (mutation recall across the additional merges, DeepSeek Harness validation, native-affected comparison on Nx, and a full-pipeline inventory spanning lint/typecheck/build/E2E/deployment-preview), these are substantial, multi-run efforts in their own right and are **not** started in this report. Proceeding in the stated order: median/variance sampling on PR #29940 (in progress, see the next report), then the 5 predeclared merges above, before moving to DeepSeek Harness or Nx.
