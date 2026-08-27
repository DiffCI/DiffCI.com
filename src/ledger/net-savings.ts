/**
 * Net savings for one observation (Phase 04, 2026-08-26).
 *
 * WHAT "NET" MEANS, AND WHY IT IS THE WHOLE POINT. src/usage/savings.ts computes
 * `testsAvoided = total - selected`: DiffCI measured against running the entire suite. Phase 01 found
 * that comparator was a strawman - a simple path-rule CI already scopes most commits on most
 * repositories, so "everything" is not what the customer would otherwise have run. Every savings figure
 * computed that way overstates, sometimes enormously.
 *
 * This module measures DiffCI against the comparator each observation carries with it
 * (src/planner/path-baseline.ts, recorded per observation at ingest). Net avoided tests is therefore
 * `baselineSelected - diffciSelected`, and it is deliberately allowed to be NEGATIVE: on Phase 01's own
 * cohort the simple path rule beat DiffCI on two of nine repositories. A ledger that clamped that to
 * zero would be a ledger that cannot report bad news, and a customer's month is exactly where bad news
 * has to be visible.
 *
 * WHAT CAN AND CANNOT BE MEASURED. Counts are real: both sides are counted from the same test universe
 * the engine actually discovered, so a count difference is MEASURED. Time and money are not, and cannot
 * be, while DiffCI is observation-only - the selected side is never executed, so its duration is never
 * measured (src/usage/economics-classification.ts states this rule; `NetSavingsInput` below enforces it
 * by not admitting a "measured" duration at all). The strongest a time or cost figure can be here is ESTIMATED,
 * and without a per-repository duration observation it is UNKNOWN. Nothing in this file will produce a
 * MEASURED currency amount, and nothing downstream may invoice from anything less.
 */
import { toEvidenceTier, type EvidenceTier } from "../usage/economics-classification.js";
import type { ComputeCostModel } from "../usage/cost-model.js";
import type { SavingsConfidence, ValueWithConfidence } from "../usage/savings.js";
import type { ObservationRecord } from "../ingest/types.js";

export interface NetSavingsInput {
  /** Seconds per test, learned from this repository's own CI history. Absent means time stays UNKNOWN. */
  secondsPerTest?: { seconds: number; confidence: "historical_estimate" | "count_based_estimate" };
  costModel?: ComputeCostModel;
}

export interface ObservationNetSavings {
  observationId: string;
  repositoryId: string;
  receivedAt: string;
  /** False when the observation carries no usable counts (REFUSED, ERROR, or an empty test universe). */
  comparable: boolean;
  /** Why it is not comparable, for a reader deciding whether the month's coverage is good enough. */
  notComparableReason?: string;

  totalTests?: number;
  /** What DiffCI would have run. Equal to `totalTests` on a FULL verdict. */
  diffciSelected?: number;
  /** What a simple path-rule CI would have run. Equal to `totalTests` when the comparator fell back. */
  baselineSelected?: number;

  /**
   * baselineSelected - diffciSelected. Negative means the comparator would have run LESS than DiffCI:
   * a real, reportable outcome, never clamped.
   */
  netTestsAvoided?: number;
  /** totalTests - diffciSelected. Kept only so a reader can see how much of the headline number comes
   * from measuring against "run everything" rather than against the real comparator. */
  grossTestsAvoidedVsFullSuite?: number;

  /** Counts are counted; this is MEASURED whenever `comparable`. */
  countTier: EvidenceTier;
  /** Never MEASURED while DiffCI is observation-only. UNKNOWN without a duration observation. */
  netComputeSecondsAvoided: ValueWithConfidence<number>;
  netCostAvoidedUsd: ValueWithConfidence<number>;
  timeTier: EvidenceTier;
}

const UNKNOWN: ValueWithConfidence<number> = { value: "unknown", confidence: "unavailable" };

function notComparable(observation: ObservationRecord, reason: string): ObservationNetSavings {
  return {
    observationId: observation.id,
    repositoryId: observation.repositoryId,
    receivedAt: observation.receivedAt,
    comparable: false,
    notComparableReason: reason,
    countTier: "UNKNOWN",
    netComputeSecondsAvoided: UNKNOWN,
    netCostAvoidedUsd: UNKNOWN,
    timeTier: "UNKNOWN",
  };
}

/**
 * The duration side of a net figure.
 *
 * `NetSavingsInput.secondsPerTest` cannot carry the "measured" confidence - the type does not admit it -
 * so `toEvidenceTier` here can only ever return ESTIMATED, and UNKNOWN when no duration is supplied at
 * all. That is the "never MEASURED while observation-only" rule enforced by construction rather than by
 * a check someone could later relax: to produce a MEASURED time figure, a caller would have to widen
 * this type, which is a deliberate act with this comment attached to it.
 */
function durationSide(
  netTests: number,
  input: NetSavingsInput,
): { seconds: ValueWithConfidence<number>; cost: ValueWithConfidence<number>; tier: EvidenceTier } {
  if (!input.secondsPerTest || input.secondsPerTest.seconds < 0) {
    return { seconds: UNKNOWN, cost: UNKNOWN, tier: "UNKNOWN" };
  }
  const confidence: SavingsConfidence = input.secondsPerTest.confidence;
  const seconds = netTests * input.secondsPerTest.seconds;

  // Cost models price work, which is a non-negative quantity; a negative net figure is DiffCI costing
  // more than the comparator, so the magnitude is priced and the sign re-applied afterwards.
  const cost = input.costModel
    ? input.costModel.estimateCost({ computeSeconds: Math.abs(seconds) }).estimatedUsd
    : undefined;

  return {
    seconds: { value: seconds, confidence },
    cost: cost === undefined ? UNKNOWN : { value: seconds < 0 ? -cost : cost, confidence },
    tier: toEvidenceTier(confidence),
  };
}

export function computeNetSavings(observation: ObservationRecord, input: NetSavingsInput = {}): ObservationNetSavings {
  if (observation.status !== "OBSERVED") {
    return notComparable(observation, `the observation did not complete (${observation.status} at ${observation.stage})`);
  }
  const totalTests = observation.totalTestCount;
  if (typeof totalTests !== "number" || totalTests <= 0) {
    // An empty test universe is exactly the Phase 01 F1 failure mode. It must never read as "everything
    // was avoided"; it reads as "there is nothing to compare".
    return notComparable(observation, "the engine discovered no tests, so there is no universe to compare against");
  }
  if (observation.mode === undefined) {
    return notComparable(observation, "the observation recorded no verdict");
  }

  const diffciSelected = observation.mode === "FULL" ? totalTests : observation.selectedTestCount ?? 0;
  const baselineSelected =
    observation.baselineMode === "FULL"
      ? totalTests
      : observation.baselineSelectedTestCount ?? (observation.baselineMode === undefined ? undefined : 0);

  if (baselineSelected === undefined) {
    return notComparable(observation, "the observation carries no comparator, so no net figure can be produced");
  }

  const netTestsAvoided = baselineSelected - diffciSelected;
  const duration = durationSide(netTestsAvoided, input);

  return {
    observationId: observation.id,
    repositoryId: observation.repositoryId,
    receivedAt: observation.receivedAt,
    comparable: true,
    totalTests,
    diffciSelected,
    baselineSelected,
    netTestsAvoided,
    grossTestsAvoidedVsFullSuite: totalTests - diffciSelected,
    countTier: "MEASURED",
    netComputeSecondsAvoided: duration.seconds,
    netCostAvoidedUsd: duration.cost,
    timeTier: duration.tier,
  };
}
