import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyOpportunity,
  classifyOutcome,
  computeAggregateWorkloadMetrics,
  computeOpportunityAnalysis,
  type ClassifiableRecord,
} from "../../../src/research/benchmark/opportunity-analysis.js";

// Built for the 2026-08-21 Stage 0 medium batch. The spec is explicit: "Do NOT define
// DISCRIMINATIVE_OPPORTUNITY as 'a delta where DiffCI wins'... Classification must be independent of
// the final DiffCI-vs-PATH outcome. Otherwise the metric is circular and invalid." These tests guard
// that directly, not just the arithmetic.

function record(overrides: Partial<ClassifiableRecord>): ClassifiableRecord {
  return { fallback: false, testsTotal: 10, testsSelectedByPath: 5, testsSelectedByDiffci: 5, ...overrides };
}

describe("classifyOpportunity - non-circularity", () => {
  it("MANDATORY_FALLBACK whenever fallback is true, regardless of DiffCI's selection", () => {
    // DiffCI selecting fewer, equal, or MORE tests than PATH must not change the category - fallback
    // alone decides it.
    assert.equal(classifyOpportunity(record({ fallback: true, testsSelectedByDiffci: 0 })), "MANDATORY_FALLBACK");
    assert.equal(classifyOpportunity(record({ fallback: true, testsSelectedByDiffci: 5 })), "MANDATORY_FALLBACK");
    assert.equal(classifyOpportunity(record({ fallback: true, testsSelectedByDiffci: 10 })), "MANDATORY_FALLBACK");
  });

  it("BASELINE_ALREADY_OPTIMAL whenever PATH selected zero, regardless of DiffCI's selection", () => {
    assert.equal(classifyOpportunity(record({ fallback: false, testsSelectedByPath: 0, testsSelectedByDiffci: 0 })), "BASELINE_ALREADY_OPTIMAL");
    // Even the (real, observed) case where DiffCI selects MORE than PATH's already-zero floor.
    assert.equal(classifyOpportunity(record({ fallback: false, testsSelectedByPath: 0, testsSelectedByDiffci: 3 })), "BASELINE_ALREADY_OPTIMAL");
  });

  it("DISCRIMINATIVE_OPPORTUNITY is the residual case - not defined by DiffCI winning", () => {
    // A discriminative opportunity where DiffCI actually LOSES (selects more than PATH) must still be
    // classified DISCRIMINATIVE_OPPORTUNITY, not silently reclassified because the outcome is bad news.
    const diffciLoses = record({ fallback: false, testsSelectedByPath: 5, testsSelectedByDiffci: 8 });
    assert.equal(classifyOpportunity(diffciLoses), "DISCRIMINATIVE_OPPORTUNITY");

    const diffciTies = record({ fallback: false, testsSelectedByPath: 5, testsSelectedByDiffci: 5 });
    assert.equal(classifyOpportunity(diffciTies), "DISCRIMINATIVE_OPPORTUNITY");

    const diffciWins = record({ fallback: false, testsSelectedByPath: 5, testsSelectedByDiffci: 1 });
    assert.equal(classifyOpportunity(diffciWins), "DISCRIMINATIVE_OPPORTUNITY");
  });

  it("classification result is a pure function of (fallback, testsSelectedByPath) alone - proof by exhaustive DiffCI sweep", () => {
    // For every combination of fallback/pathSelected, sweeping testsSelectedByDiffci across its full
    // plausible range must never change the category. This is the direct non-circularity guarantee.
    for (const fallback of [true, false]) {
      for (const pathSelected of [0, 1, 5, 10]) {
        const categories = new Set<string>();
        for (const diffciSelected of [0, 1, 2, 5, 8, 10, 15]) {
          categories.add(classifyOpportunity(record({ fallback, testsSelectedByPath: pathSelected, testsSelectedByDiffci: diffciSelected })));
        }
        assert.equal(categories.size, 1, `category must be invariant to testsSelectedByDiffci for fallback=${fallback}, path=${pathSelected}`);
      }
    }
  });
});

describe("classifyOutcome", () => {
  it("DIFFCI_WIN when DiffCI selects strictly fewer tests than PATH", () => {
    assert.equal(classifyOutcome({ testsSelectedByPath: 10, testsSelectedByDiffci: 3 }), "DIFFCI_WIN");
  });
  it("PATH_WIN when DiffCI selects strictly MORE tests than PATH (a real observed case)", () => {
    assert.equal(classifyOutcome({ testsSelectedByPath: 10, testsSelectedByDiffci: 12 }), "PATH_WIN");
  });
  it("TIE when equal", () => {
    assert.equal(classifyOutcome({ testsSelectedByPath: 10, testsSelectedByDiffci: 10 }), "TIE");
  });
});

