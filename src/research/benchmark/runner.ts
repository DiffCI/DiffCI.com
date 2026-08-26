import type { RepositoryMetadata, ResearchRepository, BenchmarkRecord, CommitDelta, EvidenceStore } from "../types.js";
import { cloneOrUpdateRepo } from "../repository/collector.js";
import { sampleCommits, classifyCommit } from "../repository/sampler.js";
import { parseRepositoryWorkflows } from "../baseline/workflow-parser.js";
import { buildGenericTaskRegistry } from "../baseline/registry.js";
import { runGenericPathBaseline } from "../baseline/path-baseline.js";
import { runDiffCIAnalysis } from "../diffci/adapter.js";
import { runPathBaseline } from "../../planner/path-baseline.js";
import { collectHistoricalEvidenceForDelta } from "../historical/evidence-collector.js";
import type { RateBudget } from "../historical/rate-budget.js";

export interface RepoBenchmarkResult {
  metadata: RepositoryMetadata;
  records: BenchmarkRecord[];
  errors: string[];
  /** Count of sampled deltas that were skipped because a completed record for the same
   * logicalDeltaKey already existed in the evidence store - i.e. resumed, not re-analyzed. */
  resumedFromExisting: number;
}

export interface Stage0ConfigSnapshot {
  experimentId: string;
  diffciVersion: string;
  schemaVersion: string;
  repoCacheDir: string;
  cacheDir: string;
  cloneDepth: number;
  maxCommitsPerRepository: number;
  recentCommitWindow: number;
  excludeMergeCommits: boolean;
  excludeBotCommits: boolean;
  graphTimeouts: Record<string, number>;
  dryRun?: boolean;
  /** Opt-in: attempt historical CI evidence collection (see historical/evidence-collector.ts). Off by
   * default - without a GitHub token, the unauthenticated rate budget is small enough that attempting
   * it unconditionally on every local/test run would be wasteful and pointless. */
  collectHistoricalEvidence?: boolean;
  githubToken?: string;
  /** Shared across every repository/delta in a single Stage 0 run, since the GitHub rate budget is
   * account-wide, not per-repository - see docs/research/2026-08-20-*-architecture.md §4. */
  historicalRateBudget?: RateBudget;
  /** Stage 1B (2026-08-21): opt-in cross-commit flakiness checking for candidate unsafe misses - see
   * evidence-collector.ts's checkFlakiness option and flakiness-check.ts. Off by default. */
  checkHistoricalFlakiness?: boolean;
}

export interface RunBenchmarkOptions {
  repo: ResearchRepository;
  store: EvidenceStore;
  config: Stage0ConfigSnapshot;
  dryRun?: boolean;
  /** When provided, analyze exactly these commits instead of calling sampleCommits() - the mechanism
   * the Stage 0 medium batch's Cloudflare orchestrator uses to dispatch a specific already-planned
   * batch of deltas (chosen by the Worker after checking D1 for already-completed work) rather than
   * having each container call re-sample and re-decide what to analyze. Deterministic sampling still
   * happens exactly once, in the separate "sample" phase - see scripts/cloudflare-sample-commits.ts. */
  commits?: { baseSha: string; headSha: string }[];
}

export async function runRepoBenchmark(options: RunBenchmarkOptions): Promise<RepoBenchmarkResult> {
  const { repo, store, config, dryRun } = options;
  const metadata = cloneOrUpdateRepo(repo, config.repoCacheDir, config.cloneDepth);
  const result: RepoBenchmarkResult = { metadata, records: [], errors: [], resumedFromExisting: 0 };

  if (metadata.exclusionReason) {
    await store.put(`repositories/${repo.owner}-${repo.name}.json`, metadata);
    return result;
  }
  await store.put(`repositories/${repo.owner}-${repo.name}.json`, metadata);

  const commits =
    options.commits ??
    sampleCommits(metadata, {
      maxCommits: config.maxCommitsPerRepository,
      recentCommitWindow: config.recentCommitWindow,
      excludeMergeCommits: config.excludeMergeCommits,
      excludeBotCommits: config.excludeBotCommits,
    });
  if (commits.length === 0) {
    result.errors.push("no commits sampled");
    return result;
  }

  const baselineProfile = await buildRepoProfile(metadata);
  const parsedWorkflows = parseRepositoryWorkflows(baselineProfile, metadata.localPath);
  const taskRegistry = buildGenericTaskRegistry(baselineProfile, repo.primaryLanguage, parsedWorkflows);

  if (dryRun) {
    return runDryRunCommits(commits, repo, taskRegistry, result, config);
  }

  for (const commit of commits) await analyzeCommit(commit, repo, taskRegistry, result, store, config);
  return result;
}

