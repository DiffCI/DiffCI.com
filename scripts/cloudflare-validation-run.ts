/**
 * Runs INSIDE a Cloudflare Container (via the Sandbox SDK) as the actual "isolated execution
 * environment" for the Stage 0 cloud validation step. See
 * diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md for why this has to be a
 * Container rather than a plain Worker/Workflow (no filesystem/subprocess capability there).
 *
 * Deliberately does NOT reimplement anything: calls the exact same runRepoBenchmark() the local CLI
 * (src/research/cli/run-stage0.ts) uses, against a LocalEvidenceStore rooted in the container's own
 * (persistent-for-the-life-of-the-container) filesystem. The controlling Worker invokes this script
 * twice against the same container session without wiping the workspace in between - since
 * runRepoBenchmark's resumability check (src/research/benchmark/runner.ts) already skips any
 * logicalDeltaKey already present in the store, the second invocation proves resumability using
 * exactly the code path already covered by tests/research/resumability.test.ts, not a special case.
 *
 * Usage: npx tsx scripts/cloudflare-validation-run.ts --owner <owner> --name <name> --commits <n>
 *        --workspace <path> [--out <summaryPath>]
 */
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { runRepoBenchmark } from "../src/research/benchmark/runner.js";
import { buildRepoResult, buildStage0Report } from "../src/research/benchmark/aggregator.js";
import { LocalEvidenceStore } from "../src/research/store/evidence.js";
import { DIFFCI_VERSION, SCHEMA_VERSION } from "../src/research/config/stage0.js";
import type { ResearchRepository } from "../src/research/types.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner;
  const name = args.name;
  // Real finding, larger-study run 2026-08-20: this defaulted to "typescript" unconditionally
  // regardless of the actual repository, which made every non-JS/TS repo (serde, junit5, fastapi, ...)
  // report a misleading "no tsconfig.json found" exclusion reason instead of the correct "does not yet
  // support <language>" one, and meant the broadened exclusion fix for non-JS/TS repos had never
  // actually been exercised live through this script - only in local unit tests. Defaults to
  // "typescript" only when omitted, for backward compatibility with earlier single-repo ad-hoc calls.
  const primaryLanguage = args.language ?? "typescript";
  const maxCommits = Number.parseInt(args.commits ?? "3", 10);
  const workspace = resolve(args.workspace ?? "/workspace");
  const outPath = resolve(args.out ?? `${workspace}/summary.json`);

  if (!owner || !name) {
    console.error("Usage: --owner <owner> --name <name> [--language <lang>] [--commits <n>] [--workspace <path>] [--out <path>]");
    process.exit(1);
  }

  mkdirSync(workspace, { recursive: true });
  const repoCacheDir = `${workspace}/repos`;
  const graphCacheDir = `${workspace}/cache/graphs`;
  const evidenceDir = `${workspace}/evidence`;
  mkdirSync(repoCacheDir, { recursive: true });
  mkdirSync(graphCacheDir, { recursive: true });

  const repo: ResearchRepository = { owner, name, primaryLanguage, framework: "unknown", sizeClass: "small" };
  const store = new LocalEvidenceStore(evidenceDir);

  const config = {
    experimentId: `cloudflare-validation-${owner}-${name}`,
    diffciVersion: DIFFCI_VERSION,
    schemaVersion: SCHEMA_VERSION,
    repoCacheDir,
    cacheDir: graphCacheDir,
    cloneDepth: 300,
    maxCommitsPerRepository: maxCommits,
    recentCommitWindow: Math.max(maxCommits * 4, 50),
    excludeMergeCommits: true,
    excludeBotCommits: true,
    graphTimeouts: { smallMs: 60_000, mediumMs: 180_000, largeMs: 300_000 },
  };

  const startedAt = Date.now();
  const bench = await runRepoBenchmark({ repo, store, config, dryRun: false });
  const durationMs = Date.now() - startedAt;

  const repoResult = buildRepoResult(bench);
  const report = buildStage0Report([repoResult], {
    experimentId: config.experimentId,
    diffciVersion: config.diffciVersion,
    schemaVersion: config.schemaVersion,
  });

  const summary = {
    owner,
    name,
    durationMs,
    commitsSampled: bench.records.length + (bench.errors?.length ?? 0),
    recordsAnalyzed: bench.records.length,
    resumedFromExisting: bench.resumedFromExisting,
    errors: bench.errors,
    metadata: bench.metadata,
    records: bench.records,
    repoResultSummary: {
      commitsAnalyzed: repoResult.commitsAnalyzed,
      fallbackRate: repoResult.fallbackRate,
      medianTaskReduction: repoResult.medianTaskReduction,
      diffciIncrementalAdvantage: repoResult.diffciIncrementalAdvantage,
    },
    stage0SummaryExcerpt: {
      testsTotalAcrossDeltas: report.summary.testsTotalAcrossDeltas,
      testsSelectedByPathAcrossDeltas: report.summary.testsSelectedByPathAcrossDeltas,
      testsSelectedByDiffciAcrossDeltas: report.summary.testsSelectedByDiffciAcrossDeltas,
      medianTestReductionByDiffci: report.summary.medianTestReductionByDiffci,
      diffciIncrementalTestAdvantage: report.summary.diffciIncrementalTestAdvantage,
      duplicateAnalyses: report.summary.duplicateAnalyses,
    },
  };

  const { writeFileSync } = await import("node:fs");
  writeFileSync(outPath, JSON.stringify(summary, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, outPath, recordsAnalyzed: summary.recordsAnalyzed, resumedFromExisting: summary.resumedFromExisting, durationMs }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
