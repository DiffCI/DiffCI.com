/**
 * 2026-09-05: the report must say, before any number, when a repository's CI evidence workflow has not
 * been identified - predictions may exist, ground truth and savings evidence cannot. Zero observations
 * must never masquerade as zero opportunity.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rollUpShadowReport } from "../../src/usage/shadow-report-rollup.js";
import { renderShadowReport } from "../../src/usage/shadow-report-render.js";

const WINDOW = { windowStartIso: "2026-09-01T00:00:00.000Z", windowEndIso: "2026-09-08T00:00:00.000Z" };
const SAFETY = { evaluableFailures: 0, failuresPreserved: 0, falseNegatives: 0 };

describe("report: evidence workflow state", () => {
  it("AWAITING_IDENTIFICATION renders the explicit notice with the prediction count and nothing else numeric", () => {
    const r = rollUpShadowReport({ repository: "acme/new", ...WINDOW, eligiblePredictions: 12, safety: SAFETY, observations: [], evidenceWorkflow: { state: "AWAITING_IDENTIFICATION" } });
    const text = renderShadowReport(r);
    assert.ok(text.includes("STATUS: SHADOW - AWAITING CI EVIDENCE WORKFLOW IDENTIFICATION"));
    assert.ok(text.includes("Predictions may be generated (12 in this window), but ground truth and"));
    assert.ok(text.includes("not zero opportunity"));
    assert.ok(!text.includes("[MEASURED]"), "no measured figure may appear");
    assert.ok(!text.includes("No completed CI workload was observed"), "this is not the insufficient-data message - it is a different state");
    assert.ok(!text.includes("STATUS: SHADOW - COLLECTING"));
  });

  it("IDENTIFIED names the evidence workflow and states the safety basis", () => {
    const r = rollUpShadowReport({
      repository: "acme/web", ...WINDOW, eligiblePredictions: 4, safety: { evaluableFailures: 2, failuresPreserved: 2, falseNegatives: 0 },
      observations: [{
        logicalDeltaKey: "k1", stage: "test", repository: "acme/web", headSha: "a".repeat(40), workflowRunIds: [1], jobIds: [1], fullWorkloadMs: 30_000,
        testsTotalFull: 70, testsSelectedDiffci: 5, testsSelectedPath: 35, diffciAnalysisOverheadMs: 300, planMode: "SELECTIVE", selectedWorkloadMs: 2143,
        selectedWorkloadConfidence: "count_based_estimate", avoidableMs: 27_857, avoidableTier: "ESTIMATED", estimationMethod: "linear_within_commit_ratio_v2:5/70",
        estimatorVersion: 2, estimatedAt: "2026-09-02T00:00:00Z", schemaVersion: 2, observedAt: "2026-09-02T00:00:00Z",
      }],
      evidenceWorkflow: { state: "IDENTIFIED", paths: [".github/workflows/ci.yml"] },
    });
    const text = renderShadowReport(r);
    assert.ok(text.includes("Evidence workflow: .github/workflows/ci.yml"));
    assert.ok(text.includes("safety is counted over VERIFIED ground truth only"));
  });

  it("a caller that did not look the state up gets NOT_STATED and the report neither claims nor denies identification", () => {
    const r = rollUpShadowReport({ repository: "acme/web", ...WINDOW, eligiblePredictions: 0, safety: SAFETY, observations: [] });
    assert.deepEqual(r.evidenceWorkflow, { state: "NOT_STATED" });
    assert.ok(!renderShadowReport(r).includes("AWAITING"));
  });
});
