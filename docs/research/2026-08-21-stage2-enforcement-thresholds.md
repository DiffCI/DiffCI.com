# Stage 2 Phase 17 — evidence thresholds for `READY_FOR_ENFORCEMENT_REVIEW`

Written before any real Gate A ground-truth data exists (as of this writing: 2 repositories enrolled,
baselines established, **zero** ground-truth reconciliations recorded yet) - per the task's explicit
instruction to define thresholds before seeing results, not tune them to whatever the data turns out to
show. If these numbers look uncomfortably strict once real data arrives, that discomfort is the point:
the alternative is picking a threshold that happens to validate whatever performance DiffCI already has.

**A repository meeting every threshold below becomes `READY_FOR_ENFORCEMENT_REVIEW`, never
automatically enforced.** That state means only "a human should now look at this repository's evidence
and decide," per Phase 14. No code path in this repository is permitted to skip that human step - Stage 2
does not implement Level 1+ enforcement at all (Phase 18 is designed, not activated).

## 1. Minimum observation volume

| Metric | Threshold | Rationale |
|---|---|---|
| Live CI runs observed (ground-truth reconciled, any status) | ≥ 50 | Below this, any recall/opportunity percentage is noise - a single lucky or unlucky run swings the number by 2 points. |
| Discriminative-opportunity predictions | ≥ 15 | The opportunity classifier (Stage 0/1, reused unchanged here) already showed real signal concentrates in this bucket - MANDATORY_FALLBACK and BASELINE_ALREADY_OPTIMAL predictions don't exercise DiffCI's actual selection logic, so they don't count toward this floor even though they count toward the run-volume floor above. |
| Evaluable relevant (test-category) failures | ≥ 5 | Below this, "100% prospective recall" is indistinguishable from "we got lucky and nothing failed" - see the safety threshold below, which is explicitly gated on this floor. |
| Observation period | ≥ 14 calendar days | A repository observed for 3 days during an unusually quiet week looks nothing like the same repository over a normal month. Two full weeks is the minimum window that's likely to include at least one real incident-shaped event (a revert, a hotfix, a flaky-test episode) rather than just steady-state green commits. |

## 2. Safety

| Metric | Threshold | Rationale |
|---|---|---|
| DiffCI prospective recall (`failuresPreservedByDiffci / relevantFailuresEvaluable`) | **100%**, with the evaluable-failures floor above satisfied | Not 95%, not "better than PATH" - Stage 2's whole premise is that a missed real regression is categorically worse than a wasted CI minute. A single confirmed prospective unsafe miss (a real, non-flaky, test-category failure DiffCI would have skipped) is disqualifying on its own, regardless of every other number, until root-caused and fixed - mirroring exactly how Stage 1A/1B treated historical misses. |
| Credible unsafe misses under investigation | 0 (none open) | An unsafe miss that's been root-caused, fixed, and re-verified doesn't block review by itself; one that's still open and not understood does, even if it's the only one in the whole dataset. |
| PATH comparison | Reported, not gating | DiffCI beating PATH on recall is expected and worth reporting, but a repository doesn't get blocked from review for having a worse PATH baseline, and doesn't get waved through for having a better one - PATH's own recall is diagnostic context, not a pass/fail bar. |

## 3. Savings (commercial meaningfulness)

| Metric | Threshold | Rationale |
|---|---|---|
| Net CI compute time saved vs PATH, after DiffCI's own analysis overhead | > 10% of PATH's compute, AND positive in absolute minutes | Stage 1B's own runtime pilot found overhead can exceed savings entirely on a small repo - a repository where the net number is negative or a rounding error has no business case for enforcement, however good its safety numbers are. 10% is a floor for "worth the operational complexity," not a target. |
| Absolute minutes saved per week (not just percent) | > 5 minutes/week aggregate | A 40% relative reduction on a repository whose CI takes 90 seconds total saves nobody anything worth the risk. Percentages alone are exactly the kind of framing the task's own "Research integrity" section warns against ("do not convert test-count reduction directly into runtime savings" applies here too - a good percentage on a trivial base is not evidence of value). |
| Developer-facing wall-clock (critical-path) savings | Reported separately, not gating | Per Phase 9, compute-time and wall-clock savings are genuinely different value propositions (parallel CI can make them diverge a lot) - a repository can qualify for review on compute savings alone, but the wall-clock number must always be shown alongside it, never folded into one blended figure. |

## 4. Reliability

| Metric | Threshold | Rationale |
|---|---|---|
| Prediction success rate (predictions attempted vs. completed without error) | ≥ 95% | A pipeline that silently fails to predict on 1 in 10 real commits isn't trustworthy enough to reason about, independent of how good its predictions are when they do complete. |
| Ground-truth reconciliation rate (predictions eventually reconciled, not stuck STILL_PENDING forever) | ≥ 90% within 7 days of prediction | A prediction that never gets a ground-truth match is unfalsifiable - it can't contribute to either the safety or savings numbers, and a high rate of these means the observation pipeline itself is broken (wrong workflow-path filtering, a repo that runs CI on a schedule DiffCI doesn't anticipate, etc.), not that the repository is unusually quiet. |
| Prospectiveness proof (`predictionPrecededGroundTruth`) | 100% of reconciled events | This is not a percentage to optimize - a single `false` here means a prediction was recorded, or is being treated as if it were recorded, after its own outcome was already knowable. That is a correctness bug in the pipeline (see the Mandatory STOP conditions in the task spec: "prediction is influenced by the final CI outcome"), not a metric to trend toward 100%. |

## 5. Coverage (fallback rate)

| Metric | Threshold | Rationale |
|---|---|---|
| Fallback rate (MANDATORY_FALLBACK / total predictions) | Reported, capped at "not the entire dataset" (< 95%) | A repository that falls back on every single commit has given DiffCI no opportunity to demonstrate anything either way - that's a `SHADOW_LIMITED` or `UNSUPPORTED` signal (see the repository-state doc), not something to review for enforcement. There is no floor pushing fallback rate down artificially - a legitimately high fallback rate on a repository with genuinely global CI triggers (e.g. everything imports one shared config file) is a true, reportable finding, not something to threshold-tune away. |

## What this explicitly does NOT do

- It does not average across repositories to reach these floors - each enrolled repository is evaluated
  against every threshold independently. A strong repository cannot "cover for" a weak one in an
  aggregate.
- It does not treat `READY_FOR_ENFORCEMENT_REVIEW` as a finish line. It is the point where a human
  looks at the specific repository's full evidence (not just whether it crossed these lines) and decides
  whether Level 1 controlled enforcement (Phase 18, design only) is worth proposing for it specifically.
- It will not be revised based on where Gate A's first real repositories land, without an explicit,
  separately-justified reason recorded in this file (not silently edited).
