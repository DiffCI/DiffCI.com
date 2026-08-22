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

describe("computeFailureRiskScore v1 - Part I environment-parity signals", () => {
  it("a confirmed MAJOR_MISMATCH parity verdict is now the single highest-weighted signal, even above a known fingerprint match", () => {
    const parity = computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "MAJOR_MISMATCH" });
    const fingerprint = computeFailureRiskScore({ ...baseInput(), matchesKnownFailureFingerprint: true });
    assert.ok(parity.failureRiskScore > fingerprint.failureRiskScore, "a deterministic, confirmed environment mismatch must outweigh a merely-statistical fingerprint recurrence");
  });

  it("a CONFLICTING parity verdict weighs the same as MAJOR_MISMATCH - both are confirmed, deterministic mismatches", () => {
    const mismatch = computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "MAJOR_MISMATCH" });
    const conflicting = computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "CONFLICTING" });
    assert.equal(mismatch.failureRiskScore, conflicting.failureRiskScore);
  });

  it("INCOMPATIBLE contributes risk but less than MAJOR_MISMATCH/CONFLICTING", () => {
    const incompatible = computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "INCOMPATIBLE" });
    const mismatch = computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "MAJOR_MISMATCH" });
    assert.ok(incompatible.failureRiskScore > 0);
    assert.ok(incompatible.failureRiskScore < mismatch.failureRiskScore);
  });

  it("COMPATIBLE and NEWER_COMPATIBLE contribute zero risk", () => {
    assert.equal(computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "COMPATIBLE" }).failureRiskScore, 0);
    assert.equal(computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "NEWER_COMPATIBLE" }).failureRiskScore, 0);
  });

  it("MISSING and MALFORMED verdicts are NOT treated as risk signals - an evaluation gap is not evidence of an actual mismatch", () => {
    assert.equal(computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "MISSING" }).failureRiskScore, 0);
    assert.equal(computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "MALFORMED" }).failureRiskScore, 0);
  });

  it("declaration/provisioning changes (Dockerfile, CI workflow, runtime requirement) each contribute their own explained, lower-weight reason", () => {
    const result = computeFailureRiskScore({ ...baseInput(), isRuntimeRequirementChange: true, isDockerfileChange: true, isCiWorkflowChange: true });
    assert.equal(result.riskReasons.length, 3);
    const mismatchWeight = computeFailureRiskScore({ ...baseInput(), runtimeParityVerdict: "MAJOR_MISMATCH" }).failureRiskScore;
    assert.ok(result.riskReasons.every((r) => r.weight < mismatchWeight), "leading indicators of possible drift must weigh less than a confirmed mismatch");
  });

  it("a verified stricter dependency runtime requirement contributes its own real, non-fabricated signal", () => {
    const result = computeFailureRiskScore({ ...baseInput(), dependencyRequiresNewerRuntimeThanDeclared: true });
    assert.ok(result.riskReasons.some((r) => r.signal === "dependency_requires_newer_runtime"));
  });

  it("a quiet change with no v1 signals set still produces zero score - v1 additions are fully backward compatible", () => {
    const result = computeFailureRiskScore(baseInput());
    assert.equal(result.failureRiskScore, 0);
  });
});
