import { analyzeGitDelta } from "../../git/git-diff.js";
import { buildDependencyGraph, hydrateDependencyGraph } from "../../repo/graph.js";
import { ImpactAnalyzer } from "../../repo/impact.js";
import { GraphCache, buildGraphCacheKey, hashFileContents } from "../../cache/graph-cache.js";
import { DefaultCIPlanner } from "../../planner/planner.js";
import type { RepositoryProfile } from "../../repo/types.js";
import type { TaskRegistry } from "../../planner/task-registry.js";
import type { CommitDelta, DiffCIAnalysisResult } from "../types.js";
import { readFileContents } from "./utils.js";

export interface AnalyzeOptions {
  repoPath: string;
  commitDelta: CommitDelta;
  taskRegistry: TaskRegistry;
  cacheDir?: string;
  excludeDirs?: string[];
  timeoutMs?: number;
}

function nowMs(): number {
  return performance.now();
}

export async function runDiffCIAnalysis(options: AnalyzeOptions): Promise<DiffCIAnalysisResult> {
  const { repoPath, commitDelta, taskRegistry, cacheDir, excludeDirs = ["node_modules", ".next", "dist", "build", "target", "coverage"], timeoutMs = 120_000 } = options;

  const timing = {
    gitAnalysisMs: 0,
    graphConstructionMs: 0,
    graphLoadWarmMs: undefined as number | undefined,
    cacheInvalidationMs: undefined as number | undefined,
    impactAnalysisMs: 0,
    plannerMs: 0,
    totalDiffCiOverheadMs: 0,
    coldCache: true,
  };

  const tStart = nowMs();

  const gitStart = nowMs();
  const gitResult = await analyzeGitDelta({ repoPath, baseSha: commitDelta.baseSha, headSha: commitDelta.headSha });
  timing.gitAnalysisMs = nowMs() - gitStart;

  if (!gitResult.success) {
    throw new Error(`Git delta analysis failed for ${commitDelta.logicalDeltaKey}: ${gitResult.error}`);
  }

  // Populate the identity's gitDelta with the real computed delta. Downstream research
  // code (commit classification, changed-file counts, PATH baseline) reads
  // commitDelta.gitDelta directly, so leaving the caller's placeholder in place here
  // would silently corrupt those comparisons (e.g. every commit would look docs-only).
  commitDelta.gitDelta = gitResult.delta;

  let profile: RepositoryProfile;
  let graphResult: import("../../repo/types.js").DependencyGraphResult;

  const tGraphStart = nowMs();
  const cache = cacheDir ? new GraphCache({ cacheDir }) : undefined;
  const [tsconfigContents, packageJsonContents] = await Promise.all([
    readFileContents(repoPath, "tsconfig.json"),
    readFileContents(repoPath, "package.json"),
  ]);
  const cacheKey = buildGraphCacheKey({
    commitSha: commitDelta.headSha,
    tsconfigHash: tsconfigContents ? hashFileContents(tsconfigContents) : undefined,
    configHash: packageJsonContents ? hashFileContents(packageJsonContents) : undefined,
    diffciVersion: commitDelta.diffCiVersion,
  });

  const cached = cache?.load(cacheKey);
  if (cached) {
    cached.graph = hydrateDependencyGraph(cached.graph, repoPath);
    graphResult = cached;
    profile = graphResult.profile;
    timing.graphLoadWarmMs = nowMs() - tGraphStart;
    timing.coldCache = false;
  } else {
    const buildPromise = buildDependencyGraph({ repoPath, excludeDirs });
    graphResult = await withTimeout(buildPromise, timeoutMs, `graph construction exceeded ${timeoutMs}ms`);
    profile = graphResult.profile;
    timing.graphConstructionMs = nowMs() - tGraphStart;
    timing.coldCache = true;
    if (cache) {
      const tSaveStart = nowMs();
      cache.save(cacheKey, graphResult);
      timing.cacheInvalidationMs = nowMs() - tSaveStart;
    }
  }

  const tImpactStart = nowMs();
  const impact = new ImpactAnalyzer().analyze(gitResult.delta, graphResult, profile);
  timing.impactAnalysisMs = nowMs() - tImpactStart;

  const tPlannerStart = nowMs();
  const planner = new DefaultCIPlanner(taskRegistry);
  const plan = planner.plan({ delta: gitResult.delta, impact, profile });
  timing.plannerMs = nowMs() - tPlannerStart;
  timing.totalDiffCiOverheadMs = nowMs() - tStart;

  return {
    identity: commitDelta,
    profile,
    graphResult,
    plan,
    timing,
    cacheMetrics: {
      cacheHit: !timing.coldCache,
      serializedGraphSizeBytes: Buffer.byteLength(JSON.stringify(graphResult), "utf8"),
      heapDuringGraphBuildMb: graphResult.performance.heapUsedMb,
    },
    fallbackReasons: impact.fallbackReasons,
    classification: {
      // Stage 1B (2026-08-21): the per-delta-refined confidence (what actually gated fallbackRequired
      // below), not graphResult.confidence's raw/delta-independent value - see
      // refineConfidenceForDelta() in graph.ts. This is what gets persisted as BenchmarkRecord.
      // graphConfidence for research/aggregate purposes.
      graphConfidence: impact.effectiveGraphConfidence,
      languageSupported: profile.stats.sourceFiles > 0 || profile.stats.testFiles > 0,
      fallbackRequired: impact.fallbackRequired,
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolve(value);
    }, (error: unknown) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
