import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseVitestJsonReport } from "../../src/analysis-fanout/vitest-report.js";

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

  it("treats missing numeric fields as 0 rather than throwing", () => {
    const r = parseVitestJsonReport(JSON.stringify({ testResults: [] }));
    assert.equal(r.parsed, true);
    assert.equal(r.files, 0);
    assert.equal(r.tests, 0);
  });
});
