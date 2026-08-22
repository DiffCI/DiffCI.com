/**
 * Dashboard/report metrics aggregation (Preflight P1 Part N). Combines reconciliation outcomes
 * (Part E) and per-prediction metrics (Part F) into one summary object with EXPLICIT denominators
 * throughout (Part N's own requirement) - every rate is reported alongside the count it was computed
 * from, never a bare percentage that hides how much (or little) evidence backs it.
 */
import type { ReconciliationOutcome } from "./reconciliation.js";
import type { ValueWithConfidence } from "./metrics.js";

export interface DashboardReconciliationEntry {
  outcome: ReconciliationOutcome;
  avoidedDownstreamWorkMs: ValueWithConfidence<number>;
  preflightOverheadMs: ValueWithConfidence<number>;
  timeToSignalImprovementMs: ValueWithConfidence<number>;
}

export interface PreflightDashboard {
  totalPredictions: number;
  reconciledCount: number;
  unreconciledCount: number;
  outcomeCounts: Record<ReconciliationOutcome, number>;
  /** TP / (TP + FN) among evaluable (TP+FN>0) reconciliations - "unknown" (never 0) when that
   * denominator is zero. Always reported with its own denominator alongside it. */
  deterministicRecall: { value: number | "unknown"; tp: number; fn: number };
  /** TP / (TP + FP) among predictions that flagged risk (TP+FP>0) - "unknown" when that denominator is
   * zero. */
  precision: { value: number | "unknown"; tp: number; fp: number };
  /** Overhead measured only across TN/FP outcomes (successful commits) - Part F's own scope for
   * "successful-commit Preflight overhead." */
  medianSuccessfulCommitOverheadMs: ValueWithConfidence<number>;
  medianTimeToSignalImprovementMs: ValueWithConfidence<number>;
  totalEstimatedDownstreamWorkAvoidedMs: ValueWithConfidence<number>;
}

function median(values: number[]): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/** Confidence of an aggregate can never exceed the weakest confidence among its real numeric
 * contributors - same rule src/usage/savings.ts's aggregateSavings() uses, reapplied here
 * independently (Preflight P1 stays structurally separate from that module, see metrics.ts's header). */
function aggregateValue(entries: ValueWithConfidence<number>[], reduce: (nums: number[]) => number | undefined): ValueWithConfidence<number> {
  const numeric = entries.filter((e): e is { value: number; confidence: "measured" | "estimated" | "unknown" } => typeof e.value === "number");
  const result = reduce(numeric.map((e) => e.value));
  if (result === undefined) return { value: "unknown", confidence: "unknown" };
  const rank = { measured: 2, estimated: 1, unknown: 0 } as const;
  const weakest = numeric.reduce((w, e) => (rank[e.confidence] < rank[w] ? e.confidence : w), numeric[0]!.confidence);
  return { value: result, confidence: weakest };
}

export function buildPreflightDashboard(totalPredictions: number, reconciliations: readonly DashboardReconciliationEntry[]): PreflightDashboard {
  const outcomeCounts: Record<ReconciliationOutcome, number> = { TP: 0, TN: 0, FP: 0, FN: 0, NOT_EVALUABLE: 0 };
  for (const r of reconciliations) outcomeCounts[r.outcome]++;

  const tp = outcomeCounts.TP;
  const fn = outcomeCounts.FN;
  const fp = outcomeCounts.FP;
  const deterministicRecall = { value: tp + fn > 0 ? tp / (tp + fn) : ("unknown" as const), tp, fn };
  const precision = { value: tp + fp > 0 ? tp / (tp + fp) : ("unknown" as const), tp, fp };

  const overheadEntries = reconciliations.filter((r) => r.outcome === "TN" || r.outcome === "FP").map((r) => r.preflightOverheadMs);
  const medianSuccessfulCommitOverheadMs = aggregateValue(overheadEntries, median);

  const ttsEntries = reconciliations.map((r) => r.timeToSignalImprovementMs);
  const medianTimeToSignalImprovementMs = aggregateValue(ttsEntries, median);

  const avoidedEntries = reconciliations.map((r) => r.avoidedDownstreamWorkMs);
  const totalEstimatedDownstreamWorkAvoidedMs = aggregateValue(avoidedEntries, (nums) => (nums.length > 0 ? nums.reduce((s, n) => s + n, 0) : undefined));

  return {
    totalPredictions,
    reconciledCount: reconciliations.length,
    unreconciledCount: Math.max(0, totalPredictions - reconciliations.length),
    outcomeCounts,
    deterministicRecall,
    precision,
    medianSuccessfulCommitOverheadMs,
    medianTimeToSignalImprovementMs,
    totalEstimatedDownstreamWorkAvoidedMs,
  };
}
