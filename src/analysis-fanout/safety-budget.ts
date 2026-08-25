/**
 * Repository-level safety budget (2026-08-25, "production-safe selective execution loop" follow-up to
 * Report 17) - accumulates real, audited evidence over many merges into a running track record: how many
 * selective decisions has this repository/identity had, how many were actually AUDITED (a full-suite
 * comparison existed - see audit-sampling.ts), how many of those audited decisions had an outcome-changing
 * miss (the selected suite's own result would have missed something the full suite caught), and what
 * wall-time was actually measured on each side.
 *
 * Explicitly NOT a statistical SLA generator - `summarizeSafetyBudget` is deliberately conservative about
 * ever presenting a percentage-style miss-rate claim from a small sample (mirrors classifyStability's own
 * insufficient_samples discipline in rolling-fingerprint.ts). "0 misses in 3 audited decisions" and "0
 * misses in 300 audited decisions" are NOT the same claim, and this module never lets them be worded the
 * same way - below the minimum sample size, the miss-rate figure is withheld entirely, not computed and
 * labeled uncertain.
 *
 * Workload-reduction is a MEASUREMENT (real wall time actually spent), not a statistical claim about
 * future misses, so it is reported regardless of confidence tier - but only ever computed from AUDITED
 * decisions, since only those have a real, measured full-suite wall time to compare against. Comparing
 * selected time against a full time that was never actually run would not be a measurement (this is the
 * same distinction Report 17's "keep the no-op selection... as a separate open question" finding turned on
 * - never let an unmeasured baseline quietly become part of a savings claim).
 *
 * Pure - no clock, no I/O; a caller supplies each new decision's outcome (the same read-merge-write shape
 * as rolling-fingerprint.ts's mergeObservation, intended to be routed through an atomic per-identity store
 * the same way RollingFingerprintStore fixed the rolling fingerprint's own persistence).
 */

export interface SafetyBudgetIdentity {
  repository: string;
  branch: string;
  environmentIdentity: string;
  testFamily: string;
  commandIdentity: string;
}

/** One real decision's outcome, as observed by the execution shard after finalize() - the raw material
 * `recordDecision` folds into the running budget. */
export interface DecisionOutcome {
  /** Whether a full-suite comparison actually happened this run (audit-sampling.ts sampled it, or this was
   * a validation-harness run where the full suite always runs) - only audited decisions can ever
   * demonstrate an outcome-changing miss one way or the other; a non-audited decision still contributes to
   * the selected-side workload totals but never to the miss-rate evidence. */
  audited: boolean;
  /** Only meaningful when audited is true: did the selected suite's own results fail to preserve
   * something the full suite observed (facts.rawFullSuiteOutcomePreserved === "NOT_PRESERVED")? */
  outcomeChangingMiss: boolean;
  /** Real wall-time figures for this decision - selectedWallMs is always known (selective execution's
   * whole point is that it always runs); fullWallMs is only known when audited is true. */
  selectedWallMs: number;
  fullWallMs: number | undefined;
  /** Which CI stage this decision's timings represent - "test" is the only stage this mission's harness
   * currently measures; the field exists now so a future stage (build, lint, e2e, ...) does not require a
   * breaking shape change later. */
  stage: string;
  observedAtMs: number;
}

export interface StageTotals {
  totalDecisions: number;
  auditedDecisions: number;
  cumulativeSelectedWallMs: number;
  /** Only ever incremented by audited decisions - never the (much larger, mostly unmeasured) hypothetical
   * full-suite cost of every decision. */
  cumulativeAuditedFullWallMs: number;
}

export interface SafetyBudget extends SafetyBudgetIdentity {
  totalDecisions: number;
  auditedDecisions: number;
  outcomeChangingMisses: number;
  cumulativeSelectedWallMs: number;
  cumulativeAuditedFullWallMs: number;
  /** Per-stage breakdown, keyed by DecisionOutcome.stage - same fields as the top-level aggregate, which
   * sums across every stage. */
  byStage: Readonly<Record<string, StageTotals>>;
  updatedAtMs: number;
}

function freshStageTotals(): StageTotals {
  return { totalDecisions: 0, auditedDecisions: 0, cumulativeSelectedWallMs: 0, cumulativeAuditedFullWallMs: 0 };
}

/** Folds ONE new decision outcome into an existing budget (or starts a fresh one). Pure - caller owns
 * persistence. */
