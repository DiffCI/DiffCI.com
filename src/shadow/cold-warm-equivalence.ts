import { rmSync } from "node:fs";
import { buildDependencyGraph, hydrateDependencyGraph } from "../repo/graph.js";
import { analyzeGitDelta } from "../git/git-diff.js";
import { ImpactAnalyzer } from "../repo/impact.js";
import { DefaultCIPlanner } from "../planner/planner.js";
import { buildGenericTaskRegistry } from "../research/baseline/registry.js";
import { parseRepositoryWorkflows } from "../research/baseline/workflow-parser.js";
import { GraphCache, buildGraphCacheKey, hashFileContents } from "../cache/graph-cache.js";
import type { ExecutionPlan } from "../planner/types.js";

export interface EquivalenceResult {
  equivalent: boolean;
  coldPlan: ExecutionPlan;
  warmPlan: ExecutionPlan;
  diff?: string;
}

const EXCLUDE_DIRS = ["diffci", "node_modules", ".next", "dist", "build"];

async function readFileContents(repoPath: string, path: string): Promise<string | undefined> {
  try {
    const { readFileSync } = await import("node:fs");
    return readFileSync(`${repoPath}/${path}`, "utf8");
  } catch {
    return undefined;
  }
}

function planDigest(plan: ExecutionPlan): string {
  const tasks = plan.tasks.map((t) => `${t.id}=${t.status}=${t.reason}`).sort().join("|");
  const tests = [...plan.selectedTests].sort().join("|");
  const skipped = [...plan.skippedTests].sort().join("|");
  const fallbacks = [...plan.fallbackReasons].sort().join("|");
  return `${tasks};${tests};${skipped};${fallbacks}`;
}

export async function verifyColdWarmEquivalence(repoPath: string, cacheDir: string, baseSha: string, headSha: string): Promise<EquivalenceResult> {
  rmSync(cacheDir, { recursive: true, force: true });

  const gitResult = await analyzeGitDelta({ baseSha, headSha, repoPath });
  if (!gitResult.success) throw new Error(gitResult.error);
  const delta = gitResult.delta;
  const inventory = gitResult.inventory;

  async function analyze(): Promise<ExecutionPlan> {
    const cache = new GraphCache({ cacheDir });
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

    let graphResult;
    const cached = cache.load(cacheKey);
    if (cached) {
      cached.graph = hydrateDependencyGraph(cached.graph, repoPath, cached.profile?.testPatterns);
      graphResult = cached;
    } else {
      graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });
      cache.save(cacheKey, graphResult);
    }

    const impact = new ImpactAnalyzer().analyze(delta, graphResult, graphResult.profile, { repositoryFiles: inventory?.files });
    // Phase 01 F4 (2026-08-26): derived from the repository under test, not from DentalPresence.
    const registry = buildGenericTaskRegistry(graphResult.profile, "typescript", parseRepositoryWorkflows(graphResult.profile, repoPath));
    const planner = new DefaultCIPlanner(registry);
    return planner.plan({ delta, impact, profile: graphResult.profile });
  }

  const coldPlan = await analyze();
  const warmPlan = await analyze();
  const equivalent = planDigest(coldPlan) === planDigest(warmPlan);
  return {
    equivalent,
    coldPlan,
    warmPlan,
    diff: equivalent ? undefined : `cold: ${planDigest(coldPlan)}\nwarm: ${planDigest(warmPlan)}`,
  };
}
