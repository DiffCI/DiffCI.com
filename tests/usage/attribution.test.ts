/**
 * The three reductions, and the one that matters commercially.
 *
 * The property under test throughout: a negative incremental reduction survives. It means DiffCI ran
 * MORE than a cheap path rule, it has been observed on real repositories, and clamping it would delete
 * the signal that says where DiffCI should not be sold.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { attributeReduction, aggregateAttribution } from "../../src/usage/attribution.js";

describe("attributeReduction", () => {
  it("separates what DiffCI added from what a path rule would have saved anyway", () => {
    // 100 tests; a path rule would run 40; DiffCI runs 25.
    const r = attributeReduction({ full: 100, comparator: 40, diffci: 25 });
    assert.equal(r.gross, 75, "75 fewer than running everything");
    assert.equal(r.baseline, 60, "60 of those were available for free");
    assert.equal(r.incremental, 15, "DiffCI is responsible for 15");
    assert.equal(r.diffciBeatsComparator, true);
  });

  it("keeps a negative incremental reduction instead of clamping it", () => {
    // The hono shape: DiffCI's selection looks small against the full suite and is worse than the
    // comparator. Gross flatters; incremental tells the truth.
    const r = attributeReduction({ full: 136, comparator: 8, diffci: 20 });
    assert.equal(r.gross, 116, "still 116 fewer than everything - true, and misleading on its own");
    assert.equal(r.baseline, 128);
    assert.equal(r.incremental, -12, "DiffCI ran twelve MORE than the cheap alternative");
    assert.equal(r.diffciBeatsComparator, false);
    assert.ok(r.incrementalPercent! < 0, "the percentage is negative too, not floored at zero");
  });

  it("reports no percentages rather than dividing by zero", () => {
    const r = attributeReduction({ full: 0, comparator: 0, diffci: 0 });
    assert.equal(r.grossPercent, undefined);
    assert.equal(r.baselinePercent, undefined);
    assert.equal(r.incrementalPercent, undefined);
  });

  it("treats an identical selection as no incremental benefit, not a small one", () => {
    const r = attributeReduction({ full: 100, comparator: 30, diffci: 30 });
    assert.equal(r.incremental, 0);
    assert.equal(r.diffciBeatsComparator, false, "equal is not better");
  });
});

describe("aggregateAttribution", () => {
  it("recomputes percentages from totals rather than averaging per-commit percentages", () => {
    // One tiny commit where DiffCI wins hugely in percentage terms, one large commit where it loses.
    // Averaging the percentages would report a win; summing the work reports the truth.
    const r = aggregateAttribution([
      { full: 10, comparator: 8, diffci: 1 },
      { full: 1000, comparator: 100, diffci: 400 },
    ]);
    assert.equal(r.incremental, 8 - 1 + (100 - 400), "-293 across the two");
    assert.ok(r.incremental < 0);
    assert.equal(r.diffciBeatsComparator, false);
  });

  it("counts the commits where DiffCI lost, so one big win cannot hide them", () => {
    const r = aggregateAttribution([
      { full: 100, comparator: 10, diffci: 20 },
      { full: 100, comparator: 10, diffci: 20 },
      { full: 100, comparator: 90, diffci: 5 },
    ]);
    assert.equal(r.commits, 3);
    assert.equal(r.commitsWhereDiffciLost, 2, "two of three, even though the aggregate is positive");
    assert.ok(r.incremental > 0, "the aggregate is positive because of the third commit alone");
  });

  it("handles an empty corpus without inventing a result", () => {
    const r = aggregateAttribution([]);
    assert.equal(r.commits, 0);
    assert.equal(r.gross, 0);
    assert.equal(r.grossPercent, undefined);
  });
});
