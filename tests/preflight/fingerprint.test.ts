import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailureFromEvidence, computeFailureFingerprint } from "../../src/preflight/fingerprint.js";

describe("classifyFailureFromEvidence - Part 1 (job name must not imply class)", () => {
  it("classifies a real node:sqlite CI failure as CONFIGURATION, not by the job name 'check'", () => {
    const cls = classifyFailureFromEvidence({ jobName: "check", stepName: "Run npm run check", errorText: "Error [ERR_UNKNOWN_BUILTIN_MODULE]: No such built-in module: node:sqlite" });
    assert.equal(cls, "CONFIGURATION");
  });

  it("classifies a real TypeScript compiler error as TYPECHECK", () => {
    const cls = classifyFailureFromEvidence({ jobName: "check", errorText: "src/foo.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'." });
    assert.equal(cls, "TYPECHECK");
  });

  it("classifies a node:test assertion failure as UNIT_TEST", () => {
    const cls = classifyFailureFromEvidence({ jobName: "check", errorText: "not ok 63 - tests/usage/store.test.ts\n  error: 'test failed'\n  code: 'ERR_TEST_FAILURE'" });
    assert.equal(cls, "UNIT_TEST");
  });

  it("classifies a CodeQL job's failure as SECURITY_SCAN regardless of the surrounding job name", () => {
    const cls = classifyFailureFromEvidence({ jobName: "Analyze (javascript-typescript)", errorText: "CodeQL detected a security alert in this analysis." });
    assert.equal(cls, "SECURITY_SCAN");
  });

  it("classifies a runner-shutdown symptom as RUNNER_INFRASTRUCTURE, not a test failure, even inside a 'check' job", () => {
    const cls = classifyFailureFromEvidence({ jobName: "check", errorText: "The runner has received a shutdown signal. This can happen when the runner service is stopped." });
    assert.equal(cls, "RUNNER_INFRASTRUCTURE");
  });

  it("returns UNKNOWN for evidence matching no established pattern, rather than guessing", () => {
    const cls = classifyFailureFromEvidence({ jobName: "check", errorText: "something entirely novel happened that no rule recognizes" });
    assert.equal(cls, "UNKNOWN");
  });
});

describe("computeFailureFingerprint - Part 3 (normalized, not raw-log hashing)", () => {
  it("produces the SAME fingerprint for two occurrences differing only in path/timestamp/duration", () => {
    const f1 = computeFailureFingerprint({ failureClass: "UNIT_TEST", jobName: "check", failingTest: "tests/usage/store.test.ts", errorText: "AssertionError at /home/runner/_work/repo/repo/tests/usage/store.test.ts:42:10 2026-08-22T06:30:18Z duration_ms: 301.23" });
    const f2 = computeFailureFingerprint({ failureClass: "UNIT_TEST", jobName: "check", failingTest: "tests/usage/store.test.ts", errorText: "AssertionError at /home/runner/_work/repo/repo/tests/usage/store.test.ts:99:3 2026-08-22T09:11:02Z duration_ms: 288.90" });
    assert.equal(f1, f2, "incidental path/timestamp/duration differences must not change the fingerprint");
  });

  it("produces DIFFERENT fingerprints for genuinely different failure classes", () => {
    const f1 = computeFailureFingerprint({ failureClass: "TYPECHECK", jobName: "check", errorText: "error TS2322" });
    const f2 = computeFailureFingerprint({ failureClass: "UNIT_TEST", jobName: "check", errorText: "AssertionError" });
    assert.notEqual(f1, f2);
  });

  it("produces DIFFERENT fingerprints for the same class but a different failing test", () => {
    const f1 = computeFailureFingerprint({ failureClass: "UNIT_TEST", jobName: "check", failingTest: "tests/a.test.ts", errorText: "AssertionError: expected 1 to equal 2" });
    const f2 = computeFailureFingerprint({ failureClass: "UNIT_TEST", jobName: "check", failingTest: "tests/b.test.ts", errorText: "AssertionError: expected 1 to equal 2" });
    assert.notEqual(f1, f2);
  });

  it("strips commit-SHA-shaped hex hashes so two runs against different commits with the identical underlying error still match", () => {
    const f1 = computeFailureFingerprint({ failureClass: "CONFIGURATION", jobName: "check", errorText: "failed for commit 9e4733471cedc8ec4e0a19932eca1d3a5815495d" });
    const f2 = computeFailureFingerprint({ failureClass: "CONFIGURATION", jobName: "check", errorText: "failed for commit b05b480d805fe5a7bd5cc4b45176de7e811be59e" });
    assert.equal(f1, f2);
  });
});
