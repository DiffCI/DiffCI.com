import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyReconciliationOutcome, isEligibleForPrevention, reconcile } from "../../src/preflight/reconciliation.js";
import { InMemoryPredictionStore, type CreatePredictionInput } from "../../src/preflight/prediction-store.js";
import type { PredictionRecord } from "../../src/preflight/prediction-store.js";

function basePrediction(overrides: Partial<PredictionRecord> = {}): PredictionRecord {
  return {
    id: "pred-1",
    repositoryOwnerName: "adityankale190895/DiffCI.com",
    commitSha: "abc123",
    createdAt: "2026-08-22T10:00:00.000Z",
    mode: "LIVE",
    changedFiles: ["package.json"],
    riskScore: 0,
    riskReasons: [],
    recommendedChecks: [],
    predictedFailureClasses: [],
    expectedEarlyDetectionStrategy: "n/a",
    evidenceVersion: "p1-v1",
    algorithmVersion: "risk-model-v1",
    ...overrides,
  };
}

describe("isEligibleForPrevention - the concrete 'eligible for prevention' definition", () => {
  it("true when a recommended check's failureClassesDetected includes the actual class", () => {
    assert.equal(isEligibleForPrevention("CONFIGURATION", ["runtime_parity"]), true);
  });
  it("false when no recommended check covers the actual class", () => {
    assert.equal(isEligibleForPrevention("SECURITY_SCAN", ["runtime_parity", "typecheck"]), false);
  });
  it("false for an empty recommendedChecks list", () => {
    assert.equal(isEligibleForPrevention("TYPECHECK", []), false);
  });
  it("false for an unknown check id (never crashes, never assumes coverage)", () => {
    assert.equal(isEligibleForPrevention("TYPECHECK", ["does-not-exist"]), false);
  });

  it("real bug fix (found running Part G's actual replay, 2026-08-22): a low-confidence check (known_pattern_match, 0.5) that merely LISTS a class does not count as eligible - a bare registry declaration is not genuine predictive evidence", () => {
    assert.equal(isEligibleForPrevention("UNIT_TEST", ["known_pattern_match"]), false);
    assert.equal(isEligibleForPrevention("UNIT_TEST", ["affected_tests"]), false, "affected_tests confidence (0.6) is also below the deterministic-tier bar");
  });

  it("high-confidence deterministic-tier checks (>= 0.85) still count as eligible", () => {
    assert.equal(isEligibleForPrevention("TYPECHECK", ["typecheck"]), true);
    assert.equal(isEligibleForPrevention("CONFIGURATION", ["runtime_parity"]), true);
    assert.equal(isEligibleForPrevention("DEPENDENCY", ["dependency_validation"]), true);
  });

  it("a custom minConfidence can be supplied to loosen or tighten the bar explicitly", () => {
    assert.equal(isEligibleForPrevention("UNIT_TEST", ["known_pattern_match"], undefined, 0.4), true);
    assert.equal(isEligibleForPrevention("TYPECHECK", ["typecheck"], undefined, 0.99), false, "typecheck's own confidence (0.95) is below an unusually strict 0.99 bar");
  });
});

