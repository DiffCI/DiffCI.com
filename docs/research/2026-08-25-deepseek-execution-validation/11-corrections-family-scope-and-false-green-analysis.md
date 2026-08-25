> **Amendment (2026-08-25, Report 12):** this report's "no false green occurred" conclusion (§ Correction 3) overreached - it answered a narrower question (do failing tests share a path with a selected file) than the operational one (full exit 1, selected exit 0 IS a false green under ordinary CI semantics, regardless of path overlap, since dependency-impact selection is meant to catch indirect consumers path-matching can't rule out). Corrections 1 and 2 below stand unchanged. See Report 12 for the corrected classification and a real executed base-SHA control run.

# Report 11 — corrections: family-scope precision and dirty-baseline/false-green analysis

External review (2026-08-25) identified three real imprecisions in Reports 01/07/08/09's framing. All three are accepted after independent verification against the raw records - not taken on faith. This report supersedes the executive verdict and specific claims named below; the originals are left unmodified with a pointer to this report, per this mission's own preserve-don't-rewrite discipline (the same pattern used for `canary1` in Report 05).

## Correction 1: DiffCI's static engine models unit, snapshot, AND e2e - not "unit only"

Report 01 §1.1 stated "DiffCI's static engine models the unit-test family only." **This is wrong**, and contradicted by this mission's own data: Report 02's `selectedTestsByFamily` for `#2814` is `{"e2e":1,"unit":59}` and for `#2844` is `{"untagged":1,"e2e":71,"snapshot":9,"unit":173}` - DiffCI's static selection graph plainly spans all three families.

**Corrected statement**: DiffCI's static engine models and selects across unit, snapshot, and e2e families. This execution round's *harness* wired an execution command for the unit family only (Report 01 §1, `testArgv`) - snapshot is keyless and executable but was never wired to a selective-execution command this round; e2e is credential-gated and out of scope entirely. The gap is in this mission's execution coverage, not in what DiffCI selects.

## Correction 2: `#2814` and `#2844` need a bounded (unit-scope vs. all-family-scope) reclassification

`HONORED_WITH_FRAMEWORK_EXPANSION` and `IGNORED_OR_BROADENED` are the existing engine classifier's real output values (same classifier used throughout the Cal.com mission), computed over the *entire* multi-family requested set against what one single-family command executed. Reported without qualification, both names read as claims about DiffCI's selection accuracy; neither merge's shortfall is actually about accuracy - both are about this round's single-family execution scope.

**Bounded reclassification, computed directly from each record's own `requestedTestFiles` split by family:**

| PR | Unit requested | Unit executed | Unit-scope result | All-family requested | All-family executed | All-family-scope result |
|---:|---:|---:|---|---:|---:|---|
| #2760 | 1 | 1 | exact | 1 | 1 | complete |
| #2808 | 4 | 4 | exact | 4 | 4 | complete |
| #1373 | 6 | 6 | exact | 6 | 6 | complete |
| #2814 | 59 | 59 | exact | 60 | 59 | incomplete (1 e2e file not executed) |
| #2844 | 173 | 173 | exact | 254 | 173 | incomplete (9 snapshot + 71 e2e + 1 untagged not executed) |

```
Unit-family scope:      5 / 5 selections honored exactly.
All-modeled-family scope: 3 / 5 complete; 2 / 5 incomplete by execution-family coverage
                           (not a selection-accuracy failure in either case).
```

This does not change #2814/#2844's economics disposition (Report 07 correctly withheld both from any all-family savings claim; #2814's economics figure there is scoped to what actually ran, which happens to equal its unit-only selection almost exactly - re-labeled below as unit-scope economics, not all-family economics).

