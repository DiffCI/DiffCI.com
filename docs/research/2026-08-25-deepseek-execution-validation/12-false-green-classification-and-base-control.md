# Report 12 — false-green classification corrected, and a real base-SHA control run

## Correction accepted: Report 11's "no false green occurred" overreached

A second round of external review correctly identified that Report 11's path-overlap check answered a narrower question than the one that matters operationally. The plain fact, already in Report 11's own table, is:

```
Full suite:     exit 1  (5/5 merges)
Selected suite: exit 0  (5/5 merges)
```

**That is a false green under ordinary CI semantics, independent of whether the failing files overlap the selected files.** Dependency-impact selection exists to catch *indirect* consumers of a change - a failing test needs no path relationship to the diff to be a real concern, so "the failing tests weren't in the selected file set" cannot by itself establish safety. Report 11's conclusion is corrected here, not silently amended in place.

## Corrected classification

| Metric | Result |
|---|---|
| Raw CI outcome preservation | **0/5** — full red, selected green, every merge |
| Observed false-green mismatch | **5/5** |
| Change-attributable false green | **Unconfirmed** (see base-SHA control below - moving toward "unlikely" for #2760 specifically, not yet for the other 4) |
| Differential mutation recall | **3/3 confirmed** (unaffected by this correction) |
| Environment attribution | Strong evidence, now including one direct before/after control (below) |

**Label: `ENVIRONMENT_DIRTY_ABSOLUTE_RECALL_UNMEASURABLE`**, not "checked clean."

## A real base-SHA control run (resolution step 1-2, PR #2760)

Per the proposed resolution path, executed - not merely reasoned about. `deepseek-2760-basecontrol2`: a full, real pipeline run (proper `startProcess`+poll path, 15-minute `maxTestRunMs`, not the diagnostic-probe mode's tighter 5-minute cap - the first attempt at this, `basecontrol1`, was cancelled for exactly that reason before it could time out misleadingly) with `mergeSha = baseSha = b70f27f764e014287faef04858e00822c4d138f2` (PR #2760's own base commit, checked out as if it were the head, with a dummy `selectedTestPaths` supplied only to skip re-deriving a trivial self-diff selection - the full-baseline step runs unconditionally regardless). Raw record: `raw-deepseek-2760-basecontrol2-final-record.json`.

**Result: `baseline.full.failed: 16`, `exitCode: 1`.** Compared exactly against PR #2760's own merge-SHA full baseline (18 failures):

```
base failures (16) ⊂ merge failures (18)   [verified: every base failure appears in the merge's own list]
merge-only additions (2):
  - subprocess-local/tests/spawn.spec.ts :: spawnSubprocess bounds inherited-pipe draining after the shell exits
  - acp-snapshot/tests/harness.spec.ts :: runScenario waitForInboxMessage times out when the session log or matching insertion is absent
```

Both merge-only additions were already flagged in Report 11 as single-occurrence (1/5 merges) entries in the cross-merge union - ordinary flaky variance, not part of the stable recurring set, and structurally the same *kind* of test (subprocess/process-timing) as the 16 stable failures, not a new category.

**Narrowed per a further review round**: this establishes exactly what was directly measured, no more. **16 of 18 merge-baseline failures are directly proven to predate the merge** (exact string match, present at the base SHA before PR #2760's own change). **The remaining 2 are suspected flakes, not confirmed** - a single-run, single-occurrence observation does not establish flakiness; it only remains *consistent with* it. Confirming would need repeated runs, a stable/unstable fingerprint check, or historical CI evidence, none of which has been done for these 2 specifically.

**Correct statement for #2760**: at least 16/18 merge-baseline failures predated the merge; 2 additional failure observations remain consistent with flakiness but are not yet conclusively attributed. Not "no evidence of a change-induced failure" stated without qualification - the 2 unresolved observations keep that claim open, even though they are unlikely to be change-induced given they don't touch any file #2760's diff (a test-only, no-source-change PR) could plausibly affect.

## What this does and does not establish

**Does**: one direct, executed (not inferred) confirmation that the recurring failure set pre-dates a merge's own changes, for the one merge tested (#2760).

**Does not**: extend automatically to `#2808`, `#1373`, `#2814`, `#2844` - each needs its own base-SHA control run before the same claim can be made for it specifically, per the resolution path's own step 2 ("compare base full failures, merge full failures, merge selected failures" - per merge, not once for the corpus). The cross-merge pattern consistency in Report 11 (16/21 failures recurring identically across all 5 merge-SHA runs) is suggestive that the same result would hold for the other 4, but is not itself a substitute for running the control on each.

**Does not** resolve steps 3-4 of the resolution path (non-root reproduction, comparison against real GitHub Actions logs) - both remain genuinely blocked on access/environment changes outside this mission's current scope, not attempted here.

## Updated headline

Across five DeepSeek Harness merges, DiffCI enforced unit-family selections exactly (5/5) and produced substantial positive runtime savings (83.5%-94.3% net, four economically-scored cases). Three deterministic mutations introduced new unit-test failures, all of which the selected suites preserved (differential mutation recall 3/3, 0 misses). Every full baseline contained recurring, environment-associated failures while selected baselines passed - a real false-green mismatch under ordinary CI semantics, observed 5/5. A direct base-SHA control run for one merge (#2760) confirms its recurring failures pre-date that merge's own change; the same has not yet been run for the other four. **Absolute CI outcome preservation remains unmeasurable in the current sandbox environment for 4 of 5 merges, and is supported-but-not-independently-confirmed for the 5th.**

## Not proceeding to snapshot expansion

Per explicit direction: snapshot-family work is deferred until either (a) an environment where the full suite is clean, (b) a formal known-failure/quarantine baseline, or (c) base-SHA differential controls run for the remaining 4 merges - whichever the user directs next.