export function recordDecision(existing: SafetyBudget | undefined, identity: SafetyBudgetIdentity, outcome: DecisionOutcome): SafetyBudget {
  const auditedFullMs = outcome.audited ? (outcome.fullWallMs ?? 0) : 0;
  const stageBase = existing?.byStage[outcome.stage] ?? freshStageTotals();
  const stageUpdated: StageTotals = {
    totalDecisions: stageBase.totalDecisions + 1,
    auditedDecisions: stageBase.auditedDecisions + (outcome.audited ? 1 : 0),
    cumulativeSelectedWallMs: stageBase.cumulativeSelectedWallMs + outcome.selectedWallMs,
    cumulativeAuditedFullWallMs: stageBase.cumulativeAuditedFullWallMs + auditedFullMs,
  };
  return {
    ...identity,
    totalDecisions: (existing?.totalDecisions ?? 0) + 1,
    auditedDecisions: (existing?.auditedDecisions ?? 0) + (outcome.audited ? 1 : 0),
    outcomeChangingMisses: (existing?.outcomeChangingMisses ?? 0) + (outcome.audited && outcome.outcomeChangingMiss ? 1 : 0),
    cumulativeSelectedWallMs: (existing?.cumulativeSelectedWallMs ?? 0) + outcome.selectedWallMs,
    cumulativeAuditedFullWallMs: (existing?.cumulativeAuditedFullWallMs ?? 0) + auditedFullMs,
    byStage: { ...existing?.byStage, [outcome.stage]: stageUpdated },
    updatedAtMs: outcome.observedAtMs,
  };
}

export type SafetyBudgetConfidence = "INSUFFICIENT_AUDITED_SAMPLE" | "TRACK_RECORD_ESTABLISHED";

export interface SafetyBudgetSummary {
  confidence: SafetyBudgetConfidence;
  auditedDecisions: number;
  outcomeChangingMisses: number;
  /** Only ever populated once confidence is TRACK_RECORD_ESTABLISHED - deliberately withheld below the
   * minimum sample size rather than computed-and-labeled-uncertain, so a caller cannot accidentally surface
   * a precise-looking percentage from a handful of samples. */
  observedMissRatePct: number | undefined;
  /** Real measured workload reduction across the AUDITED subset only (see this module's own top comment
   * for why). Undefined when no audited decision has a nonzero measured full-suite time yet. */
  observedWorkloadReductionPct: number | undefined;
  explanation: string;
}

/** Turns a raw SafetyBudget into the human-readable claim - conservative by construction: a percentage-
 * style miss-rate claim is only ever produced once `auditedDecisions >= minAuditedSampleSize`; below that,
 * `observedMissRatePct` stays undefined and `confidence` reports INSUFFICIENT_AUDITED_SAMPLE, no matter how
 * clean the small sample looks (mirrors classifyStability's own minSamples discipline in
 * rolling-fingerprint.ts). */
export function summarizeSafetyBudget(budget: SafetyBudget, minAuditedSampleSize: number): SafetyBudgetSummary {
  const observedWorkloadReductionPct =
    budget.cumulativeAuditedFullWallMs > 0
      ? ((budget.cumulativeAuditedFullWallMs - budget.cumulativeSelectedWallMs) / budget.cumulativeAuditedFullWallMs) * 100
      : undefined;

  if (budget.auditedDecisions < minAuditedSampleSize) {
    return {
      confidence: "INSUFFICIENT_AUDITED_SAMPLE",
      auditedDecisions: budget.auditedDecisions,
      outcomeChangingMisses: budget.outcomeChangingMisses,
      observedMissRatePct: undefined,
      observedWorkloadReductionPct,
      explanation: `only ${budget.auditedDecisions} audited decision(s), need at least ${minAuditedSampleSize} before a miss-rate claim is trustworthy`,
    };
  }
  return {
    confidence: "TRACK_RECORD_ESTABLISHED",
    auditedDecisions: budget.auditedDecisions,
    outcomeChangingMisses: budget.outcomeChangingMisses,
    observedMissRatePct: (budget.outcomeChangingMisses / budget.auditedDecisions) * 100,
    observedWorkloadReductionPct,
    explanation: `${budget.auditedDecisions} audited decisions, ${budget.outcomeChangingMisses} outcome-changing miss(es)`,
  };
}
