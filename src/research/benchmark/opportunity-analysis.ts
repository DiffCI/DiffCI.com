/**
 * Opportunity classification for the Stage 0 medium batch (2026-08-21). The small/larger-batch reports
 * found the overall median incremental advantage over PATH sitting at 0%, and traced it to structural
 * ties (mandatory fallback, docs-only) diluting a real signal visible in individual deltas. This module
 * makes that explanation testable rather than assumed: every analyzed delta is assigned to exactly one
 * category using rules that do NOT reference DiffCI's own selection - so the category can't be circular
 * with the very comparison it's meant to explain (a category defined as "DiffCI wins" would prove
 * nothing). Only AFTER classification does anything compare DiffCI's selection to PATH's.
 */

export type OpportunityCategory = "MANDATORY_FALLBACK" | "BASELINE_ALREADY_OPTIMAL" | "DISCRIMINATIVE_OPPORTUNITY";

export interface ClassifiableRecord {
  fallback: boolean;
  testsTotal: number;
  testsSelectedByPath: number;
  testsSelectedByDiffci: number;
}

/**
 * Classification depends ONLY on `fallback` (DiffCI's own conservative-fallback determination, driven
 * by config/workflow/lockfile/graph-confidence rules that exist independently of any PATH comparison)
 * and `testsSelectedByPath` (PATH's own selection, alone). It never looks at testsSelectedByDiffci.
 *
 * - MANDATORY_FALLBACK: fallback === true. DiffCI was conservatively forced to FULL; there is no
 *   opportunity for it to do anything else, correct or not.
 * - BASELINE_ALREADY_OPTIMAL: fallback === false && testsSelectedByPath === 0. PATH already selected
 *   the floor (zero tests) - typically a docs-only change. Nothing can improve on zero.
 * - DISCRIMINATIVE_OPPORTUNITY: everything else - fallback === false && testsSelectedByPath > 0. PATH
 *   selected real work and DiffCI was not forced to FULL, so there is a genuine opportunity for the
 *   dependency graph to select a strict subset. Whether it actually DOES is a separate question,
 *   answered by classifyOutcome() below - not by this function.
 */
export function classifyOpportunity(record: Pick<ClassifiableRecord, "fallback" | "testsSelectedByPath">): OpportunityCategory {
  if (record.fallback) return "MANDATORY_FALLBACK";
  if (record.testsSelectedByPath === 0) return "BASELINE_ALREADY_OPTIMAL";
  return "DISCRIMINATIVE_OPPORTUNITY";
}

export type OpportunityOutcome = "DIFFCI_WIN" | "TIE" | "PATH_WIN";

/** Only meaningful for DISCRIMINATIVE_OPPORTUNITY deltas - callers should filter first. Compares the
 * two selections directly; this is the one place outcome-dependence is intentional (§6 of the spec asks
 * for a win rate CONDITIONAL ON opportunity, which necessarily compares outcomes within that subset). */
export function classifyOutcome(record: Pick<ClassifiableRecord, "testsSelectedByPath" | "testsSelectedByDiffci">): OpportunityOutcome {
  if (record.testsSelectedByDiffci < record.testsSelectedByPath) return "DIFFCI_WIN";
  if (record.testsSelectedByDiffci > record.testsSelectedByPath) return "PATH_WIN";
  return "TIE";
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) return sorted[lower]!;
  const weight = rank - lower;
  return sorted[lower]! * (1 - weight) + sorted[upper]! * weight;
}

export interface OpportunityAnalysis {
  totalDeltas: number;
  mandatoryFallbackCount: number;
  baselineAlreadyOptimalCount: number;
  discriminativeOpportunityCount: number;
  /** discriminativeOpportunityCount / totalDeltas - "how often does a real commit even present a
   * chance for dependency analysis to beat PATH?" */
  opportunityFrequency: number;
  /** Within DISCRIMINATIVE_OPPORTUNITY deltas only. */
  conditional: {
    diffciWins: number;
    ties: number;
    pathWins: number;
    /** diffciWins / discriminativeOpportunityCount - 0 if there were no opportunities at all. */
    winRate: number;
    /** Per-delta (path - diffci) / path, i.e. DiffCI's reduction relative to PATH's own selection,
     * computed only over discriminative-opportunity deltas (path > 0 is guaranteed by the category). */
    medianReductionVsPath: number;
    meanReductionVsPath: number;
    p25ReductionVsPath: number;
    p75ReductionVsPath: number;
    p90ReductionVsPath: number;
    aggregatePathSelected: number;
    aggregateDiffciSelected: number;
  };
}