describe("classifyReconciliationOutcome - Part E TP/TN/FP/FN/NOT_EVALUABLE", () => {
  it("TN: no risk predicted, CI succeeded", () => {
    const result = classifyReconciliationOutcome({ prediction: basePrediction(), workflowRunId: "r1", workflowConclusion: "success", totalWorkflowDurationMs: 1000 });
    assert.equal(result.outcome, "TN");
  });

  it("FP: risk predicted, CI succeeded anyway", () => {
    const result = classifyReconciliationOutcome({
      prediction: basePrediction({ predictedFailureClasses: ["CONFIGURATION"] }),
      workflowRunId: "r1",
      workflowConclusion: "success",
      totalWorkflowDurationMs: 1000,
    });
    assert.equal(result.outcome, "FP");
  });

  it("TP: CI failed with a class one of the prediction's recommended checks actually detects", () => {
    const result = classifyReconciliationOutcome({
      prediction: basePrediction({ predictedFailureClasses: ["CONFIGURATION"], recommendedChecks: ["runtime_parity"] }),
      workflowRunId: "r1",
      workflowConclusion: "failure",
      actualFailureClass: "CONFIGURATION",
      totalWorkflowDurationMs: 1000,
    });
    assert.equal(result.outcome, "TP");
  });

  it("FN: CI failed but no recommended check covers the actual class - a genuine miss", () => {
    const result = classifyReconciliationOutcome({
      prediction: basePrediction({ recommendedChecks: ["lint"] }),
      workflowRunId: "r1",
      workflowConclusion: "failure",
      actualFailureClass: "UNIT_TEST",
      totalWorkflowDurationMs: 1000,
    });
    assert.equal(result.outcome, "FN");
  });

  it("NOT_EVALUABLE: CI failed but no actual failure class could be determined", () => {
    const result = classifyReconciliationOutcome({ prediction: basePrediction(), workflowRunId: "r1", workflowConclusion: "failure", totalWorkflowDurationMs: 1000 });
    assert.equal(result.outcome, "NOT_EVALUABLE");
    assert.match(result.reason, /insufficient evidence/);
  });

  it("NOT_EVALUABLE: actual failure class is RUNNER_INFRASTRUCTURE - not attributable to Preflight's predictive power", () => {
    const result = classifyReconciliationOutcome({
      prediction: basePrediction({ recommendedChecks: ["runtime_parity"] }),
      workflowRunId: "r1",
      workflowConclusion: "failure",
      actualFailureClass: "RUNNER_INFRASTRUCTURE",
      totalWorkflowDurationMs: 1000,
    });
    assert.equal(result.outcome, "NOT_EVALUABLE");
  });

  it("NOT_EVALUABLE: actual failure class is FLAKY", () => {
    const result = classifyReconciliationOutcome({ prediction: basePrediction(), workflowRunId: "r1", workflowConclusion: "failure", actualFailureClass: "FLAKY", totalWorkflowDurationMs: 1000 });
    assert.equal(result.outcome, "NOT_EVALUABLE");
  });

  it("NOT_EVALUABLE: a cancelled/skipped/timed_out conclusion carries no real ground truth", () => {
    for (const conclusion of ["cancelled", "skipped", "timed_out"]) {
      const result = classifyReconciliationOutcome({ prediction: basePrediction(), workflowRunId: "r1", workflowConclusion: conclusion, totalWorkflowDurationMs: 1000 });
      assert.equal(result.outcome, "NOT_EVALUABLE", `conclusion=${conclusion}`);
    }
  });

  it("real regression scenario: the Part A incident replayed as a reconciliation - CONFIGURATION failure, runtime_parity recommended, is TP", () => {
    const result = classifyReconciliationOutcome({
      prediction: basePrediction({ predictedFailureClasses: ["CONFIGURATION"], recommendedChecks: ["runtime_parity", "typecheck"] }),
      workflowRunId: "32557997213",
      workflowConclusion: "failure",
      actualFailureClass: "CONFIGURATION",
      actualErrorFingerprint: "ERR_UNKNOWN_BUILTIN_MODULE:node:sqlite",
      totalWorkflowDurationMs: 71_000,
    });
    assert.equal(result.outcome, "TP");
  });
});

describe("reconcile() - builds the full record, never touches the prediction", () => {
  it("produces a record referencing the prediction by id only, and never mutates the prediction object", () => {
    const prediction = basePrediction({ predictedFailureClasses: ["CONFIGURATION"], recommendedChecks: ["runtime_parity"] });
    const frozenPrediction = JSON.parse(JSON.stringify(prediction));
    const record = reconcile(
      { prediction, workflowRunId: "r1", workflowConclusion: "failure", actualFailureClass: "CONFIGURATION", totalWorkflowDurationMs: 5000 },
      () => "2026-08-22T11:00:00.000Z",
      () => "recon-1",
    );
    assert.equal(record.predictionId, "pred-1");
    assert.equal(record.outcome, "TP");
    assert.equal(record.reconciledAt, "2026-08-22T11:00:00.000Z");
    assert.equal(record.id, "recon-1");
    assert.deepEqual(prediction, frozenPrediction, "the prediction object must be byte-for-byte unchanged after reconciliation");
  });

  it("outcomeReason is always populated, even for NOT_EVALUABLE", () => {
    const record = reconcile({ prediction: basePrediction(), workflowRunId: "r1", workflowConclusion: "cancelled", totalWorkflowDurationMs: 0 });
    assert.equal(record.outcome, "NOT_EVALUABLE");
    assert.ok(record.outcomeReason.length > 0);
  });
});

describe("end-to-end: prediction-before-ground-truth wired to reconciliation", () => {
  it("a LIVE prediction can be created, then reconciled once, and a second LIVE prediction for the same commit is refused", async () => {
    const store = new InMemoryPredictionStore(() => "2026-08-22T10:00:00.000Z");
    const input: CreatePredictionInput = {
      repositoryOwnerName: "adityankale190895/DiffCI.com",
      commitSha: "real-sha",
      changedFiles: ["wrangler.github-runner.jsonc"],
      riskScore: 3,
      riskReasons: [],
      recommendedChecks: ["runtime_parity"],
      predictedFailureClasses: [],
      expectedEarlyDetectionStrategy: "runtime_parity",
      evidenceVersion: "p1-v1",
      algorithmVersion: "risk-model-v1",
    };
    const prediction = await store.createLivePrediction(input);

    const record = reconcile({ prediction, workflowRunId: "r1", workflowConclusion: "success", totalWorkflowDurationMs: 5000 }, () => "2026-08-22T10:05:00.000Z");
    assert.equal(record.outcome, "TN");

    store.recordGroundTruthKnown(input.repositoryOwnerName, input.commitSha);
    await assert.rejects(() => store.createLivePrediction(input));
  });
});
