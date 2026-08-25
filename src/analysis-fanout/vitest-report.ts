/**
 * Vitest JSON-reporter parsing (2026-08-24), extracted as a pure/testable module from the pattern
 * already used in scripts/diffci-execution-validation.ts. Never fabricates a result: a missing or
 * unparseable report file yields `parsed: false` and zero counts, which the caller must surface as
 * "unexecuted"/unknown, never as a passing or failing suite.
 */

export interface VitestSummary {
  files: number;
  filesFailed: number;
  tests: number;
  failed: number;
  passed: number;
  skipped: number;
  failedTests: string[];
  /** Normalized failure signature per failed test (2026-08-25, rolling-fingerprint mission) - keyed by
   * the SAME "file :: fullName" identity used in failedTests. Distinguishes "this exact test failed
   * again for the same reason" from "this exact test failed, but for a DIFFERENT reason" - a bare pass/
   * fail identity cannot tell those apart, and the rolling fingerprint's "known test, different signature
   * -> refuse" rule depends on being able to. See normalizeFailureSignature below for what "normalized"
   * strips. Absent (no entry) for a failed test whose report carried no failureMessages at all - treated
   * as an unknown/empty signature by callers, never fabricated. */
  failureSignatures: Record<string, string>;
  parsed: boolean;
}

const EMPTY: VitestSummary = { files: 0, filesFailed: 0, tests: 0, failed: 0, passed: 0, skipped: 0, failedTests: [], failureSignatures: {}, parsed: false };

/**
 * Strips the parts of a Vitest failure message that vary between otherwise-identical failures (absolute
 * paths, line:column positions, timestamps, durations, UUIDs, ANSI color codes) so the SAME underlying
 * assertion failure produces the SAME signature across repeated runs, while a genuinely different
 * assertion/error produces a different one. Deliberately conservative (a real behavior change SHOULD
 * usually still change the message text meaningfully even after normalization) - this is a heuristic, not
 * a semantic diff, and is documented as such rather than treated as infallible.
 */
export function normalizeFailureSignature(raw: string): string {
  return raw
    .replace(/\x1b\[[0-9;]*m/g, "") // ANSI color/style codes
    .replace(/[A-Za-z]:[\\/][^\s:()]+|\/[^\s:()]+\.[a-z]+/gi, "<path>") // absolute file paths (Windows or POSIX)
    .replace(/:\d+:\d+\b/g, "") // trailing line:column
    .replace(/\b\d{4}-\d{2}-\d{2}T[\d:.Z+-]+/g, "<timestamp>") // ISO-8601 timestamps
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\b\d+(\.\d+)?\s*m?s\b/g, "<duration>") // durations like "123ms" / "1.5s"
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500); // bounded - this is a comparison signature, not a stored transcript
}

export function parseVitestJsonReport(raw: string | undefined): VitestSummary {
  if (!raw) return { ...EMPTY };
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return { ...EMPTY };
  }
  if (typeof j !== "object" || j === null) return { ...EMPTY };
  const report = j as Record<string, unknown>;
  const failedTests: string[] = [];
  const failureSignatures: Record<string, string> = {};
  const testResults = Array.isArray(report.testResults) ? report.testResults : [];
  for (const f of testResults) {
    if (typeof f !== "object" || f === null) continue;
    const fileRecord = f as Record<string, unknown>;
    const name = typeof fileRecord.name === "string" ? fileRecord.name.replace(/\\/g, "/").split("/").slice(-3).join("/") : "unknown-file";
    const assertions = Array.isArray(fileRecord.assertionResults) ? fileRecord.assertionResults : [];
    for (const a of assertions) {
      if (typeof a !== "object" || a === null) continue;
      const assertion = a as Record<string, unknown>;
      if (assertion.status === "failed") {
        const fullName = typeof assertion.fullName === "string" ? assertion.fullName : String(assertion.title ?? "unknown-test");
        const testId = `${name} :: ${fullName}`;
        failedTests.push(testId);
        const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
        const firstMessage = messages.find((m): m is string => typeof m === "string");
        if (firstMessage !== undefined) failureSignatures[testId] = normalizeFailureSignature(firstMessage);
      }
    }
  }
  const num = (key: string): number => (typeof report[key] === "number" ? (report[key] as number) : 0);
  // `testResults.length` (one entry per test FILE), not `numTotalTestSuites`, is the reliable file
  // count (2026-08-24 real-world finding): on a real cal.com report, numTotalTestSuites read 14 for a
  // genuine 2-file run - Vitest's JSON reporter counts nested describe blocks as "suites", not files,
  // for at least this version/shape. Falls back to numTotalTestSuites only when testResults is absent
  // or empty (e.g. an older/different reporter shape), never silently trusting a mismatched field.
  const filesFromResults = testResults.length;
  return {
    files: filesFromResults > 0 ? filesFromResults : num("numTotalTestSuites"),
    filesFailed: num("numFailedTestSuites"),
    tests: num("numTotalTests"),
    failed: num("numFailedTests"),
    passed: num("numPassedTests"),
    skipped: num("numPendingTests") + num("numTodoTests"),
    failedTests,
    failureSignatures,
    parsed: true,
  };
}