export async function analyzeCommit(
  commit: { baseSha: string; headSha: string },
  repo: ResearchRepository,
  taskRegistry: import("../../planner/task-registry.js").TaskRegistry,
  result: RepoBenchmarkResult,
  store: EvidenceStore,
  config: Stage0ConfigSnapshot,
): Promise<void> {
  const logicalDeltaKey = `${repo.owner}/${repo.name}:${commit.baseSha}:${commit.headSha}:${config.diffciVersion}:${config.schemaVersion}`;

  // Resumability: a rerun (after a crash, a budget stop, or an explicit re-invocation) must not
  // recompute a delta that was already successfully analyzed and persisted under the same
  // logicalDeltaKey. The evidence store is the source of truth for "already done" - see
  // diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md §2.
  const existingRecord = (await store.get(`commits/${logicalDeltaKey}.json`)) as BenchmarkRecord | undefined;
  if (existingRecord) {
    result.records.push(existingRecord);
    result.resumedFromExisting++;
    return;
  }

  const identity: CommitDelta = {
    repository: `${repo.owner}/${repo.name}`,
    baseSha: commit.baseSha,
    headSha: commit.headSha,
    logicalDeltaKey,
    experimentId: config.experimentId,
    diffCiVersion: config.diffciVersion,
    schemaVersion: config.schemaVersion,
    category: "unknown",
    gitDelta: { baseSha: commit.baseSha, headSha: commit.headSha, files: [], directories: [], summary: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: 0 }, analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } },
  };
  try {
    const analysis = await runDiffCIAnalysis({
      repoPath: result.metadata.localPath,
      commitDelta: identity,
      taskRegistry,
      cacheDir: `${config.cacheDir}/${repo.owner}-${repo.name}`,
      excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"],
      timeoutMs: graphTimeoutFor(repo.sizeClass, config),
    });
    identity.category = classifyCommit(analysis.identity.gitDelta.files);
    const pathBaseline = runGenericPathBaseline(taskRegistry, analysis.identity.gitDelta.files);
    const fullTasks = taskRegistry.all().length;
    const diffciTasks = analysis.plan.tasks.filter((t) => t.status !== "SKIP_CANDIDATE").length;
    const pathTasks = pathBaseline.selectedTaskIds.length;
    const alwaysRunTasks = analysis.plan.tasks.filter((t) => t.alwaysRun).length;

    // Individual-test-level counts, distinct from the coarse task counts above. Reuses the
    // real production per-test PATH baseline (src/planner/path-baseline.ts) rather than
    // reinventing test-level selection in the research harness.
    const testsTotal = analysis.profile.testFilePaths.length;
    const testsSelectedByDiffci = analysis.plan.selectedTests.length;
    const testPathBaseline = runPathBaseline(analysis.profile.testFilePaths, analysis.identity.gitDelta.files, analysis.profile);
    const testsSelectedByPath = testPathBaseline.selectedTests.length;

    // Invariant check (Stage 1A, 2026-08-21): 0 <= selected <= total must always hold. Deliberately NOT
    // clamped - see BenchmarkRecord.testCountInvariantViolation's doc comment for the root cause this
    // guards against (no per-delta checkout to headSha; a file added historically and later renamed is
    // invisible to the tip-state test scan while still reported "added" by the headSha-independent
    // git-diff). Flagging (not silently fixing) keeps the anomaly visible for exclusion at aggregation
    // time, matching the precedent already established for sindresorhus/ky's known test-count gap.
    let testCountInvariantViolation: BenchmarkRecord["testCountInvariantViolation"];
    if (testsSelectedByDiffci > testsTotal) {
      testCountInvariantViolation = { reason: `testsSelectedByDiffci (${testsSelectedByDiffci}) > testsTotal (${testsTotal})` };
    } else if (testsSelectedByPath > testsTotal) {
      testCountInvariantViolation = { reason: `testsSelectedByPath (${testsSelectedByPath}) > testsTotal (${testsTotal})` };
    }

    const record: BenchmarkRecord = {
      identity,
      repository: `${repo.owner}/${repo.name}`,
      language: repo.primaryLanguage,
      framework: repo.framework,
      sizeClass: repo.sizeClass,
      category: identity.category,
      fallback: analysis.plan.safety.fallbackRequired,
      fallbackReasons: analysis.fallbackReasons,
      fullTasks,
      diffciTasks,
      pathBaselineTasks: pathTasks,
      alwaysRunTasks,
      taskReduction: {
        fullVsDiffci: fullTasks === 0 ? 0 : (fullTasks - diffciTasks) / fullTasks,
        fullVsPath: fullTasks === 0 ? 0 : (fullTasks - pathTasks) / fullTasks,
        pathVsDiffci: pathTasks === 0 ? 0 : (pathTasks - diffciTasks) / pathTasks,
      },
      testsTotal,
      testsSelectedByPath,
      testsSelectedByDiffci,
      ...(testCountInvariantViolation ? { testCountInvariantViolation } : {}),
      timingMs: analysis.timing,
      cacheHit: !analysis.timing.coldCache,
      graphConfidence: analysis.graphResult.confidence,
      changedFileCount: analysis.identity.gitDelta.files.length,
      failureStatus: "NO_DATA",
    };

    if (config.collectHistoricalEvidence && config.historicalRateBudget) {
      const evidence = await collectHistoricalEvidenceForDelta({
        repository: `${repo.owner}/${repo.name}`,
        headSha: commit.headSha,
        token: config.githubToken,
        plan: analysis.plan,
        pathSelectedTaskIds: pathBaseline.selectedTaskIds,
        changedFiles: analysis.identity.gitDelta.files.map((f) => f.path),
        budget: config.historicalRateBudget,
        checkFlakiness: config.checkHistoricalFlakiness,
      });
      record.historicalEvidenceStatus = evidence.status;
      record.historicalEvidenceReason = evidence.reason;
      record.historicalFailedTargets = evidence.failedTargets;
      record.historicalUnsafeMissTargets = evidence.unsafeMissTargets;
      record.historicalPathUnsafeMissTargets = evidence.pathUnsafeMissTargets;
      record.historicalNonTestCategoryExcludedTargets = evidence.nonTestCategoryExcludedTargets;
      record.historicalLikelyFlakyExcludedTargets = evidence.likelyFlakyExcludedTargets;
    }

    result.records.push(record);
    await store.put(`commits/${logicalDeltaKey}.json`, record);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    result.errors.push(`${commit.headSha}: ${message}`);
  }
}

