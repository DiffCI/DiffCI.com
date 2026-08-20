/**
 * Stage 0 REAL 2-repository pilot.
 *
 * Runs the actual (non-dry-run) Stage 0 research pipeline against a small,
 * hand-selected pair of external open-source repositories. This is
 * deliberately NOT the 20-repository Stage 0 experiment — it exists to prove
 * the end-to-end pipeline (clone -> sample -> profile -> graph -> impact ->
 * plan -> path baseline -> benchmark record -> aggregation -> report) works
 * against real external code before scaling up.
 *
 * Writes all output under .research/output/stage0-pilot/ (kept separate from
 * .research/output/stage0/ so pilot data never mixes with dry-run or future
 * full-experiment records).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { STAGE0_CONFIG } from "../src/research/config/stage0.js";
import type { ResearchRepository } from "../src/research/types.js";
import { LocalEvidenceStore } from "../src/research/store/evidence.js";
import { cloneOrUpdateRepo, runGit } from "../src/research/repository/collector.js";
import { parseRepositoryWorkflows } from "../src/research/baseline/workflow-parser.js";
import { buildGenericTaskRegistry } from "../src/research/baseline/registry.js";
import { runRepoBenchmark } from "../src/research/benchmark/runner.js";
import { buildRepoResult, buildStage0Report } from "../src/research/benchmark/aggregator.js";
import { writeStage0Report } from "../src/research/report/stage0-report.js";
import { runDiffCIAnalysis } from "../src/research/diffci/adapter.js";

const PILOT_OUTPUT_DIR = resolve(import.meta.dirname, "../.research/output/stage0-pilot");
// Dedicated (not shared) graph cache dir so the pilot's cold-vs-warm measurement starts
// from a guaranteed-cold state, independent of any prior session's cached graphs for
// these repos under the shared .research/cache/graphs directory.
const PILOT_CACHE_DIR = resolve(import.meta.dirname, "../.research/cache/graphs-pilot");
const PILOT_REPO_CACHE_DIR = STAGE0_CONFIG.repoCacheDir; // shared repo clone cache: safe to reuse (read-mostly, keyed per-repo)
const COMMITS_PER_REPO = 8;
const RECENT_COMMIT_WINDOW = 200;

interface PilotRepoSpec extends ResearchRepository {
  reasonSelected: string;
}

const PILOT_CORPUS: PilotRepoSpec[] = [
  {
    owner: "pmndrs",
    name: "zustand",
    primaryLanguage: "typescript",
    framework: "react-store",
    sizeClass: "small",
    reasonSelected:
      "Small, single-package TypeScript library (48 tracked source files). Popular (~50k GitHub stars), " +
      "actively maintained with frequent non-merge commits, has GitHub Actions workflows (test.yml, " +
      "test-multiple-builds.yml, test-multiple-versions.yml, test-old-typescript.yml, docs.yml, publish.yml), " +
      "vitest-based test suite, and a flat, low-complexity dependency graph. Chosen as the small/simple anchor " +
      "of the pair, in the language DiffCI's graph engine already supports.",
  },
  {
    owner: "honojs",
    name: "hono",
    primaryLanguage: "typescript",
    framework: "web-framework",
    sizeClass: "medium",
    reasonSelected:
      "Medium-sized TypeScript web framework (360 tracked source files) with a structurally diverse, " +
      "monorepo-like source layout inside a single package: src/adapter/ (10+ runtime adapters: node, bun, " +
      "deno, aws-lambda, cloudflare-workers, ...), src/middleware/, src/preset/, src/router/, src/client/, " +
      "src/jsx/. Actively developed (multiple merged fix/feat commits per day), has GitHub Actions (ci.yml, " +
      "autofix.yml, release.yml, cr.yml), and a real test suite. Chosen to meaningfully differ from zustand in " +
      "size and dependency-graph complexity while staying in DiffCI's supported language.",
  },
];

interface CommitSamplingDiagnostics {
  candidateCommits: number;
  eligibleCommits: number;
  sampledCommits: number;
  excludedCommits: number;
  exclusionReasons: Record<string, number>;
}

const BOT_PREFIXES = ["dependabot", "renovate", "github-actions", "renovate-bot", "imgbot"];

function diagnoseCommitSampling(localPath: string, defaultBranch: string, window: number, maxCommits: number): CommitSamplingDiagnostics {
  // Mirrors sampleCommits' own filtering logic (repository/sampler.ts) purely for
  // diagnostic reporting; the actual sampling used for analysis always goes through
  // the real sampleCommits() function, never this duplicate.
  const allRaw = runGit(["log", "--pretty=format:%H%x00%P%x00%s%x00%aI%n", "-n", String(window), defaultBranch || "HEAD"], localPath);
  const allLines = allRaw.split("\n").filter(Boolean);
  const candidateCommits = allLines.length;

  const noMergesRaw = runGit(["log", "--no-merges", "--pretty=format:%H%x00%P%x00%s%x00%aI%n", "-n", String(window), defaultBranch || "HEAD"], localPath);
  const noMergeLines = noMergesRaw.split("\n").filter(Boolean);
  const mergeExcluded = candidateCommits - noMergeLines.length;

  const exclusionReasons: Record<string, number> = {};
  if (mergeExcluded > 0) exclusionReasons["merge commit"] = mergeExcluded;

  let eligibleCommits = 0;
  for (const line of noMergeLines) {
    const [, parents, message] = line.split("\x00");
    if (!parents || parents.split(" ")[0] === "") continue; // no parent (root commit)
    const lower = (message || "").toLowerCase();
    if (BOT_PREFIXES.some((p) => lower.includes(p))) {
      exclusionReasons["bot commit"] = (exclusionReasons["bot commit"] ?? 0) + 1;
      continue;
    }
    if (/\brevert\b/i.test(message || "")) {
      exclusionReasons["revert commit"] = (exclusionReasons["revert commit"] ?? 0) + 1;
      continue;
    }
    eligibleCommits++;
  }

  const sampledCommits = Math.min(eligibleCommits, maxCommits);
  const excludedCommits = candidateCommits - sampledCommits;
  return { candidateCommits, eligibleCommits, sampledCommits, excludedCommits, exclusionReasons };
}

async function main() {
  mkdirSync(PILOT_OUTPUT_DIR, { recursive: true });
  const store = new LocalEvidenceStore(PILOT_OUTPUT_DIR);

  const pilotReport: any = {
    label: "STAGE 0 PILOT — NOT FINAL STAGE 0 RESULT",
    generatedAt: new Date().toISOString(),
    diffciVersion: STAGE0_CONFIG.diffciVersion,
    schemaVersion: STAGE0_CONFIG.schemaVersion,
    pilotConfig: { commitsPerRepo: COMMITS_PER_REPO, recentCommitWindow: RECENT_COMMIT_WINDOW },
    repositories: [] as any[],
    reliability: { analysisAttempts: 0, successfulAnalyses: 0, repositoryFailures: 0, gitFailures: 0, graphFailures: 0, timeouts: 0, memoryFailures: 0, cacheFailures: 0, malformedRecords: 0 },
    coldWarm: [] as any[],
  };

  const repoResults: import("../src/research/types.js").RepositoryResult[] = [];
  const config = {
    experimentId: STAGE0_CONFIG.experimentId,
    diffciVersion: STAGE0_CONFIG.diffciVersion,
    schemaVersion: STAGE0_CONFIG.schemaVersion,
    repoCacheDir: PILOT_REPO_CACHE_DIR,
    cacheDir: PILOT_CACHE_DIR,
    cloneDepth: STAGE0_CONFIG.cloneDepth,
    maxCommitsPerRepository: COMMITS_PER_REPO,
    recentCommitWindow: RECENT_COMMIT_WINDOW,
    excludeMergeCommits: STAGE0_CONFIG.excludeMergeCommits,
    excludeBotCommits: STAGE0_CONFIG.excludeBotCommits,
    graphTimeouts: STAGE0_CONFIG.graphTimeouts,
    dryRun: false,
  };

  for (const repo of PILOT_CORPUS) {
    console.error(`\n=== ${repo.owner}/${repo.name} ===`);
    console.error(`Reason selected: ${repo.reasonSelected}`);

    const cloneStart = performance.now();
    const metadata = cloneOrUpdateRepo(repo, PILOT_REPO_CACHE_DIR, STAGE0_CONFIG.cloneDepth);
    const cloneDurationMs = performance.now() - cloneStart;
    console.error(`Clone/fetch: ${cloneDurationMs.toFixed(0)}ms, exclusionReason=${metadata.exclusionReason ?? "none"}`);

    if (metadata.exclusionReason) {
      pilotReport.reliability.repositoryFailures++;
      pilotReport.repositories.push({ repository: `${repo.owner}/${repo.name}`, reasonSelected: repo.reasonSelected, metadata, cloneDurationMs, excluded: true });
      continue;
    }

    const sampling = diagnoseCommitSampling(metadata.localPath, metadata.defaultBranch, RECENT_COMMIT_WINDOW, COMMITS_PER_REPO);
    console.error(`Commit sampling: candidates=${sampling.candidateCommits} eligible=${sampling.eligibleCommits} sampled=${sampling.sampledCommits} excluded=${sampling.excludedCommits}`);
    console.error(`Exclusion reasons: ${JSON.stringify(sampling.exclusionReasons)}`);

    pilotReport.reliability.analysisAttempts++;
    let bench;
    try {
      bench = await runRepoBenchmark({ repo, store, config, dryRun: false });
    } catch (error: unknown) {
      pilotReport.reliability.repositoryFailures++;
      console.error(`FATAL: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (bench.records.length > 0) pilotReport.reliability.successfulAnalyses++;
    for (const err of bench.errors) {
      if (/git/i.test(err)) pilotReport.reliability.gitFailures++;
      else if (/graph|construction/i.test(err)) pilotReport.reliability.graphFailures++;
      else if (/timeout|exceeded/i.test(err)) pilotReport.reliability.timeouts++;
      else pilotReport.reliability.malformedRecords++;
    }

    // Uniqueness check: every record's logicalDeltaKey must be unique within this repo.
    const keys = bench.records.map((r) => r.identity.logicalDeltaKey);
    const uniqueKeys = new Set(keys);
    if (uniqueKeys.size !== keys.length) {
      console.error(`WARNING: duplicate logicalDeltaKey detected (${keys.length} records, ${uniqueKeys.size} unique)`);
    }

    const repoResult = buildRepoResult(bench);
    repoResults.push(repoResult);

    // Cold/warm cache-correctness check on the first successfully analyzed commit.
    let coldWarm: any = { repository: `${repo.owner}/${repo.name}`, checked: false };
    if (bench.records.length > 0) {
      const firstRecord = bench.records[0]!;
      const { analyzeRepository } = await import("../src/repo/analyzer.js");
      const profileForWarmCheck = await analyzeRepository({ repoPath: metadata.localPath, excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"] });
      const taskRegistry = buildGenericTaskRegistry(
        profileForWarmCheck,
        repo.primaryLanguage,
        parseRepositoryWorkflows(profileForWarmCheck, metadata.localPath),
      );
      try {
        const warmIdentity = { ...firstRecord.identity, gitDelta: { ...firstRecord.identity.gitDelta } };
        const warmAnalysis = await runDiffCIAnalysis({
          repoPath: metadata.localPath,
          commitDelta: warmIdentity,
          taskRegistry,
          cacheDir: `${PILOT_CACHE_DIR}/${repo.owner}-${repo.name}`,
          excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"],
        });
        const coldTaskShape = bench.records[0]!.diffciTasks;
        const warmTaskShape = warmAnalysis.plan.tasks.filter((t) => t.status !== "SKIP_CANDIDATE").length;
        const coldIds = new Set(bench.records[0]!.identity.gitDelta.files.map((f) => f.path));
        const warmIds = new Set(warmAnalysis.identity.gitDelta.files.map((f) => f.path));
        const filesEqual = coldIds.size === warmIds.size && [...coldIds].every((f) => warmIds.has(f));
        const plansEquivalent = coldTaskShape === warmTaskShape && filesEqual;
        coldWarm = {
          repository: `${repo.owner}/${repo.name}`,
          checked: true,
          headSha: firstRecord.identity.headSha,
          coldOverheadMs: firstRecord.timingMs.totalDiffCiOverheadMs,
          coldWasCacheHit: firstRecord.cacheHit,
          warmOverheadMs: warmAnalysis.timing.totalDiffCiOverheadMs,
          warmCacheHit: !warmAnalysis.timing.coldCache,
          coldSelectedTaskCount: coldTaskShape,
          warmSelectedTaskCount: warmTaskShape,
          plansEquivalent,
          serializedGraphSizeBytes: warmAnalysis.cacheMetrics.serializedGraphSizeBytes,
        };
        if (!plansEquivalent) {
          console.error(`CACHE CORRECTNESS FAILURE for ${repo.owner}/${repo.name}: cold plan != warm plan`);
        } else {
          console.error(`Cold/warm equivalence OK: cold=${firstRecord.timingMs.totalDiffCiOverheadMs.toFixed(0)}ms warm=${warmAnalysis.timing.totalDiffCiOverheadMs.toFixed(0)}ms`);
        }
      } catch (error: unknown) {
        pilotReport.reliability.cacheFailures++;
        coldWarm.error = error instanceof Error ? error.message : String(error);
      }
    }
    pilotReport.coldWarm.push(coldWarm);

    pilotReport.repositories.push({
      repository: `${repo.owner}/${repo.name}`,
      reasonSelected: repo.reasonSelected,
      metadata,
      cloneDurationMs,
      commitSampling: sampling,
      commitsAnalyzed: repoResult.commitsAnalyzed,
      fallbackRate: repoResult.fallbackRate,
      medianTaskReduction: repoResult.medianTaskReduction,
      pathBaselineMedianReduction: repoResult.pathBaselineMedianReduction,
      diffciIncrementalAdvantage: repoResult.diffciIncrementalAdvantage,
      errors: bench.errors,
      uniqueLogicalDeltaKeys: uniqueKeys.size,
      records: bench.records,
    });
  }

  const report = buildStage0Report(repoResults, {
    experimentId: STAGE0_CONFIG.experimentId,
    diffciVersion: STAGE0_CONFIG.diffciVersion,
    schemaVersion: STAGE0_CONFIG.schemaVersion,
    measuredSpendUsd: 0,
    budgetGuardTriggered: false,
  });
  writeStage0Report(report, PILOT_OUTPUT_DIR);
  await store.put("reports/pilot-summary.json", report.summary);

  pilotReport.aggregateSummary = report.summary;
  writeFileSync(resolve(PILOT_OUTPUT_DIR, "pilot-report.json"), JSON.stringify(pilotReport, null, 2), "utf8");

  console.error(`\nPilot complete. Output: ${PILOT_OUTPUT_DIR}`);
  console.log(JSON.stringify(report.summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
