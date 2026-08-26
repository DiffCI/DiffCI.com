/**
 * Tests for the M3 seven-day report: the rollup arithmetic and the vocabulary rules the rendered page
 * must never break.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollUpShadowReport } from "../../src/usage/shadow-report-rollup.js";
import { renderShadowReport } from "../../src/usage/shadow-report-render.js";
import type { ShadowEconomicsObservation } from "../../src/usage/shadow-economics.js";
import type { CiStage } from "../../src/shadow/stage-classification.js";

function obs(overrides: Partial<ShadowEconomicsObservation> = {}): ShadowEconomicsObservation {
  return {
    logicalDeltaKey: "k1",
    stage: "test" as CiStage,
    repository: "unjs/h3",
    headSha: "1892ee9cae06533c7db72a5213bceda61cc1d58d",
    workflowRunIds: [1001],
    jobIds: [1],
    fullWorkloadMs: 35_000,
    testsTotalFull: 70,
    testsSelectedDiffci: 1,
    planMode: "SELECTIVE",
    selectedWorkloadMs: 500,
    selectedWorkloadConfidence: "count_based_estimate",
    avoidableMs: 34_500,
    avoidableTier: "ESTIMATED",
    estimationMethod: "linear_within_commit_ratio_v2:1/70",
    estimatorVersion: 2,
    estimatedAt: "2026-08-26T03:40:00Z",
    schemaVersion: 1,
    observedAt: "2026-08-25T15:41:00Z",
    ...overrides,
  };
}

const SAFETY = { evaluableFailures: 0, failuresPreserved: 0, falseNegatives: 0 };
const WINDOW = { windowStartIso: "2026-08-19T00:00:00Z", windowEndIso: "2026-08-26T00:00:00Z" };

describe("rollUpShadowReport", () => {
  it("sums measured consumption per stage and counts distinct commits and workflow runs", () => {
    const r = rollUpShadowReport({
      repository: "unjs/h3",
      ...WINDOW,
      safety: SAFETY,
      observations: [
        obs({ logicalDeltaKey: "a", headSha: "aaa", workflowRunIds: [1, 2] }),
        obs({ logicalDeltaKey: "a", stage: "other", headSha: "aaa", workflowRunIds: [1, 2], fullWorkloadMs: 55_000, avoidableMs: undefined, avoidableTier: "UNKNOWN", testsTotalFull: undefined, testsSelectedDiffci: undefined }),
        obs({ logicalDeltaKey: "b", headSha: "bbb", workflowRunIds: [3], fullWorkloadMs: 63_000 }),
      ],
      // 2 distinct commits, 3 distinct runs
    });
    assert.equal(r.commitsObserved, 2);
    assert.equal(r.workflowRunsObserved, 3);
    assert.equal(r.totalObservedMs, 35_000 + 55_000 + 63_000);
    assert.equal(r.stages.find((s) => s.stage === "test")!.observedMs, 98_000);
    assert.equal(r.stages.find((s) => s.stage === "other")!.observedMs, 55_000);
  });

  it("measured avoidable compute is ALWAYS structurally zero in shadow mode", () => {
    const r = rollUpShadowReport({ repository: "unjs/h3", ...WINDOW, safety: SAFETY, observations: [obs()] });
    assert.equal(r.totalMeasuredAvoidableMs, 0);
  });

  it("sums estimated avoidable only over rows that could be estimated, and counts the rest as unknown", () => {
    const r = rollUpShadowReport({
      repository: "unjs/h3",
      ...WINDOW,
      safety: SAFETY,
      observations: [
        obs({ logicalDeltaKey: "a", headSha: "aaa", avoidableMs: 34_500, avoidableTier: "ESTIMATED" }),
        obs({ logicalDeltaKey: "b", headSha: "bbb", avoidableMs: undefined, avoidableTier: "UNKNOWN" }),
      ],
    });
    const test = r.stages.find((s) => s.stage === "test")!;
    assert.equal(test.estimatedAvoidableMs, 34_500, "the unknown row must not be silently counted as zero opportunity");
    assert.equal(test.estimatedRows, 1);
    assert.equal(test.unknownRows, 1);
  });

  it("classifiedFraction reports DiffCI's real coverage against TOTAL observed CI, not just the test slice", () => {
    const r = rollUpShadowReport({
      repository: "unjs/h3",
      ...WINDOW,
      safety: SAFETY,
      observations: [
        obs({ fullWorkloadMs: 20_000 }),
        obs({ logicalDeltaKey: "o", stage: "other", fullWorkloadMs: 80_000, avoidableTier: "UNKNOWN", avoidableMs: undefined }),
      ],
    });
    assert.equal(r.classifiedFraction, 0.2, "a low number is honest information about coverage, not something to hide by narrowing the denominator");
  });

  it("flags insufficient data when nothing was observed, rather than reporting zeros", () => {
    const r = rollUpShadowReport({ repository: "unjs/h3", ...WINDOW, safety: SAFETY, observations: [] });
    assert.equal(r.hasSufficientData, false);
    assert.ok(r.insufficientReason);
  });
});

describe("renderShadowReport - vocabulary rules", () => {
  const report = rollUpShadowReport({
    repository: "unjs/h3",
    ...WINDOW,
    safety: SAFETY,
    observations: [obs(), obs({ logicalDeltaKey: "o", stage: "other", fullWorkloadMs: 55_000, avoidableMs: undefined, avoidableTier: "UNKNOWN", testsTotalFull: undefined, testsSelectedDiffci: undefined })],
  });

  it("NEVER uses the word 'saved' - nothing was saved, because nothing was changed", () => {
    const text = renderShadowReport(report).toLowerCase();
    assert.ok(!text.includes("saved"), "shadow mode changes nothing; 'saved' is reserved for the activation phase");
    assert.ok(!text.includes("savings"));
  });

  it("qualifies every avoidable figure as estimated, and shows the selection ratio underneath it", () => {
    const text = renderShadowReport(report);
    assert.ok(text.includes("estimated avoidable compute"));
    assert.ok(text.includes("1 / 70 tests"), "the ratio is what makes the estimate inspectable rather than merely assertable");
    assert.ok(text.includes("selected execution:              not yet measured"));
  });

  it("states the structural zero for measured avoidable compute rather than omitting the line", () => {
    const text = renderShadowReport(report);
    assert.ok(text.includes("total measured avoidable compute"));
    assert.ok(text.includes("structurally zero"));
  });

  it("renders an unclassifiable stage as unknown opportunity, never as zero", () => {
    const text = renderShadowReport(report);
    assert.ok(text.includes("unknown opportunity"));
    assert.ok(!text.includes("avoidable compute: 0.0s  other"));
  });

  it("discloses the linear-cost caveat in the report itself, not only in the code", () => {
    const text = renderShadowReport(report);
    assert.ok(text.toLowerCase().includes("overstates"));
    assert.ok(text.toLowerCase().includes("startup"));
  });

  it("states plainly that DiffCI changed nothing", () => {
    assert.ok(renderShadowReport(report).includes("made no change"));
  });

  it("frames totals as a SAMPLE and a lower bound, never as the repository's full CI consumption", () => {
    const text = renderShadowReport(report);
    // Found by generating the first real report: unjs/h3 showed 255s for a week, which any maintainer
    // knows is far too small. Without this framing the headline reads as a census and destroys trust.
    assert.ok(text.includes("sample rather than a complete"));
    assert.ok(text.includes("lower bound"));
    assert.ok(!text.includes("CI compute consumed"), "must not assert what the repository spent overall");
  });

  it("does NOT report zero missed failures as a safety result when there were no failures to evaluate", () => {
    const text = renderShadowReport(report); // SAFETY fixture has 0 evaluable failures
    assert.ok(text.includes("absence of evidence"), "0 of 0 is not a safety demonstration");
    assert.ok(!text.includes("0 observed missed failures"));
  });

  it("reports a real safety result when failures actually were evaluable", () => {
    const withFailures = rollUpShadowReport({
      repository: "unjs/h3",
      ...WINDOW,
      safety: { evaluableFailures: 4, failuresPreserved: 4, falseNegatives: 0 },
      observations: [obs()],
    });
    const text = renderShadowReport(withFailures);
    assert.ok(text.includes("out of 4 evaluable failures"));
    assert.ok(!text.includes("absence of evidence"));
  });

  it("a FULL plan shows 'selected every test', not a limp 'up to 0.0s'", () => {
    const full = rollUpShadowReport({
      repository: "unjs/h3",
      ...WINDOW,
      safety: SAFETY,
      observations: [obs({ planMode: "FULL", testsSelectedDiffci: 70, avoidableMs: 0, fullWorkloadMs: 63_000 })],
    });
    const text = renderShadowReport(full);
    assert.ok(text.includes("none - this plan selected every test"));
    assert.ok(!text.includes("up to 0.0s"));
  });

  it("an empty window renders an explicit 'nothing observed' statement, never a page of zeros", () => {
    const empty = rollUpShadowReport({ repository: "unjs/h3", ...WINDOW, safety: SAFETY, observations: [] });
    const text = renderShadowReport(empty);
    assert.ok(text.includes("No completed CI workload was observed"));
    assert.ok(text.includes("not about this repository's activity"), "must not imply the repo was idle");
    assert.ok(!text.includes("0.0s  total estimated"), "no fabricated zero totals");
  });
});
