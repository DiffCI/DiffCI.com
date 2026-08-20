import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, it, beforeEach, afterEach } from "node:test";
import { buildStage0Report } from "../../src/research/benchmark/aggregator.js";
import { writeStage0Report } from "../../src/research/report/stage0-report.js";
import type { BenchmarkRecord, RepositoryMetadata, RepositoryResult } from "../../src/research/types.js";

function record(repository: string, i: number, fallback: boolean, reduction: number): BenchmarkRecord {
  const safeReduction = Math.max(0, Math.min(1, fallback ? 0 : reduction));
  return {
    identity: {
      repository,
      baseSha: `b${i}`,
      headSha: `h${i}`,
      logicalDeltaKey: `${repository}:b${i}:h${i}`,
      experimentId: "exp",
      diffCiVersion: "0.1.0",
      schemaVersion: "stage0-2",
      category: "unknown" as const,
      gitDelta: { baseSha: `b${i}`, headSha: `h${i}`, files: [], directories: [], summary: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: 0 }, analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } },
    },
    repository,
    language: "typescript",
    framework: "web-framework",
    sizeClass: "small",
    category: "unknown" as const,
    fallback,
    fallbackReasons: fallback ? ["NO_GRAPH"] : [],
    fullTasks: 10,
    diffciTasks: fallback ? 10 : 10 - Math.floor(10 * safeReduction),
    pathBaselineTasks: fallback ? 10 : 10 - Math.floor(10 * safeReduction * 0.5),
    alwaysRunTasks: 0,
    taskReduction: { fullVsDiffci: safeReduction, fullVsPath: safeReduction * 0.5, pathVsDiffci: safeReduction * 0.5 },
    testsTotal: 20,
    testsSelectedByPath: fallback ? 20 : 20 - Math.floor(20 * safeReduction * 0.5),
    testsSelectedByDiffci: fallback ? 20 : 20 - Math.floor(20 * safeReduction),
    timingMs: { gitAnalysisMs: 1, graphConstructionMs: 1, impactAnalysisMs: 1, plannerMs: 1, totalDiffCiOverheadMs: 5, coldCache: true },
    cacheHit: false,
    graphConfidence: fallback ? "UNSAFE" : (safeReduction > 0.2 ? "PARTIAL" : "COMPLETE"),
    changedFileCount: 1,
    failureStatus: "NO_DATA" as const,
  };
}

function repoResult(repository: string, count: number, fallback = false, reduction = 0.5): RepositoryResult {
  const records: BenchmarkRecord[] = [];
  for (let i = 0; i < count; i++) records.push(record(repository, i, fallback, reduction));
  const metadata: RepositoryMetadata = {
    repository,
    cloneUrl: `https://github.com/${repository}.git`,
    localPath: `/tmp/${repository}`,
    primaryLanguage: "typescript",
    framework: "web-framework",
    sizeClass: "small",
    license: "MIT",
    defaultBranch: "main",
    commitCount: count,
    sourceFiles: 50,
    workflowFiles: 2,
    languageSupport: { diffciGraphCapable: true, reason: "" },
    exclusionReason: undefined,
  };
  return {
    metadata,
    commitsAnalyzed: count,
    fallbackRate: fallback ? 1 : 0,
    medianTaskReduction: fallback ? 0 : reduction,
    pathBaselineMedianReduction: fallback ? 0 : reduction * 0.5,
    diffciIncrementalAdvantage: fallback ? 0 : reduction * 0.5,
    failureEvents: 0,
    unsafeMisses: 0,
    records,
  };
}

