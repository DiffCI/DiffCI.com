/**
 * Repository-level safety budget (2026-08-25, "production-safe selective execution loop" follow-up to
 * Report 17) - accumulates real evidence over many merges into a running track record: how many selective
 * decisions has this repository/identity had, how many were actually AUDITED (counted toward the
 * statistically-designed sample - see audit-sampling.ts), how many of those audited decisions had an
 * outcome-changing miss, and what wall-time was actually measured on each side.
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
 * decisions, since only those have a real, measured full-suite wall time to compare against.
 *
 * Observation vs audit evidence (2026-08-25, follow-up direction after PR #2808's real
 * NOT_PRESERVED-but-not-sampled result): a raw outcome mismatch must never silently vanish from
 * operational analysis just because it fell outside the randomized audit sample. `observedOutcomeMismatch`
 * on a DecisionOutcome is recorded into `observedOutcomeMismatches`/`observationsWithComparisonData`
 * WHENEVER comparison data happens to exist, independent of `countsTowardSafetyBudget` (the audit-SAMPLING
 * policy decision). `outcomeChangingMisses`/`auditedDecisions` remain the separate, statistically-designed
 * counters `summarizeSafetyBudget`'s miss-rate claim is built from - the two are never conflated.
 *
 * Schema-versioned (2026-08-25) - this exact lesson was just learned live for the rolling fingerprint
 * (Report 17: a shape change without versioning silently corrupted comparisons against pre-change data).
 * The caller is expected to partition storage by SAFETY_BUDGET_SCHEMA_VERSION the same way
 * execution-shard-do.ts's rollingKey does for the rolling fingerprint - old data is left untouched as
 * historical evidence, never silently reinterpreted under new field semantics.
 *
 * Pure - no clock, no I/O; a caller supplies each new decision's outcome (the same read-merge-write shape
 * as rolling-fingerprint.ts's mergeObservation, routed through an atomic per-identity store the same way
 * RollingFingerprintStore fixed the rolling fingerprint's own persistence).
 */

/** Bumped whenever DecisionOutcome/SafetyBudget's own field semantics change in a way that would corrupt a
 * comparison against data recorded under a different version (e.g. this module's 2026-08-25
 * observedOutcomeMismatch/countsTowardSafetyBudget introduction, which renamed/split fields a prior
 * version's data does not have). */
export const SAFETY_BUDGET_SCHEMA_VERSION = 1;

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
  /** Whether a full-suite comparison actually happened this run AND showed a raw mismatch
   * (facts.rawFullSuiteOutcomePreserved === "NOT_PRESERVED") - undefined when no comparison data exists at
   * all this run (e.g. the full suite never completed). Recorded into observedOutcomeMismatches whenever
   * NOT undefined, regardless of countsTowardSafetyBudget - a real observed mismatch is never dropped just
   * because this decision fell outside the randomized audit sample. */
  observedOutcomeMismatch: boolean | undefined;
  /** Whether THIS decision counts toward the STATISTICALLY-DESIGNED safety-budget denominator/numerator -
   * the audit-SAMPLING policy decision (decideAuditSampling.sampled), not "did comparison data happen to
   * exist" (a validation harness like this mission's always has it; real sampled production usually won't). */
  countsTowardSafetyBudget: boolean;
  /** Real wall-time figures for this decision - selectedWallMs is always known (selective execution's
   * whole point is that it always runs); fullWallMs is only known when comparison data exists this run. */
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
  /** Only ever incremented by audited (countsTowardSafetyBudget) decisions - never the (much larger,
   * mostly unmeasured) hypothetical full-suite cost of every decision. */
  cumulativeAuditedFullWallMs: number;
}