function runDryRunCommits(
  commits: { baseSha: string; headSha: string }[],
  repo: ResearchRepository,
  taskRegistry: import("../../planner/task-registry.js").TaskRegistry,
  result: RepoBenchmarkResult,
  config: Stage0ConfigSnapshot,
): RepoBenchmarkResult {
  const fullTasks = taskRegistry.all().length;
  for (const commit of commits) {
    const logicalDeltaKey = `${repo.owner}/${repo.name}:${commit.baseSha}:${commit.headSha}:${config.diffciVersion}:${config.schemaVersion}`;
    result.records.push({
      identity: {
        repository: `${repo.owner}/${repo.name}`,
        baseSha: commit.baseSha,
        headSha: commit.headSha,
        logicalDeltaKey,
        experimentId: config.experimentId,
        diffCiVersion: config.diffciVersion,
        schemaVersion: config.schemaVersion,
        category: "unknown",
        gitDelta: { baseSha: commit.baseSha, headSha: commit.headSha, files: [], directories: [], summary: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: 0 }, analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } },
      },
      repository: `${repo.owner}/${repo.name}`,
      language: repo.primaryLanguage,
      framework: repo.framework,
      sizeClass: repo.sizeClass,
      category: "unknown",
      fallback: true,
      fallbackReasons: ["DRY_RUN"],
      fullTasks,
      diffciTasks: fullTasks,
      pathBaselineTasks: fullTasks,
      alwaysRunTasks: 0,
      taskReduction: { fullVsDiffci: 0, fullVsPath: 0, pathVsDiffci: 0 },
      testsTotal: 0,
      testsSelectedByPath: 0,
      testsSelectedByDiffci: 0,
      timingMs: { gitAnalysisMs: 0, graphConstructionMs: 0, impactAnalysisMs: 0, plannerMs: 0, totalDiffCiOverheadMs: 0, coldCache: true },
      cacheHit: false,
      graphConfidence: "UNSAFE",
      changedFileCount: 0,
      failureStatus: "NO_DATA",
    });
  }
  return result;
}

async function buildRepoProfile(metadata: RepositoryMetadata): Promise<import("../../repo/types.js").RepositoryProfile> {
  try {
    const { analyzeRepository } = await import("../../repo/analyzer.js");
    return analyzeRepository({ repoPath: metadata.localPath, excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"] });
  } catch {
    return {
      packageManager: "unknown",
      packageJson: { scripts: {}, dependencies: [], devDependencies: [] },
      sourceRoots: [{ path: "src", kind: "source" }, { path: "lib", kind: "source" }, { path: "tests", kind: "tests" }],
      tests: [{ glob: "src/**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}", count: metadata.sourceFiles }],
      testFilePaths: [],
      workflows: [],
      configFiles: [],
      pathAliases: [],
      entryPoints: [],
      stats: { sourceFiles: metadata.sourceFiles, testFiles: 0, workflowFiles: metadata.workflowFiles, configFiles: 0 },
    } as import("../../repo/types.js").RepositoryProfile;
  }
}

function graphTimeoutFor(sizeClass: string, config: Stage0ConfigSnapshot): number {
  return config.graphTimeouts[`${sizeClass}Ms`] ?? 120_000;
}
