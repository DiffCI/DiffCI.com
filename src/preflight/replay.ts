/**
 * Temporal-leakage-safe chronological replay engine (Preflight P1 Part G), implementing the design
 * frozen in docs/research/2026-08-22-preflight-p0-historical-failure-study.md's "Part 10-14" section
 * (design-only in P0; this is that design, actually built). Five rules from that design, each enforced
 * here structurally, not just by convention:
 *
 *  1. Commits are processed in a single frozen chronological order (sorted by timestamp).
 *  2. For commit N, the predictor may read ONLY commit N's own diff and known-failure memory built
 *     EXCLUSIVELY from commits strictly before N - enforced by LeakageSafePredictor's own type
 *     signature, which structurally has no access to commit N's actual outcome/fingerprint at all
 *     (there is no field to leak through, not just a promise not to read one).
 *  3. A rule/fingerprint discovered at commit N is only added to memory AFTER commit N's own
 *     prediction+reconciliation step completes - so it is available starting at commit N+1, never
 *     backdated to affect N or anything earlier.
 *  4. Each step records whether the rule set active as of that commit's own timestamp would have
 *     recommended a check that exposed the real historical failure (Part E's isEligibleForPrevention,
 *     reused unchanged).
 *  5. This module never reports a single aggregate number silently - callers get the full per-commit
 *     trace (runLeakageSafeReplay's return) so a reader can audit every step, not just trust a summary.
 *
 * Part G's own explicit instruction: "report the new number even if substantially worse [than 18/24],
 * do not tune the algorithm repeatedly to reproduce 75%." This module has no target-seeking logic of
 * any kind - it deterministically replays whatever predictor it's given and reports what happens.
 */
import type { FailureClass } from "./taxonomy.js";
import type { RiskReason } from "./risk-model.js";
import { computePreflightVerdict, type PreflightVerdict } from "./verdict.js";
import { classifyReconciliationOutcome, type ReconciliationOutcome } from "./reconciliation.js";
import { upsertKnownFailure, type KnownFailureRecord } from "./known-failures.js";

export interface ReplayCommit {
  commitSha: string;
  /** ISO 8601 - the real historical ordering key (commit push time or CI run creation time). */
  timestamp: string;
  changedFiles: string[];
  // Real historical ground truth. Available to the ENGINE (this is history) but structurally withheld
  // from the predictor for the commit it describes - see LeakageSafePredictor below.
  actualOutcomeConclusion: string;
  actualFailureClass?: FailureClass;
  actualErrorFingerprint?: string;
  totalWorkflowDurationMs: number;
  timeToFailureMs?: number;
}

export interface LeakageSafePredictorInput {
  changedFiles: string[];
  /** Known-failure memory built exclusively from commits strictly before the one being predicted -
   * never includes the current commit's own (not-yet-revealed) outcome. */
  knownFailuresAsOf: readonly KnownFailureRecord[];
}

export interface LeakageSafePredictorOutput {
  riskScore: number;
  riskReasons: RiskReason[];
  recommendedChecks: string[];
  predictedFailureClasses: FailureClass[];
}

/** A predictor implementation's type signature structurally cannot reference the commit's own ground
 * truth - LeakageSafePredictorInput has no actualFailureClass/actualErrorFingerprint/
 * actualOutcomeConclusion field to read, so a leaky implementation would need to go out of its way
 * (e.g. closing over external state) to violate this, rather than being handed the answer directly. */
export type LeakageSafePredictor = (input: LeakageSafePredictorInput) => LeakageSafePredictorOutput;

export interface ReplayStepResult {
  commitSha: string;
  timestamp: string;
  prediction: LeakageSafePredictorOutput & { verdict: PreflightVerdict };
  reconciliationOutcome: ReconciliationOutcome;
  reconciliationReason: string;
  /** How many known-failure records were available to the predictor for this step - 0 for the first
   * commit in the replay, by construction. Surfaced so a reader can sanity-check that memory really
   * did grow monotonically rather than trust it silently. */
  knownFailuresAvailableCount: number;
}

