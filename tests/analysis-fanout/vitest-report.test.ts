import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeFailureSignature, parseVitestJsonReport } from "../../src/analysis-fanout/vitest-report.js";

describe("parseVitestJsonReport", () => {
  it("returns parsed:false and all-zero counts for undefined input - never fabricates a result", () => {
    const r = parseVitestJsonReport(undefined);
    assert.equal(r.parsed, false);
    assert.equal(r.tests, 0);
    assert.equal(r.failed, 0);
    assert.equal(r.passed, 0);
    assert.deepEqual(r.failedTests, []);
  });

  it("returns parsed:false for unparseable JSON - never treats a crash-before-report as passing", () => {
    const r = parseVitestJsonReport("not json{{{");
    assert.equal(r.parsed, false);
    assert.equal(r.tests, 0);
  });

  it("returns parsed:false for valid JSON that is a primitive or null (fails the object check)", () => {
    assert.equal(parseVitestJsonReport("42").parsed, false);
    assert.equal(parseVitestJsonReport("null").parsed, false);
  });

  it("treats a bare JSON array as an object with no recognizable fields - parsed:true, all zero (typeof [] is 'object')", () => {
    const r = parseVitestJsonReport("[]");
    assert.equal(r.parsed, true);
    assert.equal(r.tests, 0);
    assert.deepEqual(r.failedTests, []);
  });

  it("parses a passing report's summary counts", () => {
    const raw = JSON.stringify({
      numTotalTestSuites: 3,
      numFailedTestSuites: 0,
      numTotalTests: 12,
      numFailedTests: 0,
      numPassedTests: 12,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [],
    });
    const r = parseVitestJsonReport(raw);
    assert.equal(r.parsed, true);
    assert.equal(r.files, 3);
    assert.equal(r.tests, 12);
    assert.equal(r.failed, 0);
    assert.equal(r.passed, 12);
    assert.deepEqual(r.failedTests, []);
  });

  it("collects failedTests as 'file :: fullName', skipping non-failed assertions", () => {
    const raw = JSON.stringify({
      numTotalTestSuites: 1,
      numFailedTestSuites: 1,
      numTotalTests: 2,
      numFailedTests: 1,
      numPassedTests: 1,
      numPendingTests: 0,
      numTodoTests: 0,
      testResults: [
        {
          name: "/workspace/cal.diy/apps/web/lib/foo.test.ts",
          assertionResults: [
            { status: "passed", fullName: "foo does a thing", title: "does a thing" },
            { status: "failed", fullName: "foo breaks on bar", title: "breaks on bar" },
          ],
        },
      ],
    });
    const r = parseVitestJsonReport(raw);
    assert.equal(r.parsed, true);
    assert.equal(r.failedTests.length, 1);
    // name is trimmed to its last 3 path segments: ".../apps/web/lib/foo.test.ts" -> "web/lib/foo.test.ts"
    assert.equal(r.failedTests[0], "web/lib/foo.test.ts :: foo breaks on bar");
  });

  it("falls back to title when fullName is missing, and to 'unknown-test'/'unknown-file' when both are absent", () => {
    const raw = JSON.stringify({
      testResults: [
        { assertionResults: [{ status: "failed", title: "bare title" }] },
        { name: 42, assertionResults: [{ status: "failed" }] },
      ],
    });
    const r = parseVitestJsonReport(raw);
    assert.equal(r.parsed, true);
    assert.equal(r.failedTests[0], "unknown-file :: bare title");
    assert.equal(r.failedTests[1], "unknown-file :: unknown-test");
  });

  it("files count comes from testResults.length, not numTotalTestSuites, when they disagree (2026-08-24 real cal.com finding)", () => {
    // Real evidence from exec-calcom-29940-plainfilter1: Vitest 4.1.8's JSON reporter reported
    // numTotalTestSuites:14 for a genuine 2-file run (it counts nested describe blocks, not files) -
    // testResults.length (2, one entry per file) is the semantically correct, reliable file count.
    const raw = JSON.stringify({
      numTotalTestSuites: 14,
      numTotalTests: 20,
      numPassedTests: 20,
      numFailedTests: 0,
      testResults: [
        { name: "packages/lib/getReplyToHeader.test.ts", assertionResults: [] },
        { name: "apps/web/app/api/verify-booking-token/__tests__/route.test.ts", assertionResults: [] },
      ],
    });
    const r = parseVitestJsonReport(raw);
    assert.equal(r.parsed, true);
    assert.equal(r.files, 2); // NOT 14
    assert.equal(r.tests, 20);
  });

  it("falls back to numTotalTestSuites only when testResults is absent or empty", () => {
    const raw = JSON.stringify({ numTotalTestSuites: 5, testResults: [] });
    const r = parseVitestJsonReport(raw);
    assert.equal(r.files, 5);
  });

  it("treats missing numeric fields as 0 rather than throwing", () => {
    const r = parseVitestJsonReport(JSON.stringify({ testResults: [] }));
    assert.equal(r.parsed, true);
    assert.equal(r.files, 0);
    assert.equal(r.tests, 0);
  });

  describe("failureSignatures (2026-08-25, rolling-fingerprint mission)", () => {
    it("captures a normalized signature from the first failureMessages entry, keyed by the same 'file :: fullName' identity", () => {
      const raw = JSON.stringify({
        testResults: [{
          name: "/workspace/deepseek-ai__deepseek-harness/packages/host/frontend-static/tests/frontend-static.spec.ts",
          assertionResults: [{
            status: "failed",
            fullName: "real Loader composition serves explicit index entries",
            failureMessages: ["AssertionError: expected 404 to be 200\n    at /workspace/deepseek-ai__deepseek-harness/foo.ts:42:7"],
          }],
        }],
      });
      const r = parseVitestJsonReport(raw);
      const testId = "frontend-static/tests/frontend-static.spec.ts :: real Loader composition serves explicit index entries";
      assert.ok(r.failedTests.includes(testId));
      assert.equal(r.failureSignatures[testId], "AssertionError: expected 404 to be 200 at <path>");
    });

    it("a failed test with no failureMessages at all gets no signature entry - never fabricated", () => {
      const raw = JSON.stringify({
        testResults: [{ name: "a.spec.ts", assertionResults: [{ status: "failed", fullName: "x" }] }],
      });
      const r = parseVitestJsonReport(raw);
      assert.equal(Object.keys(r.failureSignatures).length, 0);
    });

    it("normalizeFailureSignature strips paths, line:col, timestamps, durations and UUIDs so the SAME underlying failure produces the SAME signature across two differently-formatted messages", () => {
      const a = normalizeFailureSignature("Error at /workspace/repo/foo.ts:10:5 after 123ms, id 550e8400-e29b-41d4-a716-446655440000");
      const b = normalizeFailureSignature("Error at C:\\repo\\foo.ts:99:1 after 4.2s, id 6ba7b810-9dad-11d1-80b4-00c04fd430c8");
      assert.equal(a, b);
      assert.equal(a, "Error at <path> after <duration>, id <uuid>");
    });

    it("normalizeFailureSignature does NOT collapse two genuinely different assertion messages to the same signature", () => {
      const a = normalizeFailureSignature("AssertionError: expected 404 to be 200");
      const b = normalizeFailureSignature("TypeError: cannot read property 'x' of undefined");
      assert.notEqual(a, b);
    });
  });
});
