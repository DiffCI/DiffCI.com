import { existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { buildDependencyGraph } from "../src/repo/graph.js";
import { ImpactAnalyzer } from "../src/repo/impact.js";
import type { ImpactResult } from "../src/repo/impact-types.js";

const repoPath = resolve(dirname(import.meta.filename), "../..");
const SAMPLE_SIZE = 10;

function runGit(args: string[]): string {
  const result = spawnSync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim() || "unknown"}`);
  }
  return result.stdout;
}

function listRecentShas(limit: number): string[] {
  const output = runGit(["log", "--no-merges", "--format=%H", "-n", String(limit)]);
  return output.split("\n").map((s) => s.trim()).filter(Boolean);
}

function getFirstParent(sha: string): string {
  return runGit(["rev-parse", `${sha}^1`]).trim();
}

function summarizeImpact(result: ImpactResult) {
  return {
    status: result.analysisStatus,
    fallbackRequired: result.fallbackRequired,
    fallbackReasons: result.fallbackReasons,
    changedFiles: result.changedFiles.length,
    affectedSourceFiles: result.affectedSourceFiles.length,
    affectedAssets: result.affectedAssets.length,
    affectedTests: result.affectedTests.length,
    affectedEntryPoints: result.affectedEntryPoints.length,
    affectedScripts: result.affectedScripts.length,
    riskSignalReasons: result.riskSignals.map((s) => s.reason),
    criticalRiskCount: result.riskSignals.filter((s) => s.level === "critical").length,
    alwaysRunTests: result.affectedTests.filter((t) => t.reasons.includes("ALWAYS_RUN_POLICY")).map((t) => t.path),
    durationMs: result.performance.durationMs,
  };
}

async function main() {
  if (!existsSync(resolve(repoPath, "package.json"))) {
    throw new Error(`Expected repo root with package.json at ${repoPath}`);
  }

  const shas = listRecentShas(SAMPLE_SIZE);
  console.log(`Sampling ${shas.length} recent non-merge commits...`);

  const graphResult = await buildDependencyGraph({
    repoPath,
    excludeDirs: ["diffci", "node_modules", ".next", "dist", "build"],
  });

  const analyzer = new ImpactAnalyzer();
  const samples: Array<{ sha: string; baseSha: string; subject: string; impact: ImpactResult; summary: ReturnType<typeof summarizeImpact> }> = [];

  for (const sha of shas) {
    const baseSha = getFirstParent(sha);
    const subject = runGit(["log", "-1", "--format=%s", sha]).trim();
    const gitResult = await analyzeGitDelta({ baseSha, headSha: sha, repoPath });
    if (!gitResult.success) {
      console.warn(`Skipping ${sha.slice(0, 7)}: ${gitResult.error}`);
      continue;
    }
    const impact = analyzer.analyze(gitResult.delta, graphResult, graphResult.profile);
    samples.push({ sha, baseSha, subject, impact, summary: summarizeImpact(impact) });
    console.log(`Analyzed ${sha.slice(0, 7)}: ${impact.analysisStatus} (${impact.changedFiles.length} changed, ${impact.fallbackRequired ? "FALLBACK" : "selective"})`);
  }

  const aggregate = {
    commitsSampled: samples.length,
    fallbackCommits: samples.filter((s) => s.impact.fallbackRequired).length,
    safeCommits: samples.filter((s) => !s.impact.fallbackRequired).length,
    totalChangedFiles: samples.reduce((acc, s) => acc + s.impact.changedFiles.length, 0),
    totalAffectedTests: samples.reduce((acc, s) => acc + s.impact.affectedTests.length, 0),
    totalAffectedEntryPoints: samples.reduce((acc, s) => acc + s.impact.affectedEntryPoints.length, 0),
    uniqueRiskReasons: Array.from(new Set(samples.flatMap((s) => s.impact.riskSignals.map((r) => r.reason)))).sort(),
  };

  const report = {
    sampledAt: new Date().toISOString(),
    profile: {
      graphConfidence: graphResult.confidence,
      graphStats: graphResult.integrity.stats,
    },
    aggregate,
    samples: samples.map((s) => ({ sha: s.sha, baseSha: s.baseSha, subject: s.subject, summary: s.summary })),
    details: samples.map((s) => ({ sha: s.sha, impact: s.impact })),
  };

  const outPath = resolve(repoPath, "diffci", "impact-audit.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote impact audit report to ${outPath}`);

  console.log("\nAggregate summary:");
  console.log(JSON.stringify(aggregate, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
