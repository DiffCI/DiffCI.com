/**
 * Stage 1A forensic diagnostic tool (2026-08-21). Given a repository (already cloned by the same
 * container-prep step the Stage 0 pipeline uses) and a SPECIFIC list of {baseSha, headSha} pairs, runs
 * the real DiffCI analysis pipeline directly (the same runDiffCIAnalysis() the benchmark runner calls)
 * and captures FULL graph-construction diagnostics that the Stage 0 BenchmarkRecord schema discards:
 * unresolved import specifiers with their reasons, integrity-check findings, node/edge counts, and
 * whether TS project references were used. This is read/analysis-only - it does not touch Stage 0
 * evidence, does not sample commits (explicit targets only), and does not run against the deterministic
 * corpus sampler.
 *
 * Usage: npx tsx scripts/cloudflare-forensic-graph.ts --owner <o> --name <n> --workspace <path>
 *        --batch-file <path-to-json-array-of-{baseSha,headSha}> [--out <path>]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { runDiffCIAnalysis } from "../src/research/diffci/adapter.js";
import { buildGenericTaskRegistry } from "../src/research/baseline/registry.js";
import { parseRepositoryWorkflows } from "../src/research/baseline/workflow-parser.js";
import { analyzeRepository } from "../src/repo/analyzer.js";
import type { RepositoryProfile } from "../src/repo/types.js";
import type { CommitDelta } from "../src/research/types.js";

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
  const workspace = resolve(args.workspace ?? "/workspace");
  const batchFile = resolve(args["batch-file"] ?? "");
  const outPath = resolve(args.out ?? `${workspace}/forensic-result.json`);

  if (!owner || !name || !batchFile || !existsSync(batchFile)) {
    console.error("Usage: --owner <owner> --name <name> --batch-file <path> --workspace <path> [--out <path>]");
    process.exit(1);
  }

  const batch = JSON.parse(readFileSync(batchFile, "utf8")) as { baseSha: string; headSha: string }[];
  const repoPath = `${workspace}/repos/${owner}--${name}`;

  const results: unknown[] = [];
  const errors: string[] = [];

  // One repository-level profile scan for tsconfig/workspace/root context, reused for every delta in
  // this batch (this doesn't change per-commit the way graph resolution does within a single sampled
  // range, and re-scanning per-delta would be redundant cost) and reported in the output for context.
  let profile: RepositoryProfile;
  let repoProfileSummary: unknown;
  try {
    profile = analyzeRepository({ repoPath, excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"] });
    repoProfileSummary = {
      packageManager: profile.packageManager,
      sourceRoots: profile.sourceRoots,
      testFileCount: profile.testFilePaths.length,
      workflowCount: profile.workflows.length,
      configFileCount: profile.configFiles.length,
    };
  } catch (error: unknown) {
    writeFileSync(resolve(args.out ?? `${workspace}/forensic-result.json`), JSON.stringify({ owner, name, error: `repo-profile-failed: ${error instanceof Error ? error.message : String(error)}` }), "utf8");
    console.error(JSON.stringify({ ok: false, error: "repo-profile-failed" }));
    process.exit(1);
  }

  for (const commit of batch) {
    try {
      const gitResult = await analyzeGitDelta({ repoPath, baseSha: commit.baseSha, headSha: commit.headSha });
      if (!gitResult.success) {
        errors.push(`${commit.headSha}: git-delta-failed: ${gitResult.error}`);
        continue;
      }

      const identity: CommitDelta = {
        repository: `${owner}/${name}`,
        baseSha: commit.baseSha,
        headSha: commit.headSha,
        logicalDeltaKey: `${owner}/${name}:${commit.baseSha}:${commit.headSha}:forensic:stage1a`,
        experimentId: "stage1a-forensic",
        diffCiVersion: "forensic",
        schemaVersion: "stage1a-forensic-1",
        category: "unknown",
        gitDelta: gitResult.delta,
      };

      const parsedWorkflows = parseRepositoryWorkflows(profile, repoPath);
      const taskRegistry = buildGenericTaskRegistry(profile, "typescript", parsedWorkflows);

      const analysis = await runDiffCIAnalysis({
        repoPath,
        commitDelta: identity,
        taskRegistry,
        excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"],
        timeoutMs: 180_000,
      });

      const gr = analysis.graphResult as any;
      results.push({
        baseSha: commit.baseSha,
        headSha: commit.headSha,
        changedFiles: gitResult.delta.files.map((f) => f.path),
        // Stage 1B (2026-08-21): report BOTH the raw, delta-independent graph confidence AND the
        // per-delta-refined effective one side by side - refineConfidenceForDelta() (graph.ts) can
        // narrow UNSAFE to COMPLETE/PARTIAL for a specific delta even when the underlying graph's own
        // raw confidence is unchanged; reading only gr.confidence here would have silently hidden the
        // fix's actual effect (a real bug this tool had until this fix - see the coverage-validation
        // report for the full story).
        graphConfidenceRaw: gr.confidence,
        graphConfidenceEffective: analysis.classification.graphConfidence,
        resolvedViaProjectReferences: gr.resolvedViaProjectReferences ?? null,
        counts: gr.counts,
        integrity: { criticalCount: gr.integrity?.criticalCount, warningCount: gr.integrity?.warningCount, findings: (gr.integrity?.findings ?? []).slice(0, 20) },
        // Only the first 30 unresolved entries per delta - enough for real forensic pattern analysis
        // without ballooning output for a delta with hundreds of near-identical unresolved specifiers.
        unresolvedCount: gr.unresolved?.length ?? 0,
        unresolvedSample: (gr.unresolved ?? []).slice(0, 30),
        dynamicUnresolvedCount: (gr.unresolved ?? []).filter((u: any) => u.dynamic).length,
        sourceFileCount: analysis.profile.stats.sourceFiles,
        testFileCount: analysis.profile.stats.testFiles,
        fallback: analysis.classification.fallbackRequired,
        fallbackReasons: analysis.fallbackReasons,
        testsTotal: analysis.profile.testFilePaths.length,
        testsSelectedByDiffci: analysis.plan.selectedTests.length,
        // Full arrays only when the count already looks impossible (selected > total) - the specific
        // forensic case this exists for (Stage 1A Phase 6, pmndrs/valtio). Kept conditional so routine
        // forensic calls against other repos don't balloon output with full test-path arrays.
        ...(analysis.plan.selectedTests.length > analysis.profile.testFilePaths.length
          ? { selectedTestsFull: analysis.plan.selectedTests, allTestFilePathsFull: analysis.profile.testFilePaths }
          : {}),
        timingMs: analysis.timing.totalDiffCiOverheadMs,
      });
    } catch (error: unknown) {
      errors.push(`${commit.headSha}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  mkdirSync(workspace, { recursive: true });
  writeFileSync(outPath, JSON.stringify({ owner, name, repoProfile: repoProfileSummary, results, errors }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, outPath, deltasAnalyzed: results.length, errors: errors.length }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
