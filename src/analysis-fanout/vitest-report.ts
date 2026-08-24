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
  parsed: boolean;
}

const EMPTY: VitestSummary = { files: 0, filesFailed: 0, tests: 0, failed: 0, passed: 0, skipped: 0, failedTests: [], parsed: false };

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
        failedTests.push(`${name} :: ${fullName}`);
      }
    }
  }
  const num = (key: string): number => (typeof report[key] === "number" ? (report[key] as number) : 0);
  return {
    files: num("numTotalTestSuites"),
    filesFailed: num("numFailedTestSuites"),
    tests: num("numTotalTests"),
    failed: num("numFailedTests"),
    passed: num("numPassedTests"),
    skipped: num("numPendingTests") + num("numTodoTests"),
    failedTests,
    parsed: true,
  };
}
