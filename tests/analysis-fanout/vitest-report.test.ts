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

    // 2026-08-25: real bug found live during rolling-fingerprint sample 1/2 (deepseek-harness) -
    // process-exit.spec.ts's "managed pid <N> is still alive" failure recurred both runs but with a
    // different PID each time, so v1 normalization never collapsed it to one tracked signature - the
    // MOST consistently recurring failure in the whole mission could never accumulate samples. Fixed by
    // contextual (keyword-adjacent only) PID stripping; these tests pin that fix and its boundaries.
    describe("contextual PID normalization (v2, 2026-08-25 fix)", () => {
      it("collapses the real recurring failure - same test, different PID each run - to one signature", () => {
        const a = normalizeFailureSignature("Error: managed pid 669 is still alive at __vite_ssr_import_5__.vi.waitFor.interval (<path>)");
        const b = normalizeFailureSignature("Error: managed pid 667 is still alive at __vite_ssr_import_5__.vi.waitFor.interval (<path>)");
        assert.equal(a, b);
        assert.equal(a, "Error: managed pid <pid> is still alive at __vite_ssr_import_5__.vi.waitFor.interval (<path>)");
      });

      it("normalizes 'PID: <n>' (colon form) and 'process <n>' the same way as 'pid <n>'", () => {
        assert.equal(normalizeFailureSignature("worker PID: 4021 exited"), "worker pid <pid> exited");
        assert.equal(normalizeFailureSignature("child process 4021 exited"), "child process <pid> exited");
      });

      it("does NOT strip status codes or other meaningful numbers not adjacent to pid/process keywords", () => {
        const a = normalizeFailureSignature("AssertionError: expected 200, received 500");
        const b = normalizeFailureSignature("AssertionError: expected 200, received 404");
        assert.notEqual(a, b);
        assert.equal(a, "AssertionError: expected 200, received 500");
      });

      it("does NOT strip worker/count numbers that are part of the failure's own meaning", () => {
        const a = normalizeFailureSignature("1 worker failed");
        const b = normalizeFailureSignature("10 workers failed");
        assert.notEqual(a, b);
      });

      it("does NOT strip port/config numbers with no pid/process keyword nearby", () => {
        const a = normalizeFailureSignature("listen EADDRINUSE: address already in use :::5432");
        const b = normalizeFailureSignature("listen EADDRINUSE: address already in use :::5433");
        assert.notEqual(a, b);
      });

      it("does NOT false-positive on 'process' used as an ordinary word with no adjacent number (e.g. Node internal stack frames)", () => {
        const raw = "at processTicksAndRejections (node:internal/process/task_queues)";
        assert.equal(normalizeFailureSignature(raw), raw); // unchanged - no pid/process keyword directly adjacent to a number
      });
    });
  });
});
