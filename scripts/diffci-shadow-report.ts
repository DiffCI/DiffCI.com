import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { buildShadowReport } from "../src/shadow/report.js";
import { DiffCiPersistence } from "../src/shadow/persistence.js";
import type { ShadowRunRecord, ShadowReport } from "../src/shadow/types.js";

const repoPath = resolve(dirname(import.meta.filename), "../..");
const SHADOW_DIR = resolve(repoPath, ".diffci/shadow");
const REPORT_DIR = resolve(repoPath, ".diffci/reports");
const SHADOW_JSONL = resolve(SHADOW_DIR, "shadow-runs.jsonl");

function readRecords(): { valid: ShadowRunRecord[]; malformed: unknown[] } {
  if (!existsSync(SHADOW_JSONL)) return { valid: [], malformed: [] };
  return new DiffCiPersistence({ directory: SHADOW_DIR }).readShadowRuns();
}

function formatMarkdown(report: ShadowReport): string {
  const a = report.aggregate;
  const lines: string[] = [
    "# DiffCI Phase 6 Shadow Report",
    "",
    `- Generated: ${report.generatedAt}`,
    `- Repository: ${report.repository ?? "unknown"}`,
    `- DiffCI version: ${report.diffciVersion}`,
    "",
    "## Identity",
    `- Raw shadow executions: ${a.rawExecutions}`,
    `- Unique commit deltas: ${a.uniqueCommitDeltas}`,
    `- Workflow retries: ${a.workflowRetries}`,
    `- Duplicate analyses: ${a.duplicateAnalyses}`,
    `- Complete records: ${a.completeRecords}`,
    `- Incomplete records: ${a.incompleteRecords}`,
    `- Malformed records: ${a.malformedRecords}`,
    "",
    "## Plan mode",
    `- DiffCI FULL: ${a.fullModeCount}`,
    `- DiffCI SELECTIVE: ${a.selectiveModeCount}`,
    `- Path baseline FULL: ${a.pathBaselineFullCount}`,
    "",
    "## Task reduction",
    `- Median potential task reduction: ${a.medianPotentialTaskReductionPercent.toFixed(1)}%`,
    "",
    "## Runtime reduction",
    a.medianMeasuredPotentialRuntimeReductionMs !== undefined
      ? `- Median measured potential runtime reduction: ${(a.medianMeasuredPotentialRuntimeReductionMs / 1000).toFixed(1)}s`
      : "- Insufficient baseline timing to calculate runtime reduction",
    "",
    "## Overhead",
    `- Median DiffCI analysis overhead: ${(a.medianDiffCiOverheadMs / 1000).toFixed(2)}s`,
    "",
    "## Cache",
    `- Cache hits: ${a.cacheHitCount}`,
    `- Cache misses: ${a.cacheMissCount}`,
    "",
    "## Failure recall",
    `- Failed tasks observed: ${a.failedTasksObserved}`,
    `- Failed tests observed: ${a.failedTestsObserved}`,
    `- Unsafe task misses: ${a.unsafeTaskMisses}`,
    `- Unsafe test misses: ${a.unsafeTestMisses}`,
    a.taskRecallPercent !== undefined ? `- Task recall: ${a.taskRecallPercent.toFixed(1)}%` : "- Task recall: N/A (no task failures observed)",
    a.testRecallPercent !== undefined ? `- Test recall: ${a.testRecallPercent.toFixed(1)}%` : "- Test recall: N/A (no test failures observed)",
    "",
    "## Verdict",
    "CONTINUE COLLECTING EVIDENCE — production skipping is NOT enabled.",
  ];
  return lines.join("\n");
}

function main() {
  const { valid: records, malformed } = readRecords();
  const report = buildShadowReport(records, {
    repository: process.env.GITHUB_REPOSITORY,
    malformedRecords: malformed.length,
  });

  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = resolve(REPORT_DIR, "phase6-shadow-report.json");
  const mdPath = resolve(REPORT_DIR, "phase6-shadow-report.md");

  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, formatMarkdown(report));

  console.log(JSON.stringify({
    rawExecutions: report.aggregate.rawExecutions,
    uniqueCommitDeltas: report.aggregate.uniqueCommitDeltas,
    selectiveDeltas: report.aggregate.selectiveModeCount,
    medianPotentialTaskReductionPercent: report.aggregate.medianPotentialTaskReductionPercent,
    medianDiffCiOverheadMs: report.aggregate.medianDiffCiOverheadMs,
    jsonPath,
    mdPath,
  }, null, 2));
}

main();