describe("computeOpportunityAnalysis", () => {
  it("partitions every record into exactly one category, with correct counts", () => {
    const records: ClassifiableRecord[] = [
      record({ fallback: true, testsSelectedByPath: 10, testsSelectedByDiffci: 10 }), // mandatory fallback
      record({ fallback: true, testsSelectedByPath: 5, testsSelectedByDiffci: 5 }), // mandatory fallback
      record({ fallback: false, testsSelectedByPath: 0, testsSelectedByDiffci: 0 }), // baseline optimal
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 2 }), // discriminative, diffci win
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 10 }), // discriminative, tie
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 12 }), // discriminative, path win
    ];
    const analysis = computeOpportunityAnalysis(records);
    assert.equal(analysis.totalDeltas, 6);
    assert.equal(analysis.mandatoryFallbackCount, 2);
    assert.equal(analysis.baselineAlreadyOptimalCount, 1);
    assert.equal(analysis.discriminativeOpportunityCount, 3);
    assert.equal(analysis.mandatoryFallbackCount + analysis.baselineAlreadyOptimalCount + analysis.discriminativeOpportunityCount, analysis.totalDeltas, "categories must exactly partition all records");
    assert.equal(analysis.opportunityFrequency, 3 / 6);
  });

  it("computes win/tie/loss and win rate conditional on opportunity only", () => {
    const records: ClassifiableRecord[] = [
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 2 }), // win
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 5 }), // win
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 10 }), // tie
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 15 }), // loss
    ];
    const analysis = computeOpportunityAnalysis(records);
    assert.equal(analysis.conditional.diffciWins, 2);
    assert.equal(analysis.conditional.ties, 1);
    assert.equal(analysis.conditional.pathWins, 1);
    assert.equal(analysis.conditional.winRate, 2 / 4);
  });

  it("reduction-vs-path stats are computed ONLY over discriminative-opportunity deltas", () => {
    const records: ClassifiableRecord[] = [
      record({ fallback: true, testsSelectedByPath: 999, testsSelectedByDiffci: 999 }), // excluded from conditional stats
      record({ fallback: false, testsSelectedByPath: 0, testsSelectedByDiffci: 0 }), // excluded (baseline optimal)
      record({ fallback: false, testsSelectedByPath: 10, testsSelectedByDiffci: 5 }), // 50% reduction
      record({ fallback: false, testsSelectedByPath: 20, testsSelectedByDiffci: 10 }), // 50% reduction
    ];
    const analysis = computeOpportunityAnalysis(records);
    assert.equal(analysis.conditional.medianReductionVsPath, 0.5);
    assert.equal(analysis.conditional.meanReductionVsPath, 0.5);
    assert.equal(analysis.conditional.aggregatePathSelected, 30);
    assert.equal(analysis.conditional.aggregateDiffciSelected, 15);
  });

  it("handles zero discriminative opportunities without dividing by zero", () => {
    const records: ClassifiableRecord[] = [record({ fallback: true }), record({ fallback: false, testsSelectedByPath: 0 })];
    const analysis = computeOpportunityAnalysis(records);
    assert.equal(analysis.discriminativeOpportunityCount, 0);
    assert.equal(analysis.conditional.winRate, 0);
    assert.equal(analysis.conditional.medianReductionVsPath, 0);
  });

  it("handles an empty record list", () => {
    const analysis = computeOpportunityAnalysis([]);
    assert.equal(analysis.totalDeltas, 0);
    assert.equal(analysis.opportunityFrequency, 0);
  });
});

describe("computeAggregateWorkloadMetrics", () => {
  it("reproduces the previous larger-study numbers exactly (293/777/910)", () => {
    // Real numbers from the 2026-08-20 larger study report, used here as a regression anchor.
    const metrics = computeAggregateWorkloadMetrics([{ testsTotal: 910, testsSelectedByPath: 777, testsSelectedByDiffci: 293 }]);
    assert.equal(metrics.sumTestsTotal, 910);
    assert.equal(metrics.sumTestsSelectedByPath, 777);
    assert.equal(metrics.sumTestsSelectedByDiffci, 293);
    assert.ok(Math.abs(metrics.aggregateReductionVsFull - 0.678) < 0.001, `expected ~67.8%, got ${metrics.aggregateReductionVsFull}`);
    assert.ok(Math.abs(metrics.aggregateDiffciReductionVsPath - 0.6229) < 0.001, `expected ~62.3%, got ${metrics.aggregateDiffciReductionVsPath}`);
  });

  it("aggregate reduction vs PATH differs from median per-delta advantage - the whole point of this metric", () => {
    // One huge FULL-fallback delta (dominates the sum) plus several small wins (would dominate a median).
    const records = [
      { testsTotal: 1000, testsSelectedByPath: 1000, testsSelectedByDiffci: 1000 }, // fallback, no reduction
      { testsTotal: 10, testsSelectedByPath: 10, testsSelectedByDiffci: 1 },
      { testsTotal: 10, testsSelectedByPath: 10, testsSelectedByDiffci: 1 },
      { testsTotal: 10, testsSelectedByPath: 10, testsSelectedByDiffci: 1 },
    ];
    const metrics = computeAggregateWorkloadMetrics(records);
    // sum diffci = 1003, sum path = 1030 -> aggregate reduction vs path is tiny even though 3/4 deltas
    // individually show a 90% reduction - this is the distribution-skew effect the report must surface.
    assert.ok(metrics.aggregateDiffciReductionVsPath < 0.05, `expected the huge fallback delta to swamp the aggregate, got ${metrics.aggregateDiffciReductionVsPath}`);
  });

  it("handles zero totals without dividing by zero", () => {
    const metrics = computeAggregateWorkloadMetrics([]);
    assert.equal(metrics.aggregateReductionVsFull, 0);
    assert.equal(metrics.aggregateDiffciReductionVsPath, 0);
  });
});
