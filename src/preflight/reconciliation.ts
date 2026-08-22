/**
 * Reconciliation (Preflight P1 Part E) - attaches real CI ground truth to a prediction WITHOUT ever
 * altering the prediction itself (PredictionRecord is only ever read here, never mutated or
 * reassigned - see prediction-store.ts's own structural-immutability note). A ReconciliationRecord is
 * a wholly separate object/table (src/preflight/cloudflare/schema.sql's preflight_reconciliations).
 *
 * "Eligible for prevention" - the concrete, code-enforced definition this module uses throughout -
 * means: at least one of the prediction's OWN recommendedChecks (from src/preflight/planner.ts, drawn
 * from PREFLIGHT_CHECK_REGISTRY) is declared to detect the actual failure class that occurred. This is
 * deliberately narrower and more falsifiable than "the risk score was high" - a prediction only counts
 * as having correctly anticipated a failure if it recommended a SPECIFIC check that would genuinely
 * have caught THAT SPECIFIC class, tying reconciliation directly back to the check registry rather
 * than to an unfalsifiable vibe.
 */
import type { PredictionRecord } from "./prediction-store.js";
import type { FailureClass } from "./taxonomy.js";
import { PREFLIGHT_CHECK_REGISTRY, type PreflightCheckDefinition } from "./checks-registry.js";

export type ReconciliationOutcome = "TP" | "TN" | "FP" | "FN" | "NOT_EVALUABLE";

export interface ReconciliationRecord {
  id: string;
  predictionId: string;
  reconciledAt: string;
  workflowRunId: string;
  workflowConclusion: string;
  actualFailureClass?: FailureClass;
  actualErrorFingerprint?: string;
  failingJob?: string;
  failingTest?: string;
  timeToFailureMs?: number;
  totalWorkflowDurationMs: number;
  outcome: ReconciliationOutcome;
  outcomeReason: string;
}

export interface ReconciliationInput {
  prediction: PredictionRecord;
  workflowRunId: string;
  workflowConclusion: string;
  actualFailureClass?: FailureClass;
  actualErrorFingerprint?: string;
  failingJob?: string;
  failingTest?: string;
  timeToFailureMs?: number;
  totalWorkflowDurationMs: number;
}

// GitHub Actions conclusions that carry no real pass/fail signal about the CODE - a run that never
// truly executed to completion tells us nothing about whether Preflight would have helped.
const NOT_EVALUABLE_CONCLUSIONS: ReadonlySet<string> = new Set(["cancelled", "skipped", "timed_out", "action_required", "neutral", "stale"]);

// Matches preventability.ts's own NOT_REASONABLY_PREVENTABLE discipline for these two classes (see its
// NOT_PREVENTABLE_CLASSES set and FLAKY's inherently non-deterministic nature) - scoring Preflight
// against a failure class it was never reasonably positioned to predict would fabricate a
// non-evaluable case into a false miss.
const NOT_EVALUABLE_FAILURE_CLASSES: ReadonlySet<FailureClass> = new Set(["RUNNER_INFRASTRUCTURE", "FLAKY"]);

export function isEligibleForPrevention(actualFailureClass: FailureClass, recommendedCheckIds: readonly string[], registry: readonly PreflightCheckDefinition[] = PREFLIGHT_CHECK_REGISTRY): boolean {
  const byId = new Map(registry.map((c) => [c.id, c]));
  return recommendedCheckIds.some((id) => byId.get(id)?.failureClassesDetected.includes(actualFailureClass) ?? false);
}

export function classifyReconciliationOutcome(input: ReconciliationInput): { outcome: ReconciliationOutcome; reason: string } {
  const predictedPositive = input.prediction.predictedFailureClasses.length > 0;

  if (NOT_EVALUABLE_CONCLUSIONS.has(input.workflowConclusion)) {
    return { outcome: "NOT_EVALUABLE", reason: `workflow conclusion "${input.workflowConclusion}" carries no real pass/fail ground truth about the code` };
  }

  if (input.workflowConclusion === "success") {
    if (predictedPositive) {
      return { outcome: "FP", reason: `prediction flagged risk (predicted classes: ${input.prediction.predictedFailureClasses.join(", ") || "none"}) but real CI succeeded` };
    }
    return { outcome: "TN", reason: "prediction flagged no risk and real CI succeeded" };
  }

  // workflowConclusion is a genuine failure from here on.
  if (!input.actualFailureClass) {
    return { outcome: "NOT_EVALUABLE", reason: "CI failed but no actual failure class could be determined from the evidence - insufficient evidence to classify, never guessed" };
  }
  if (NOT_EVALUABLE_FAILURE_CLASSES.has(input.actualFailureClass)) {
    return { outcome: "NOT_EVALUABLE", reason: `actual failure class ${input.actualFailureClass} is not reasonably attributable to Preflight's own predictive power (matches preventability.ts's NOT_REASONABLY_PREVENTABLE discipline for this class)` };
  }

  if (isEligibleForPrevention(input.actualFailureClass, input.prediction.recommendedChecks)) {
    return { outcome: "TP", reason: `a check in this prediction's own recommendedChecks detects ${input.actualFailureClass} - the failure was eligible for prevention and the prediction correctly recommended a check that would have caught it` };
  }
  return { outcome: "FN", reason: `CI failed with ${input.actualFailureClass} but no check in this prediction's recommendedChecks detects that class - a genuine miss` };
}

function defaultId(): string {
  return crypto.randomUUID();
}

/**
 * Builds the full reconciliation record. Pure aside from id/timestamp generation (both injectable for
 * tests) - never touches or returns a modified copy of `input.prediction`.
 */
export function reconcile(input: ReconciliationInput, now: () => string = () => new Date().toISOString(), generateId: () => string = defaultId): ReconciliationRecord {
  const { outcome, reason } = classifyReconciliationOutcome(input);
  return {
    id: generateId(),
    predictionId: input.prediction.id,
    reconciledAt: now(),
    workflowRunId: input.workflowRunId,
    workflowConclusion: input.workflowConclusion,
    actualFailureClass: input.actualFailureClass,
    actualErrorFingerprint: input.actualErrorFingerprint,
    failingJob: input.failingJob,
    failingTest: input.failingTest,
    timeToFailureMs: input.timeToFailureMs,
    totalWorkflowDurationMs: input.totalWorkflowDurationMs,
    outcome,
    outcomeReason: reason,
  };
}