export interface SafetyBudget extends SafetyBudgetIdentity {
  schemaVersion: number;
  totalDecisions: number;
  auditedDecisions: number;
  outcomeChangingMisses: number;
  /** How many decisions had ANY full-suite comparison data at all (observedOutcomeMismatch !== undefined),
   * audited or not - the denominator for observedOutcomeMismatches below, distinct from auditedDecisions
   * (the statistically-sampled subset). */
  observationsWithComparisonData: number;
  /** Raw count of observedOutcomeMismatch===true decisions, REGARDLESS of countsTowardSafetyBudget - kept
   * independently of outcomeChangingMisses so a real observed mismatch is never silently dropped from
   * operational analysis merely because it fell outside the randomized audit sample. */
  observedOutcomeMismatches: number;
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
 * persistence. Treats an `existing` budget stamped with a DIFFERENT schemaVersion as absent (defense-in-
 * depth mirroring mergeObservation's own - the primary safeguard is the caller partitioning storage by
 * schema version in the first place). */
export function recordDecision(existing: SafetyBudget | undefined, identity: SafetyBudgetIdentity, outcome: DecisionOutcome): SafetyBudget {
  const compatible = existing !== undefined && existing.schemaVersion === SAFETY_BUDGET_SCHEMA_VERSION;
  const base = compatible ? existing : undefined;

  const auditedFullMs = outcome.countsTowardSafetyBudget ? (outcome.fullWallMs ?? 0) : 0;
  const stageBase = base?.byStage[outcome.stage] ?? freshStageTotals();
  const stageUpdated: StageTotals = {
    totalDecisions: stageBase.totalDecisions + 1,
    auditedDecisions: stageBase.auditedDecisions + (outcome.countsTowardSafetyBudget ? 1 : 0),
    cumulativeSelectedWallMs: stageBase.cumulativeSelectedWallMs + outcome.selectedWallMs,
    cumulativeAuditedFullWallMs: stageBase.cumulativeAuditedFullWallMs + auditedFullMs,
  };
  const hasComparisonData = outcome.observedOutcomeMismatch !== undefined;
  return {
    ...identity,
    schemaVersion: SAFETY_BUDGET_SCHEMA_VERSION,
    totalDecisions: (base?.totalDecisions ?? 0) + 1,
    auditedDecisions: (base?.auditedDecisions ?? 0) + (outcome.countsTowardSafetyBudget ? 1 : 0),
    outcomeChangingMisses: (base?.outcomeChangingMisses ?? 0) + (outcome.countsTowardSafetyBudget && outcome.observedOutcomeMismatch === true ? 1 : 0),
    observationsWithComparisonData: (base?.observationsWithComparisonData ?? 0) + (hasComparisonData ? 1 : 0),
    observedOutcomeMismatches: (base?.observedOutcomeMismatches ?? 0) + (outcome.observedOutcomeMismatch === true ? 1 : 0),
    cumulativeSelectedWallMs: (base?.cumulativeSelectedWallMs ?? 0) + outcome.selectedWallMs,
    cumulativeAuditedFullWallMs: (base?.cumulativeAuditedFullWallMs ?? 0) + auditedFullMs,
    byStage: { ...base?.byStage, [outcome.stage]: stageUpdated },
    updatedAtMs: outcome.observedAtMs,
  };
}

export type SafetyBudgetConfidence = "INSUFFICIENT_AUDITED_SAMPLE" | "TRACK_RECORD_ESTABLISHED";

export interface SafetyBudgetSummary {
  confidence: SafetyBudgetConfidence;
  auditedDecisions: number;
  outcomeChangingMisses: number;
  /** Raw counts, always reported regardless of confidence tier (they're observations, not a statistically-
   * designed percentage claim) - see this module's own top comment for why these stay independent of the
   * audited-only counters above. */
  observationsWithComparisonData: number;
  observedOutcomeMismatches: number;
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

  const base = {
    auditedDecisions: budget.auditedDecisions,
    outcomeChangingMisses: budget.outcomeChangingMisses,
    observationsWithComparisonData: budget.observationsWithComparisonData,
    observedOutcomeMismatches: budget.observedOutcomeMismatches,
    observedWorkloadReductionPct,
  };

  if (budget.auditedDecisions < minAuditedSampleSize) {
    return {
      confidence: "INSUFFICIENT_AUDITED_SAMPLE",
      ...base,
      observedMissRatePct: undefined,
      explanation: `only ${budget.auditedDecisions} audited decision(s), need at least ${minAuditedSampleSize} before a miss-rate claim is trustworthy`,
    };
  }
  return {
    confidence: "TRACK_RECORD_ESTABLISHED",
    ...base,
    observedMissRatePct: (budget.outcomeChangingMisses / budget.auditedDecisions) * 100,
    explanation: `${budget.auditedDecisions} audited decisions, ${budget.outcomeChangingMisses} outcome-changing miss(es)`,
  };
}