describe("stage0 aggregation", () => {
  it("aggregates per-delta test counts into summary totals and medians", () => {
    const report = buildStage0Report([repoResult("a/a", 4, false, 0.5)], {
      experimentId: "exp-tests",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
    });

    const records = report.repositoryResults.flatMap((r) => r.records);
    const expectedTotal = records.reduce((sum, r) => sum + r.testsTotal, 0);
    const expectedByPath = records.reduce((sum, r) => sum + r.testsSelectedByPath, 0);
    const expectedByDiffci = records.reduce((sum, r) => sum + r.testsSelectedByDiffci, 0);

    assert.equal(report.summary.testsTotalAcrossDeltas, expectedTotal);
    assert.equal(report.summary.testsSelectedByPathAcrossDeltas, expectedByPath);
    assert.equal(report.summary.testsSelectedByDiffciAcrossDeltas, expectedByDiffci);
    // Every fixture record here has testsTotal > 0 and diffci selects fewer/equal tests than path.
    assert.ok(report.summary.medianTestReductionByDiffci >= report.summary.medianTestReductionByPath);
  });

  it("reports STOP when the corpus is below Stage 1 thresholds", () => {
    const report = buildStage0Report([repoResult("a/a", 5)], {
      experimentId: "exp-1",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
      measuredSpendUsd: 0,
      budgetGuardTriggered: false,
    });

    assert.equal(report.summary.repositoriesAnalyzed, 1);
    assert.equal(report.summary.uniqueCommitDeltas, 5);
    assert.equal(report.summary.proceedToStage1, "STOP");
    assert.equal(report.summary.verdict.proceedTo100Repositories, "STOP");
  });

  it("reports PROCEED for a large enough sample with low fallback, low spend, and material advantage", () => {
    const results: RepositoryResult[] = [];
    for (let i = 0; i < 12; i++) results.push(repoResult(`repo${i}/repo${i}`, 50, false, 0.3));
    const report = buildStage0Report(results, {
      experimentId: "exp-2",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
      measuredSpendUsd: 60,
      budgetGuardTriggered: false,
    });

    assert.ok(report.summary.repositoriesAnalyzed >= 10);
    assert.ok(report.summary.uniqueCommitDeltas >= 500);
    assert.ok(report.summary.medianTaskReduction >= 0.25);
    assert.equal(report.summary.proceedToStage1, "PROCEED");
    assert.equal(report.summary.verdict.proceedTo100Repositories, "PROCEED");
    assert.equal(report.summary.verdict.cloudflareCostJustifiesStage1, true);
  });

  it("downgrades to PROCEED WITH CHANGES when the budget guard fires", () => {
    const results: RepositoryResult[] = [];
    for (let i = 0; i < 12; i++) results.push(repoResult(`repo${i}/repo${i}`, 50, false, 0.3));
    const report = buildStage0Report(results, {
      experimentId: "exp-3",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
      measuredSpendUsd: 250,
      budgetStatus: "BUDGET_STOPPED",
      budgetGuardTriggered: true,
    });

    assert.equal(report.summary.proceedToStage1, "PROCEED WITH CHANGES");
    assert.equal(report.summary.verdict.proceedTo100Repositories, "PROCEED WITH CHANGES");
    assert.equal(report.summary.budgetGuardTriggered, true);
    assert.equal(report.summary.verdict.cloudflareCostJustifiesStage1, false, "BUDGET_STOPPED must not claim cost justifies Stage 1");
  });

  it("dedupes records sharing a logicalDeltaKey and reports the duplicate count", () => {
    const repoA = repoResult("dup/repo", 3, false, 0.4);
    // Simulate a rerun/retry that reproduced one already-completed delta under the same key.
    repoA.records.push({ ...repoA.records[0]! });
    const report = buildStage0Report([repoA], {
      experimentId: "exp-dup",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
    });

    assert.equal(report.summary.uniqueCommitDeltas, 3, "duplicate record must not inflate unique delta count");
    assert.equal(report.summary.duplicateAnalyses, 1);
  });

  // Stage 1A regression test (2026-08-21, docs/research/2026-08-21-stage1a-valtio-anomaly.md): a delta
  // with testsSelectedByDiffci > testsTotal (or testsSelectedByPath > testsTotal) must be excluded from
  // every test-count-derived metric, NOT clamped, and NOT silently included - reproducing the exact
  // pmndrs/valtio anomaly Stage 0 found and manually excluded (testsTotal: 34, testsSelectedByDiffci: 35).
  it("excludes impossible test counts from aggregate metrics instead of clamping or silently including them", () => {
    const repoA = repoResult("valtio-like/repo", 2, false, 0.4);
    // A third, well-formed record establishes a real non-zero baseline so the exclusion is observable
    // (not just "everything is zero because there was only one bad record").
    repoA.records.push(record("valtio-like/repo", 2, false, 0.4));
    // Corrupt the third record into the exact impossible shape found in the real anomaly - selected
    // exceeds total, left exactly as computed (deliberately not clamped here either, matching runner.ts).
    repoA.records[2] = {
      ...repoA.records[2]!,
      testsTotal: 34,
      testsSelectedByDiffci: 35,
      testsSelectedByPath: 34,
      testCountInvariantViolation: { reason: "testsSelectedByDiffci (35) > testsTotal (34)" },
    };
    const withoutBadRecord = buildStage0Report([{ ...repoA, records: repoA.records.slice(0, 2) }], {
      experimentId: "exp-invariant-baseline",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
    });
    const withBadRecord = buildStage0Report([repoA], {
      experimentId: "exp-invariant",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
    });

    // The flagged delta still counts as a real, unique, analyzed delta (dedup/count integrity) ...
    assert.equal(withBadRecord.summary.uniqueCommitDeltas, 3);
    assert.equal(withBadRecord.summary.testCountInvalidDeltas, 1);
    // ... but every test-count-derived metric must be identical to the baseline that never saw it at
    // all - proving it was excluded, not clamped into some "corrected" value.
    assert.equal(withBadRecord.summary.testsTotalAcrossDeltas, withoutBadRecord.summary.testsTotalAcrossDeltas);
    assert.equal(withBadRecord.summary.testsSelectedByDiffciAcrossDeltas, withoutBadRecord.summary.testsSelectedByDiffciAcrossDeltas);
    assert.equal(withBadRecord.summary.testsSelectedByPathAcrossDeltas, withoutBadRecord.summary.testsSelectedByPathAcrossDeltas);
    assert.equal(withBadRecord.summary.medianTestReductionByDiffci, withoutBadRecord.summary.medianTestReductionByDiffci);
    assert.equal(withBadRecord.summary.medianTestReductionByPath, withoutBadRecord.summary.medianTestReductionByPath);
  });

  it("only computes failure recall from records with usable historical evidence", () => {
    const repoA = repoResult("recall/repo", 2, false, 0.4);
    repoA.records[0]!.historicalEvidenceStatus = "MEASURABLE";
    repoA.records[0]!.historicalFailedTargets = ["test:a", "test:b"];
    repoA.records[0]!.historicalUnsafeMissTargets = ["test:b"];
    repoA.records[0]!.historicalPathUnsafeMissTargets = [];
    // Second record has no evidence at all - must not be silently treated as "no failures".
    const report = buildStage0Report([repoA], {
      experimentId: "exp-recall",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
    });

    assert.equal(report.summary.historicalFailures, 2);
    assert.equal(report.summary.historicalFailingDeltas, 1);
    assert.equal(report.summary.unsafeMisses, 1);
    assert.equal(report.summary.pathUnsafeMisses, 0);
    assert.equal(report.summary.observedDiffciFailureRecall, 50);
    assert.equal(report.summary.observedPathFailureRecall, 100);
  });
});

describe("stage0 report", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(resolve(tmpdir(), "stage0-report-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes summary.json and summary.md with the required sections", () => {
    const report = buildStage0Report([repoResult("foo/bar", 2)], {
      experimentId: "exp-report",
      diffciVersion: "0.1.0",
      schemaVersion: "stage0-2",
    });

    writeStage0Report(report, tmpDir);

    assert.equal(existsSync(resolve(tmpDir, "summary.json")), true);
    assert.equal(existsSync(resolve(tmpDir, "summary.md")), true);

    const md = readFileSync(resolve(tmpDir, "summary.md"), "utf8");
    assert.ok(md.includes("## Final Questions"), "missing Final Questions section");
    assert.ok(md.includes("## Final Product Verdict"), "missing Final Product Verdict section");
    assert.ok(md.includes("DIFFCI STAGE 0 VERDICT"), "missing verbatim verdict block");
    assert.ok(md.includes("## Reproducibility"), "missing Reproducibility section");
  });
});
