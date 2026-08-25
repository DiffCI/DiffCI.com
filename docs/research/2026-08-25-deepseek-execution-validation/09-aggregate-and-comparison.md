> **Amendment (2026-08-25, Report 11):** this report's "clean" characterization of the 5 executions and its unqualified `HONORED_WITH_FRAMEWORK_EXPANSION`/`IGNORED_OR_BROADENED` labels for #2814/#2844 are superseded by Report 11's bounded (unit-scope vs. all-family-scope) reclassification and its "operationally completed" framing. The aggregate denominators below (4/4 positive economics, 3/3 recall) are unaffected.

# Report 09 — aggregate result, infrastructure reliability, and Cal.com comparison (Phase 10)

## Aggregate, with explicit denominators

```
5 / 5 predeclared merges terminal (done)
4 / 5 runtime selection honored (HONORED_EXACTLY x3, HONORED_WITH_FRAMEWORK_EXPANSION x1)
1 / 5 IGNORED_OR_BROADENED (#2844 - family-scope harness limitation, not a DiffCI selection failure)
4 / 4 honored merges show positive test-stage economics (83.5%-94.3% net)
4 / 4 honored merges show positive complete-job economics (79.5%-89.5% net)
3 unique mutation cases measurable / 3 confirmed recalled (100%), 0 misses
2 unmeasurable cases (0 valid target x1, family-scope-unobservable x1) - correctly excluded from recall scoring
0 infrastructure failures in the final, fixed harness
2 stalled runs (argprobe1, argprobe2) during Phase 4, both caused by one container-name-length bug,
  found, fixed, and confirmed resolved before any real execution/canary/batch run
```

## Infrastructure reliability

| Run | Purpose | Outcome |
|---|---|---|
| `deepseek-argprobe1` | Argument-forwarding probe | **Stalled** (container-id length bug), cancelled |
| `deepseek-argprobe2` | Retry | **Stalled** (same bug, reproduced), cancelled |
| `calcom-alarmtest1` | Control probe (isolate the stall) | Clean - advanced normally, proving the stall was deepseek-specific |
| `deepseek-argprobe3` | Retry post-fix | Clean, 9/9 diagnostic commands completed |
| `deepseek-argprobe4` | Multi-file count follow-up | Clean |
| `deepseek-2808-canary1` | Canary | **Clean run, off-target mutation** (manifest-pathspec bug), preserved as evidence (Report 05) |
| `deepseek-2808-canary2` | Corrected canary | Clean |
| `deepseek-1373-batch1` | Batch | Clean |
| `deepseek-2814-batch1` | Batch | Clean (received the recall-computation fix mid-flight) |
| `deepseek-2844-batch1` | Batch | Clean execution, `IGNORED_OR_BROADENED` (real family-scope finding, not an error) |
| `deepseek-2760-batch1` | Batch | Clean |

**4 real harness defects found and fixed this mission**, all deployed with regression tests before being trusted for a real result:
1. `sandboxContainerId()` bounded only `runId`, not `repoSlug` - a longer repository name pushed the container name over a 63-char limit, stalling execution forever with no visible error (found via a controlled A/B experiment against a Cal.com control probe).
2. `mutate()`'s pathspec excluded only `.test.ts`/`.spec.ts` - a docs/i18n file could outrank the real source change alphabetically.
3. `mutate()`'s pathspec didn't exclude nested `package.json` - off-targeted the first canary attempt onto workspace dependency metadata (16 unrelated test failures as a direct, visible consequence).
4. Recall computation used a raw `failed > 0` check instead of diffing against the baseline - a false positive on any repository with pre-existing/flaky baseline failures (deepseek-harness has 16-18 on every run; Cal.com's baseline was failure-free, which is why this was never caught there).

**Zero silent failures.** Every defect was caught by this mission's own verification discipline (control experiments, exact failure-set diffing, cross-checking predeclared policy against actual harness behavior) before it could produce a misleading result that shipped unchallenged - except `canary1`'s mutation target and `2844`'s raw recall field, both of which are explicitly corrected and preserved as evidence rather than quietly overwritten.

## Cal.com vs. DeepSeek Harness comparison

| | Cal.com | DeepSeek Harness |
|---|---|---|
| Repository structure | Single Vitest config, no `projects` array | 3 separate Vitest configs (unit/snapshot/e2e); root config uses a real `projects` array |
| Package manager | Yarn | pnpm (corepack-pinned) |
| Modeled-universe completeness | `PARTIAL` in spirit (E2E not run in CI at all for cal.com) | `PARTIAL`, explicitly labeled (unit modeled/executed; snapshot executable-but-unselected; E2E excluded, credential-gated) |
| Selected percentage range (measured merges) | 0.1%-91.6% (5 merges, one repeat) | 0.1%-24.8% (5 distinct merges) |
| Runtime-enforcement success | 8/8 `HONORED_EXACTLY` | 4/5 honored (3 `HONORED_EXACTLY`, 1 `HONORED_WITH_FRAMEWORK_EXPANSION`), 1/5 `IGNORED_OR_BROADENED` (family-scope, not a selection failure) |
| Test-stage savings | 86.0%-93.8% net | 83.5%-94.3% net |
| Complete-job savings | 44.2%-45.7% net (install ≈ test in duration, ~320s each) | 79.5%-89.5% net (install is comparatively cheap, 23s-39s vs. 480-723s test) |
| Analysis overhead | ~10-11s | ~12-21s |
| Mutation measurability | 5/8 executions measurable, all 5 confirmed (3 unique cases, not double-counted) | 3/5 measurable, all 3 confirmed (2 correctly unmeasurable, not misses) |
| Unique mutation recall | 3/3 (100%) | 3/3 (100%) |
| Runner-adapter complexity | Low - single command shape (`yarn test <files>`), one bug found (`--` swallowing) | Higher - pnpm's own `--` semantics inverted from yarn's, 3 named Vitest projects, 3 separate config files, workspace-scoped `package.json` files complicating mutation targeting |
| Fallback behavior | Config/workflow/lockfile changes trigger fallback correctly | Same triggers observed; additionally confirmed a *nested* workspace manifest does NOT trigger fallback (only root-level does) - a real, useful distinction this mission surfaced |

## What generalizes, and what is repository-specific

**Generalizes**: the execution-selection invariant framework itself (`HONORED_EXACTLY`/`HONORED_WITH_FRAMEWORK_EXPANSION`/`IGNORED_OR_BROADENED`/`UNMEASURABLE`) correctly caught a real, novel failure mode (#2844's family-scope mismatch) that never arose on Cal.com - the framework did its job on genuinely new territory, not just repeating a known-good pattern. The economics and mutation-recall methodology (whole-file revert, exact failedTests diffing, baseline-relative recall) both held up and, critically, the baseline-relative recall fix makes the methodology *more* correct on any future repository with real pre-existing flakiness, not just this one.

**Repository-specific, do not port blindly**: `testArgv: ["test"]` (no `--`) is correct for THIS repo's pnpm/vitest combination, empirically measured, not inherited from Cal.com's yarn conclusion (which was also "no `--`", by coincidence of direction, not by shared cause). A third repository could easily need `--` restored, or something else entirely - Phase 4's probe discipline exists precisely because this cannot be assumed.
