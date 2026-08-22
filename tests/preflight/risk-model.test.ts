import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeFailureRiskScore } from "../../src/preflight/risk-model.js";

function baseInput() {
  return { changedFileTypes: [".ts"], dependencyFanOut: 0, affectedTestCount: 1, matchesKnownFailureFingerprint: false, isConfigOrGlobalChange: false, isDependencyManifestChange: false, isMigrationOrSchemaChange: false, isGeneratedCodeChange: false };
}

describe("computeFailureRiskScore - Part 9 (explainable, additive, not a black box)", () => {
  it("a quiet, low-risk change produces a low score with no reasons", () => {
    const result = computeFailureRiskScore(baseInput());
    assert.equal(result.failureRiskScore, 0);
    assert.deepEqual(result.riskReasons, []);
  });

  it("every non-zero contribution is individually explainable via riskReasons", () => {
    const result = computeFailureRiskScore({ ...baseInput(), isConfigOrGlobalChange: true, isDependencyManifestChange: true });
    assert.equal(result.riskReasons.length, 2);
    assert.ok(result.riskReasons.every((r) => r.signal && r.detail));
    assert.equal(result.failureRiskScore, result.riskReasons.reduce((s, r) => s + r.weight, 0), "the total score must equal the sum of its own explained reasons - never a hidden adjustment");
  });

  it("a known failure fingerprint match is the single highest-weighted individual signal", () => {
    const withMatch = computeFailureRiskScore({ ...baseInput(), matchesKnownFailureFingerprint: true });
    const withoutMatch = computeFailureRiskScore(baseInput());
    assert.ok(withMatch.failureRiskScore > withoutMatch.failureRiskScore);
    const matchReason = withMatch.riskReasons.find((r) => r.signal === "known_failure_fingerprint_match");
    assert.ok(matchReason);
    assert.ok(withMatch.riskReasons.every((r) => r.weight <= matchReason!.weight));
  });

  it("zero affected tests contributes its own explicit risk reason", () => {
    const result = computeFailureRiskScore({ ...baseInput(), affectedTestCount: 0 });
    assert.ok(result.riskReasons.some((r) => r.signal === "zero_affected_tests"));
  });

  it("high dependency fan-out weighs more than moderate fan-out", () => {
    const high = computeFailureRiskScore({ ...baseInput(), dependencyFanOut: 50 });
    const moderate = computeFailureRiskScore({ ...baseInput(), dependencyFanOut: 10 });
    assert.ok(high.failureRiskScore > moderate.failureRiskScore);
  });
});