export function computeOpportunityAnalysis(records: ClassifiableRecord[]): OpportunityAnalysis {
  let mandatoryFallbackCount = 0;
  let baselineAlreadyOptimalCount = 0;
  const discriminative: ClassifiableRecord[] = [];

  for (const record of records) {
    const category = classifyOpportunity(record);
    if (category === "MANDATORY_FALLBACK") mandatoryFallbackCount++;
    else if (category === "BASELINE_ALREADY_OPTIMAL") baselineAlreadyOptimalCount++;
    else discriminative.push(record);
  }

  let diffciWins = 0;
  let ties = 0;
  let pathWins = 0;
  const reductions: number[] = [];
  let aggregatePathSelected = 0;
  let aggregateDiffciSelected = 0;

  for (const record of discriminative) {
    const outcome = classifyOutcome(record);
    if (outcome === "DIFFCI_WIN") diffciWins++;
    else if (outcome === "PATH_WIN") pathWins++;
    else ties++;
    // testsSelectedByPath > 0 is guaranteed by the DISCRIMINATIVE_OPPORTUNITY category itself.
    reductions.push((record.testsSelectedByPath - record.testsSelectedByDiffci) / record.testsSelectedByPath);
    aggregatePathSelected += record.testsSelectedByPath;
    aggregateDiffciSelected += record.testsSelectedByDiffci;
  }

  return {
    totalDeltas: records.length,
    mandatoryFallbackCount,
    baselineAlreadyOptimalCount,
    discriminativeOpportunityCount: discriminative.length,
    opportunityFrequency: records.length === 0 ? 0 : discriminative.length / records.length,
    conditional: {
      diffciWins,
      ties,
      pathWins,
      winRate: discriminative.length === 0 ? 0 : diffciWins / discriminative.length,
      medianReductionVsPath: median(reductions),
      meanReductionVsPath: mean(reductions),
      p25ReductionVsPath: percentile(reductions, 25),
      p75ReductionVsPath: percentile(reductions, 75),
      p90ReductionVsPath: percentile(reductions, 90),
      aggregatePathSelected,
      aggregateDiffciSelected,
    },
  };
}

export interface AggregateWorkloadMetrics {
  sumTestsTotal: number;
  sumTestsSelectedByPath: number;
  sumTestsSelectedByDiffci: number;
  /** 1 - sum(diffciSelected) / sum(total) - across the ENTIRE sampled workload, not per-delta median. */
  aggregateReductionVsFull: number;
  /** 1 - sum(pathSelected) / sum(total) */
  aggregatePathReductionVsFull: number;
  /** 1 - sum(diffciSelected) / sum(pathSelected) - "across the actual sampled workload, how many test
   * executions would DiffCI eliminate relative to using PATH?" Distinct from median per-delta advantage
   * - a handful of large-fallback deltas dominate this sum in a way the median never sees. */
  aggregateDiffciReductionVsPath: number;
}

export function computeAggregateWorkloadMetrics(records: Pick<ClassifiableRecord, "testsTotal" | "testsSelectedByPath" | "testsSelectedByDiffci">[]): AggregateWorkloadMetrics {
  let sumTestsTotal = 0;
  let sumTestsSelectedByPath = 0;
  let sumTestsSelectedByDiffci = 0;
  for (const r of records) {
    sumTestsTotal += r.testsTotal;
    sumTestsSelectedByPath += r.testsSelectedByPath;
    sumTestsSelectedByDiffci += r.testsSelectedByDiffci;
  }
  return {
    sumTestsTotal,
    sumTestsSelectedByPath,
    sumTestsSelectedByDiffci,
    aggregateReductionVsFull: sumTestsTotal === 0 ? 0 : 1 - sumTestsSelectedByDiffci / sumTestsTotal,
    aggregatePathReductionVsFull: sumTestsTotal === 0 ? 0 : 1 - sumTestsSelectedByPath / sumTestsTotal,
    aggregateDiffciReductionVsPath: sumTestsSelectedByPath === 0 ? 0 : 1 - sumTestsSelectedByDiffci / sumTestsSelectedByPath,
  };
}
