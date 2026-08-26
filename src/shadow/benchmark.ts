import type { GitDelta } from "../git/types.js";
import { DefaultCIPlanner } from "../planner/planner.js";
import { runPathBaseline } from "../planner/path-baseline.js";
import { buildGenericTaskRegistry } from "../research/baseline/registry.js";
import type { ImpactResult } from "../repo/impact-types.js";
import type { DependencyGraphResult, RepositoryProfile } from "../repo/types.js";
import { categorizeCommit, computeAggregateStats, computeCategoryStats } from "./stats.js";
import type { BenchmarkReport, BenchmarkRun, CommitRange } from "./types.js";
import type { ExecutionPlan } from "../planner/types.js";

export const DIFFCI_VERSION = "0.5.0-phase5";

export function createBenchmarkRun(
  commit: CommitRange,
  delta: GitDelta,
  _graphResult: DependencyGraphResult,
  impact: ImpactResult,
  profile: RepositoryProfile,
  timing?: BenchmarkRun["timing"],
): BenchmarkRun {
  // Phase 01 F4 (2026-08-26): derived from the profile of the repository this record came from,
  // not from DentalPresence's task list. No repository path is available here, so workflow-derived
  // tasks are unavailable and the registry falls back to what package.json declares - which is
  // repository-specific in the right way, unlike what it replaced.
  const registry = buildGenericTaskRegistry(profile, "typescript", []);
  const planner = new DefaultCIPlanner(registry);
  const plan = planner.plan({ delta, impact, profile });

  // Real individual test file paths, not the glob patterns in profile.tests (see
  // src/planner/planner.ts's allTestPaths() for the same fix and why it matters).
  const allTestPaths = profile.testFilePaths;
  const baseline = {
    testsTotal: allTestPaths.length,
    tasksTotal: registry.all().length,
  };

  const pathBaseline = runPathBaseline(allTestPaths, delta.files);

  const testsSelected = plan.selectedTests.length;
  const tasksSelected = plan.tasks.filter(
    (t) => t.status === "RUN" || t.status === "ALWAYS_RUN" || t.status === "FULL_FALLBACK",
  ).length;

  const testReductionPercent = baseline.testsTotal
    ? ((baseline.testsTotal - testsSelected) / baseline.testsTotal) * 100
    : 0;
  const taskReductionPercent = baseline.tasksTotal
    ? ((baseline.tasksTotal - tasksSelected) / baseline.tasksTotal) * 100
    : 0;
  const pathBaselineReductionPercent = baseline.testsTotal
    ? ((baseline.testsTotal - pathBaseline.selectedTests.length) / baseline.testsTotal) * 100
    : 0;
  const diffCiAdvantageOverPathPercent = pathBaseline.selectedTests.length
    ? ((pathBaseline.selectedTests.length - testsSelected) / pathBaseline.selectedTests.length) * 100
    : 0;

  return {
    schemaVersion: "diffci-benchmark/1",
    recordedAt: new Date().toISOString(),
    diffciVersion: DIFFCI_VERSION,
    commit,
    commitCategory: categorizeCommit(delta.files.map((f) => f.path)),
    changedFiles: delta.files.map((f) => f.path),
    plan,
    baseline,
    proposed: {
      testsSelected,
      tasksSelected,
      alwaysRunTasks: plan.alwaysRunTasks.length,
      fallbackRequired: plan.safety.fallbackRequired,
    },
    pathBaseline: {
      testsSelected: pathBaseline.selectedTests.length,
      fallbackRequired: pathBaseline.fallbackRequired,
      matchedRules: pathBaseline.matchedRules,
    },
    metrics: {
      testReductionPercent,
      taskReductionPercent,
      pathBaselineReductionPercent,
      diffCiAdvantageOverPathPercent,
    },
    timing,
  };
}

export function fromShadowRecord(record: {
  commit: { baseSha: string; headSha: string };
  changedFiles: string[];
  plan: ExecutionPlan;
  timing?: import("./types.js").TimingBreakdown;
}): BenchmarkRun {
  const plan = record.plan;
  const fallbackRequired = plan.safety.fallbackRequired;
  const allTestPaths = fallbackRequired
    ? plan.selectedTests.slice()
    : Array.from(new Set([...plan.selectedTests, ...plan.skippedTests]));
  const pathBaseline = runPathBaseline(
    allTestPaths,
    record.changedFiles.map((p) => ({ path: p, changeType: "modified" })),
  );

  const testsSelected = plan.selectedTests.length;
  const tasksSelected = plan.tasks.filter((t) => t.status !== "SKIP_CANDIDATE").length;
  const taskTotal = plan.tasks.length;

  const testReductionPercent = allTestPaths.length
    ? ((allTestPaths.length - testsSelected) / allTestPaths.length) * 100
    : 0;
  const taskReductionPercent = taskTotal ? ((taskTotal - tasksSelected) / taskTotal) * 100 : 0;
  const pathBaselineReductionPercent = allTestPaths.length
    ? ((allTestPaths.length - pathBaseline.selectedTests.length) / allTestPaths.length) * 100
    : 0;
  const diffCiAdvantageOverPathPercent = pathBaseline.selectedTests.length
    ? ((pathBaseline.selectedTests.length - testsSelected) / pathBaseline.selectedTests.length) * 100
    : 0;

  return {
    schemaVersion: "diffci-benchmark/1",
    recordedAt: new Date().toISOString(),
    diffciVersion: DIFFCI_VERSION,
    commit: record.commit,
    commitCategory: categorizeCommit(record.changedFiles),
    changedFiles: record.changedFiles,
    plan,
    baseline: {
      testsTotal: allTestPaths.length,
      tasksTotal: taskTotal,
    },
    proposed: {
      testsSelected,
      tasksSelected,
      alwaysRunTasks: plan.alwaysRunTasks.length,
      fallbackRequired,
    },
    pathBaseline: {
      testsSelected: pathBaseline.selectedTests.length,
      fallbackRequired: pathBaseline.fallbackRequired,
      matchedRules: pathBaseline.matchedRules,
    },
    metrics: {
      testReductionPercent,
      taskReductionPercent,
      pathBaselineReductionPercent,
      diffCiAdvantageOverPathPercent,
    },
    timing: record.timing,
  };
}

export function buildBenchmarkReport(runs: BenchmarkRun[]): BenchmarkReport {
  return {
    schemaVersion: "diffci-benchmark-report/1",
    generatedAt: new Date().toISOString(),
    selectionMethod: "latest 50 non-merge commits on default branch",
    sampleSize: runs.length,
    aggregate: computeAggregateStats(runs),
    aggregateSelectiveOnly: computeAggregateStats(runs.filter((r) => !r.proposed.fallbackRequired)),
    categories: computeCategoryStats(runs),
    runs,
  };
}
