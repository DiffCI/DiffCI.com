/**
 * Three reductions, kept apart, because only one of them is attributable to DiffCI.
 *
 * THE PROBLEM THIS EXISTS TO PREVENT. Every savings figure so far has been DiffCI measured against
 * running the whole suite. That comparison answers "how much less did we run", and it is the wrong
 * question for both an invoice and a carbon claim, because part of that reduction was available for
 * free. On honojs/hono, DiffCI's median selection was 15% of the suite - which sounds excellent - while
 * a path rule that knows nothing about imports had a median of 8 tests out of 136, and beat DiffCI on
 * 14 of 25 commits. Reporting the gross reduction there would credit DiffCI with a saving the customer
 * could have had by writing three lines of YAML.
 *
 * So three numbers are preserved independently, and never collapsed:
 *
 *   GROSS        full -> DiffCI          how much less ran, in total
 *   BASELINE     full -> comparator      how much a cheap path rule would have avoided anyway
 *   INCREMENTAL  comparator -> DiffCI    what DiffCI actually added
 *
 * INCREMENTAL CAN BE NEGATIVE, AND NEGATIVES ARE KEPT. A negative value means DiffCI ran MORE than the
 * cheap alternative - which is real, has been observed on two of four repositories, and is exactly the
 * signal that says where DiffCI should not be monetised and where the selection layer needs work.
 * Clamping it at zero would delete the most commercially useful thing this module computes.
 *
 * The gross figure is not deleted either: it is honest about total compute avoided, which is what a
 * customer's own CI bill responds to. But an investment or climate claim rests on the incremental
 * number, because that is the part caused by DiffCI rather than by the repository being easy.
 */

/** One unit of work - a test file, a job, a second of compute. The arithmetic does not care which. */
export interface WorkloadComparison {
  /** What running everything would have executed. */
  full: number;
  /** What a simple path-rule CI would have executed - DiffCI's own carried comparator. */
  comparator: number;
  /** What DiffCI selected. */
  diffci: number;
}

export interface AttributedReduction {
  /** full - diffci. What a CI bill sees. Never negative unless DiffCI selected more than everything. */
  gross: number;
  /** full - comparator. Available without DiffCI, to anyone willing to write a path rule. */
  baseline: number;
  /**
   * comparator - diffci. The part attributable to DiffCI.
   *
   * NEGATIVE MEANS DIFFCI RAN MORE THAN THE CHEAP ALTERNATIVE. Preserved, never clamped.
   */
  incremental: number;
  /** Fractions of `full`, for reporting. Undefined when `full` is zero rather than dividing by it. */
  grossPercent: number | undefined;
  baselinePercent: number | undefined;
  incrementalPercent: number | undefined;
  /**
   * Whether DiffCI beat the cheap alternative here. The one-word summary, derived rather than judged,
   * and deliberately NOT thresholded into a HIGH/LOW opportunity rating - there is not yet enough
   * repository coverage to choose a trustworthy threshold, and a made-up one would be worse than none.
   */
  diffciBeatsComparator: boolean;
}

export function attributeReduction(work: WorkloadComparison): AttributedReduction {
  const gross = work.full - work.diffci;
  const baseline = work.full - work.comparator;
  const incremental = work.comparator - work.diffci;
  const share = (value: number): number | undefined => (work.full > 0 ? value / work.full : undefined);

  return {
    gross,
    baseline,
    incremental,
    grossPercent: share(gross),
    baselinePercent: share(baseline),
    incrementalPercent: share(incremental),
    diffciBeatsComparator: incremental > 0,
  };
}

/**
 * Aggregates many comparisons while keeping the three reductions separate.
 *
 * Sums rather than averages percentages: averaging per-commit percentages weights a commit that
 * avoided two tests equally with one that avoided two hundred, which flatters small changes. The
 * percentages here are therefore recomputed from the summed totals.
 */
export function aggregateAttribution(comparisons: readonly WorkloadComparison[]): AttributedReduction & { commits: number; commitsWhereDiffciLost: number } {
  const totals = comparisons.reduce<WorkloadComparison>((acc, c) => ({ full: acc.full + c.full, comparator: acc.comparator + c.comparator, diffci: acc.diffci + c.diffci }), { full: 0, comparator: 0, diffci: 0 });

  const attributed = attributeReduction(totals);
  return {
    ...attributed,
    commits: comparisons.length,
    // Counted, not averaged away. A negative aggregate can hide behind one huge win, and "DiffCI ran
    // more than a path rule on 14 of 25 commits" is a fact a customer would want before paying.
    commitsWhereDiffciLost: comparisons.filter((c) => c.comparator - c.diffci < 0).length,
  };
}