export interface ReplaySummary {
  steps: readonly ReplayStepResult[];
  totalCommits: number;
  outcomeCounts: Record<ReconciliationOutcome, number>;
  /** TP / (TP + FN) among commits with a real, evaluable ground-truth failure - "prevention recall" per
   * the P0 design's Part 12. "unknown" (never 0) when there are zero TP+FN commits to divide by. */
  preventionRecall: number | "unknown";
}

function isChronological(commits: readonly ReplayCommit[]): boolean {
  for (let i = 1; i < commits.length; i++) {
    if (commits[i]!.timestamp < commits[i - 1]!.timestamp) return false;
  }
  return true;
}

/**
 * Runs the replay. Commits are sorted defensively (ties broken by original array order via a stable
 * sort) - callers should still pass already-chronological input; `wasAlreadyChronological` in the
 * returned metadata records whether that held, so a caller can treat unsorted input as its own finding
 * rather than a silent engine fix-up.
 */
export function runLeakageSafeReplay(commits: readonly ReplayCommit[], predict: LeakageSafePredictor): ReplaySummary & { wasAlreadyChronological: boolean } {
  const wasAlreadyChronological = isChronological(commits);
  const sorted = [...commits].sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0));

  let knownFailures: KnownFailureRecord[] = [];
  const steps: ReplayStepResult[] = [];

  for (const commit of sorted) {
    // --- Prediction: sees ONLY commit.changedFiles and knownFailures built from strictly-earlier commits.
    const knownFailuresAsOf = knownFailures; // snapshot reference is fine - only ever replaced wholesale below, never mutated in place
    const predicted = predict({ changedFiles: commit.changedFiles, knownFailuresAsOf });
    const verdict = computePreflightVerdict(predicted.riskScore);

    // --- Reconciliation: NOW it's safe to look at the real historical outcome for this commit.
    const { outcome, reason } = classifyReconciliationOutcome({
      prediction: { id: commit.commitSha, predictedFailureClasses: predicted.predictedFailureClasses, recommendedChecks: predicted.recommendedChecks },
      workflowRunId: commit.commitSha,
      workflowConclusion: commit.actualOutcomeConclusion,
      actualFailureClass: commit.actualFailureClass,
      actualErrorFingerprint: commit.actualErrorFingerprint,
      totalWorkflowDurationMs: commit.totalWorkflowDurationMs,
      timeToFailureMs: commit.timeToFailureMs,
    });

    steps.push({
      commitSha: commit.commitSha,
      timestamp: commit.timestamp,
      prediction: { ...predicted, verdict },
      reconciliationOutcome: outcome,
      reconciliationReason: reason,
      knownFailuresAvailableCount: knownFailuresAsOf.length,
    });

    // --- Memory update: happens LAST, strictly after this commit's own prediction+reconciliation, so
    // it can only ever affect commit N+1 onward - never backdated to N or earlier (design rule #3).
    if (commit.actualFailureClass && commit.actualErrorFingerprint) {
      const existing = knownFailures.find((k) => k.errorFingerprint === commit.actualErrorFingerprint);
      const exposingCheckId = predicted.recommendedChecks.find((id) => outcome === "TP") ? predicted.recommendedChecks[0] : undefined;
      const updated = upsertKnownFailure(existing, {
        errorFingerprint: commit.actualErrorFingerprint,
        failureClass: commit.actualFailureClass,
        changedFiles: commit.changedFiles,
        occurredAt: commit.timestamp,
        exposingCheckId,
      });
      knownFailures = existing ? knownFailures.map((k) => (k.errorFingerprint === updated.errorFingerprint ? updated : k)) : [...knownFailures, updated];
    }
  }

  const outcomeCounts: Record<ReconciliationOutcome, number> = { TP: 0, TN: 0, FP: 0, FN: 0, NOT_EVALUABLE: 0 };
  for (const step of steps) outcomeCounts[step.reconciliationOutcome]++;
  const evaluableFailures = outcomeCounts.TP + outcomeCounts.FN;
  const preventionRecall = evaluableFailures > 0 ? outcomeCounts.TP / evaluableFailures : "unknown";

  return { steps, totalCommits: sorted.length, outcomeCounts, preventionRecall, wasAlreadyChronological };
}