**Engine-level note, not implemented this round**: a proper `PARTIAL_FAMILY_SCOPE` classifier value (distinguishing "requested files outside the executed family's scope" from "the executed family's own runtime ignored/broadened its filter") would be a real, worthwhile improvement to `classifyRuntimeSelection()` - flagged as a prerequisite for the snapshot-family extension (Report 10's recommended next step), not done here since it needs family-tagging plumbed into the classifier itself.

## Correction 3: dirty-baseline / false-green analysis

**The core safety question**: did any merge's selected suite report "0 failures" while its own full suite had a failure that the selected suite should have caught?

| PR | Full baseline exit | Selected baseline exit | Full failures | Selected failures | False-green mismatch (verified) |
|---:|---:|---:|---:|---:|---|
| #2760 | 1 | 0 | 18 | 0 | **none** - exact string-match check against the merge's own selected file (`packages/subagent/subagent/tests/continuation.spec.ts`) confirms none of the 18 pre-existing failures are in that file |
| #2808 | 1 | 0 | 16 | 0 | **none** |
| #1373 | 1 | 0 | 17 | 0 | **none** |
| #2814 | 1 | 0 | 17 | 0 | **none** |
| #2844 | 1 | 0 | 17 | 0 | **none** |

**Verified by exact path-containment check, not assumed**: for every merge, none of that merge's own `baseline.full.failedTests` fall within any file in that merge's own selected set. `#2760` was checked by hand as the closest-looking case (its one selected file, `continuation.spec.ts`, also appears once across the mission's overall 21-failure union) - confirmed absent from #2760's own 18-item failure list; the flaky `continuation.spec.ts` occurrence happened on a different merge's baseline run entirely. **No false green occurred in this 5-merge sample.**

**This does not prove false-green can never occur on this repository** - it is a property of this sample (none of these 5 merges' selected files happened to coincide with an environmentally-flaky package), not a structural guarantee. A future merge whose selected files DO overlap with one of the 21 environment-flaky tests below would need the same check re-run, not assumed clean by analogy.

### Two separate claims, now separated

- **Differential mutation recall (new failures caused by a deliberate mutation): 3/3 confirmed.** This is what Reports 07/08 actually measured and is fully supported.
- **Absolute full-suite failure preservation (does the selected suite's pass/fail status match the full suite's pass/fail status): not established as a general property**, only checked and confirmed clean for this specific 5-merge sample above. These are different claims and were previously conflated under "recall fully preserved" language - corrected here.

### The 16-18 pre-existing failures: environment-dirty, with supporting evidence, not confirmed against real CI

Cross-merge analysis: **16 of 21 distinct failing tests occur in `5/5` merges identically**, regardless of which code changed - `subagent-acp` (permission-denial), `bash-sandbox` ("reports a real permission failure as a sandbox denial"), `storage-sqlite` ("propagates filesystem errors"), `subagent/out-of-process` (permission-denial), `subprocess-local` process-exit/cleanup tests, and three `subagent-claude-code` tests requiring "a real Claude Agent SDK 0.3.220" fixture. The remaining 5 are single-occurrence (ordinary flaky variance on top of the fixed set).

**This pattern is best explained as sandbox-environment artifacts, not deepseek-harness application bugs or DiffCI harness bugs**: the majority of the fixed-set failures are permission-denial tests (expecting a real POSIX permission failure) and one is an external-SDK-fixture test - both categories are classic failure modes for a test run inside a container that runs as root (root bypasses standard POSIX permission checks, so a test asserting "this fails because the directory lacks search permission" fails differently under root) or lacks a real installed/networked fixture dependency. **This is a hypothesis supported by the pattern, not confirmed against deepseek-harness's actual GitHub Actions logs** - this mission has no access to compare against real CI's baseline pass/fail state. Labeled `environment-dirty`, not silently discarded: the 5 raw `ExecutionRecord`s each carry the complete `failedTests` lists as primary evidence, and this report's cross-merge table is the analysis, not a conclusion asserted without it.

### Economics and "operationally completed," not "clean"

Per the reviewer's note: the 5 executions are more precisely described as **operationally completed** (ran to termination, structured reporting complete, no infrastructure failure) rather than "clean," since their full unit baselines did not pass outright. Test-stage/job-level economics (Report 07) are unaffected by this correction - they are wall-clock measurements, not correctness claims, and remain accurate as reported.

### Recall denominators, restated precisely

```
Mutation unavailable by predeclaration:        1  (#2760)
Mutation attempted, no new full-unit failure:  1  (#2844 - unit-family-scope-unobservable, Report 08)
Mutation measurable:                            3
Differential mutation recall confirmed:       3/3
Confirmed mutation misses:                      0
```

("2 unmeasurable" in Report 08/09 without this breakdown is imprecise for exactly the reason raised - the two unmeasurable cases have different causes and should not be read as equivalent.)

## Corrected headline

> Across five deterministically selected DeepSeek Harness merges, DiffCI enforced its unit-test selections exactly (5/5) and reduced measured unit-test wall time by 83.5%-94.3% on the four economically scored cases. Three deterministic mutations produced new unit-test failures; DiffCI's selected unit suites detected the identical new failures in all three cases (differential mutation recall 3/3, 0 misses). Snapshot and E2E execution remain incomplete (2/5 merges had a multi-family selection this round's harness could not fully execute), and the pre-existing 16-18 per-run baseline failures - very likely sandbox-environment artifacts, not confirmed against real CI - required a separate false-green check, which found no mismatch in this sample but is not a structural guarantee for future merges.

**Overall**: cross-repository economic generalization - demonstrated. Differential mutation recall - demonstrated, 3/3. Full-family execution and a structural (not just sampled) absolute-failure-preservation guarantee - not yet demonstrated. Production-activation readiness is not claimed; no policy-adjusted/multi-sample economics were computed this round (open item, alongside DeepSeek's own multi-sample `decideActivation()` run, matching Cal.com's PR #29940 treatment).

## Next steps, in order

1. Snapshot-family extension (Report 10) should carry the `PARTIAL_FAMILY_SCOPE` classifier improvement, not defer it again.
2. Re-run the false-green check on every new merge added to the corpus - it is per-merge evidence, not a repository-wide property established once.
3. E2E stays excluded until a real credential decision is made.
