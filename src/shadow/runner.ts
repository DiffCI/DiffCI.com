import { spawnSync } from "node:child_process";
import { analyzeGitDelta } from "../git/git-diff.js";
import { buildDependencyGraph, hydrateDependencyGraph } from "../repo/graph.js";
import { ImpactAnalyzer } from "../repo/impact.js";
import type { DependencyGraphResult } from "../repo/types.js";
import { GraphCache, buildGraphCacheKey, hashFileContents } from "../cache/graph-cache.js";
import { DefaultCIPlanner } from "../planner/planner.js";
import { buildGenericTaskRegistry } from "../research/baseline/registry.js";
import { parseRepositoryWorkflows } from "../research/baseline/workflow-parser.js";
import type { ShadowRunRecord, TimingBreakdown } from "./types.js";

export interface ShadowRunOptions {
  repoPath: string;
  baseSha: string;
  headSha: string;
  excludeDirs?: string[];
  cacheDir?: string;
}

function nowMs(): number {
  return performance.now();
}

async function readFileContents(repoPath: string, path: string): Promise<string | undefined> {
  try {
    const { readFileSync } = await import("node:fs");
    return readFileSync(`${repoPath}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

export async function runShadowAnalysis(options: ShadowRunOptions): Promise<ShadowRunRecord> {
  const {
    repoPath,
    baseSha,
    headSha,
    excludeDirs = ["diffci", "node_modules", ".next", "dist", "build"],
    cacheDir,
  } = options;

  const timing: TimingBreakdown = {
    gitAnalysisMs: 0,
    graphConstructionMs: 0,
    impactAnalysisMs: 0,
    plannerMs: 0,
    totalDiffCiOverheadMs: 0,
  };

  const tStart = nowMs();

  const tGitStart = nowMs();
  const gitResult = await analyzeGitDelta({ baseSha, headSha, repoPath });
  timing.gitAnalysisMs = nowMs() - tGitStart;

  if (!gitResult.success) {
    throw new Error(`Git delta analysis failed: ${gitResult.error}`);
  }

  const delta = gitResult.delta;

  let graphResult: DependencyGraphResult;
  let cacheMetrics: ShadowRunRecord["cacheMetrics"] | undefined;

  const cache = cacheDir ? new GraphCache({ cacheDir }) : undefined;
  const [tsconfigContents, packageJsonContents] = await Promise.all([
    readFileContents(repoPath, "tsconfig.json"),
    readFileContents(repoPath, "package.json"),
  ]);
  const cacheKey = buildGraphCacheKey({
    commitSha: headSha,
    tsconfigHash: tsconfigContents ? hashFileContents(tsconfigContents) : undefined,
    configHash: packageJsonContents ? hashFileContents(packageJsonContents) : undefined,
    diffciVersion: "0.6.0-phase6",
  });

  const tGraphStart = nowMs();
  const cached = cache?.load(cacheKey);
  if (cached) {
    cached.graph = hydrateDependencyGraph(cached.graph, repoPath, cached.profile?.testPatterns);
    graphResult = cached;
    timing.cacheInvalidationMs = 0;
    timing.graphLoadWarmMs = nowMs() - tGraphStart;
    cacheMetrics = {
      cacheHit: true,
      cacheKey,
      warmGraphLoadMs: timing.graphLoadWarmMs,
      serializedGraphSizeBytes: Buffer.byteLength(JSON.stringify(cached), "utf8"),
    };
  } else {
    graphResult = await buildDependencyGraph({ repoPath, excludeDirs });
    timing.graphConstructionMs = nowMs() - tGraphStart;
    timing.graphConstructionColdMs = timing.graphConstructionMs;
    if (cache) {
      const tSaveStart = nowMs();
      cache.save(cacheKey, graphResult);
      timing.cacheInvalidationMs = nowMs() - tSaveStart;
    }
    cacheMetrics = {
      cacheHit: false,
      cacheKey,
      coldGraphBuildMs: timing.graphConstructionColdMs,
      serializedGraphSizeBytes: Buffer.byteLength(JSON.stringify(graphResult), "utf8"),
      heapDuringGraphBuildMb: graphResult.performance.heapUsedMb,
      heapAfterGraphExtractionMb: graphResult.performance.heapAfterExtractionMb,
    };
  }

  const tImpactStart = nowMs();
  const impact = new ImpactAnalyzer().analyze(delta, graphResult, graphResult.profile, { repositoryFiles: gitResult.inventory?.files });
  timing.impactAnalysisMs = nowMs() - tImpactStart;

  const tPlannerStart = nowMs();
  // Phase 01 F4 (2026-08-26): this called buildDentalPresenceTaskRegistry(), so every repository it
  // analysed - any repository, this is the generic shadow entry point - was planned against
  // DentalPresence's ~20 CI tasks: WordPress plugin linting, AWS account validation, a Next.js
  // build. For unjs/h3 the resulting plan named tasks that repository has never had. The registry is
  // now derived from the target repository's own workflows and package.json scripts, which is what
  // the live cron path (scripts/cloudflare-shadow-poll.ts) had already been doing.
  const parsedWorkflows = parseRepositoryWorkflows(graphResult.profile, repoPath);
  const registry = buildGenericTaskRegistry(graphResult.profile, "typescript", parsedWorkflows);
  const planner = new DefaultCIPlanner(registry);
  const plan = planner.plan({ delta, impact, profile: graphResult.profile });
  timing.plannerMs = nowMs() - tPlannerStart;

  timing.totalDiffCiOverheadMs = nowMs() - tStart;

  const actualTasks = registry.all().map((t) => t.id);
  const proposedTasks = plan.tasks
    .filter((t) => t.status !== "SKIP_CANDIDATE")
    .map((t) => t.id);

  const record: ShadowRunRecord = {
    schemaVersion: "diffci-shadow/1",
    recordedAt: new Date().toISOString(),
    commit: { baseSha, headSha },
    changedFiles: delta.files.map((f) => f.path),
    impactFallback: impact.fallbackRequired,
    fallbackReasons: impact.fallbackReasons,
    plan,
    actualTasks,
    proposedTasks,
    actualTestCount: graphResult.profile.tests.reduce((sum, t) => sum + t.count, 0),
    selectedTestCount: plan.selectedTests.length,
    timing,
    cacheMetrics,
  };

  return record;
}

export function runGit(args: string[], repoPath: string): string {
  const result = spawnSync("git", args, { cwd: repoPath, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown"}`);
  }
  return result.stdout;
}
