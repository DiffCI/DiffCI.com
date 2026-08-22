import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyPreventability } from "../../src/preflight/preventability.js";

describe("classifyPreventability - Part 4 (not every failure is forced into 'preventable')", () => {
  it("TYPECHECK is always DETERMINISTIC_PREFLIGHT", () => {
    const result = classifyPreventability({ failureClass: "TYPECHECK", fingerprintSeenBefore: false });
    assert.equal(result.preventability, "DETERMINISTIC_PREFLIGHT");
  });

  it("CONFIGURATION (e.g. the real node:sqlite/Node-version case) is DETERMINISTIC_PREFLIGHT", () => {
    const result = classifyPreventability({ failureClass: "CONFIGURATION", fingerprintSeenBefore: false });
    assert.equal(result.preventability, "DETERMINISTIC_PREFLIGHT");
  });

  it("a UNIT_TEST failure whose changed files directly implicate the failing test is TARGETED_TEST_PREFLIGHT", () => {
    const result = classifyPreventability({ failureClass: "UNIT_TEST", fingerprintSeenBefore: false, changedFilesDirectlyImplicated: true });
    assert.equal(result.preventability, "TARGETED_TEST_PREFLIGHT");
  });

  it("a recurring fingerprint is KNOWN_FAILURE_PREFLIGHT even for a class that would otherwise be POTENTIALLY_PREDICTABLE", () => {
    const result = classifyPreventability({ failureClass: "UNIT_TEST", fingerprintSeenBefore: true, changedFilesDirectlyImplicated: false });
    assert.equal(result.preventability, "KNOWN_FAILURE_PREFLIGHT");
  });

  it("a UNIT_TEST failure with no direct implication and no known fingerprint is POTENTIALLY_PREDICTABLE, not forced into a stronger bucket", () => {
    const result = classifyPreventability({ failureClass: "UNIT_TEST", fingerprintSeenBefore: false, changedFilesDirectlyImplicated: false });
    assert.equal(result.preventability, "POTENTIALLY_PREDICTABLE");
  });

  it("SECURITY_SCAN with no known pattern is POTENTIALLY_PREDICTABLE, never DETERMINISTIC (a real security finding isn't 'cheaply' preventable)", () => {
    const result = classifyPreventability({ failureClass: "SECURITY_SCAN", fingerprintSeenBefore: false });
    assert.equal(result.preventability, "POTENTIALLY_PREDICTABLE");
  });

  it("RUNNER_INFRASTRUCTURE with no repeat is NOT_REASONABLY_PREVENTABLE", () => {
    const result = classifyPreventability({ failureClass: "RUNNER_INFRASTRUCTURE", fingerprintSeenBefore: false });
    assert.equal(result.preventability, "NOT_REASONABLY_PREVENTABLE");
  });

  it("explicit evidence of a transient cause forces NOT_REASONABLY_PREVENTABLE regardless of class", () => {
    const result = classifyPreventability({ failureClass: "UNIT_TEST", fingerprintSeenBefore: false, evidenceOfTransientCause: true });
    assert.equal(result.preventability, "NOT_REASONABLY_PREVENTABLE");
  });

  it("insufficientEvidence always forces UNKNOWN, overriding every other signal", () => {
    const result = classifyPreventability({ failureClass: "TYPECHECK", fingerprintSeenBefore: true, insufficientEvidence: true });
    assert.equal(result.preventability, "UNKNOWN");
  });

  it("DEPLOYMENT with no known pattern falls to UNKNOWN (no established rule for it yet) rather than being force-fit", () => {
    const result = classifyPreventability({ failureClass: "DEPLOYMENT", fingerprintSeenBefore: false });
    assert.equal(result.preventability, "UNKNOWN");
  });
});
