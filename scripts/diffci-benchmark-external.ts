/**
 * One-off benchmark: run DiffCI's real, generic impact-analysis engine (git diff -> dependency graph ->
 * affected-tests) against an EXTERNAL repository, rather than this repo's own tree. Deliberately a
 * separate script from scripts/diffci.ts (whose `repoPath` is pinned to this repo's own history/tree by
 * design - see its own header comment) instead of modifying that shared CLI's global repoPath, which
 * other commands (shadow, plan, explain) also depend on.
 *
 * Only ever reads the target repo's git history and source files (analyzeGitDelta, buildDependencyGraph)
 * - never installs dependencies, never executes the target repo's own code/scripts/tests. Usage:
 *   npx tsx scripts/diffci-benchmark-external.ts --repo <path> --base <sha> --head <sha> [--json]
 */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { buildDependencyGraph } from "../src/repo/graph.js";
import { ImpactAnalyzer } from "../src/repo/impact.js";
import { testFamilyOfPath } from "../src/repo/test-discovery.js";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build", ".git"];

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const result: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") result.repo = args[++i];
    else if (args[i] === "--base") result.base = args[++i];
    else if (args[i] === "--head") result.head = args[++i];
    else if (args[i] === "--json") result.json = true;
    else if (args[i] === "--no-repository-files") result.noRepositoryFiles = true;
  }
  return result;
}

function countRelevantUnresolved(g: Awaited<ReturnType<typeof buildDependencyGraph>>, changed: string[]): number {
  const reach = new Set<string>(changed);
  for (const f of changed) { for (const d of g.graph.transitiveDependenciesOf(f)) reach.add(d); for (const d of g.graph.transitiveDependentsOf(f)) reach.add(d); }
  return g.unresolved.filter((u) => reach.has(u.importer)).length;
}
function bucketUnresolved(g: Awaited<ReturnType<typeof buildDependencyGraph>>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const u of g.unresolved) {
    const s = u.specifier;
    const k = u.dynamic ? "dynamic-import" : s.startsWith(".") || s.startsWith("/") ? (/.(json|yaml|yml|wasm|css|scss|md|txt|node|sh|py|svg|png)$/i.test(s) ? "relative-non-ts-asset" : "relative-missing") : s.startsWith("@/") || s.startsWith("~/") || s.startsWith("#") ? "path-alias" : /^@?[a-z0-9-]+(?:\/[a-z0-9._-]+)?$/i.test(s) ? "package-like" : "other";
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function countByFamily(paths: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of paths) { const k = testFamilyOfPath(p) ?? "untagged"; out[k] = (out[k] ?? 0) + 1; }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  const repoArg = args.repo as string | undefined;
  const base = args.base as string | undefined;
  const head = args.head as string | undefined;
  if (!repoArg || !base || !head) {
    console.error("Usage: diffci-benchmark-external --repo <path> --base <sha> --head <sha> [--json]");
    process.exit(1);
  }
  const repoPath = resolve(repoArg);
  if (!existsSync(resolve(repoPath, "package.json"))) {
    // A result, not a crash: the frozen engine only models package.json-rooted JS/TS repositories.
    console.log(JSON.stringify({ ok: false, error: `no package.json at ${repoPath}`, errorClass: "unsupported-repository-root", base, head }));
    return;
  }

  const tWall = Date.now();
  const gitResult = await analyzeGitDelta({ baseSha: base, headSha: head, repoPath });
  if (!gitResult.success) {
    console.log(JSON.stringify({ ok: false, error: gitResult.error, base, head }));
    return;
  }

  if (gitResult.delta.baseSha === gitResult.delta.headSha) {
    console.log(JSON.stringify({ ok: false, error: "base resolves to head (base==head) - refusing to report a verdict", errorClass: "base-equals-head", base, head }));
    return;
  }
  const tGraph = Date.now();
  const graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });
  const graphBuildWallMs = Date.now() - tGraph;
  // Same canonical inventory every production path uses (analyzeGitDelta -> inventory). --no-repository-files
  // reproduces the 2026-08-23 baseline policy exactly.
  const repositoryFiles = args.noRepositoryFiles ? undefined : gitResult.inventory?.files;
  const result = new ImpactAnalyzer().analyze(gitResult.delta, graphResult, graphResult.profile, { repositoryFiles });

  const totalTestsInGraph = graphResult.graph.nodes.filter((n) => n.isTest).length;

  const summary = {
    ok: true,
    base,
    head,
    changedFiles: gitResult.delta.files.length,
    analysisStatus: result.analysisStatus,
    fallbackRequired: result.fallbackRequired,
    fallbackReasons: result.fallbackReasons,
    affectedSourceFiles: result.affectedSourceFiles.length,
    affectedTests: result.affectedTests.length,
    totalTestsInGraph,
    workReductionPercent: totalTestsInGraph > 0 && !result.fallbackRequired ? Math.max(0, 1 - result.affectedTests.length / totalTestsInGraph) * 100 : null,
    riskSignals: result.riskSignals.length,
    analysisDurationMs: result.performance.durationMs,
    graphBuildMs: graphBuildWallMs,
    totalWallMs: Date.now() - tWall,
    resolvedBaseSha: gitResult.delta.baseSha,
    resolvedHeadSha: gitResult.delta.headSha,
    triggers: { config: gitResult.delta.analysis.configChanged, workflow: gitResult.delta.analysis.workflowChanged, lockfile: gitResult.delta.analysis.lockfileChanged, manifest: gitResult.delta.analysis.dependencyManifestChanged, infrastructure: gitResult.delta.analysis.infrastructureChanged, database: gitResult.delta.analysis.databaseChanged },
    graphConfidence: { raw: graphResult.confidence, effective: result.effectiveGraphConfidence, unresolvedTotal: graphResult.unresolved.length, unresolvedRelevant: countRelevantUnresolved(graphResult, gitResult.delta.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]))), integrityCritical: graphResult.integrity.criticalCount, resolvedViaProjectReferences: graphResult.resolvedViaProjectReferences, unresolvedByCause: bucketUnresolved(graphResult) },
    unknownFileList: result.fallbackReasons.filter((r) => r.startsWith("Unknown changed file: ")).map((r) => r.slice(22)),
    fixtureOwnership: result.evidence.filter((e) => e.reason === "TEST_FIXTURE_OWNER" && !e.affectedFile).map((e) => e.message),
    changedFileCategoriesDetail: result.changedFiles.map((c) => ({ path: c.file.path, category: c.category })).filter((c) => c.category === "unknown" || c.category === "test-fixture" || c.category === "docs").slice(0, 200),
    policy: repositoryFiles ? "correctness-complete" : "baseline",
    // Test universe by family (profile-declared patterns, incl. Vitest/Jest config includes) and what was selected from each.
    totalTestsByFamily: countByFamily(graphResult.graph.nodes.filter((n) => n.isTest).map((n) => n.path)),
    selectedTestsByFamily: countByFamily(result.affectedTests.map((t) => t.path)),
    testRunnerConfigs: (graphResult.profile.testRunnerConfigs ?? []).map((c) => ({ file: c.file, family: c.family ?? null, scripts: c.scripts })),
    fixtureOwnedFiles: result.changedFiles.filter((c) => c.category === "test-fixture").length,
    testsSelectedViaFixtureOwner: result.affectedTests.filter((t) => t.reasons.includes("TEST_FIXTURE_OWNER")).length,
    unknownFiles: result.fallbackReasons.filter((r) => r.startsWith("Unknown changed file")).length,
    changedFileCategories: Object.fromEntries(result.changedFiles.reduce((m, c) => m.set(c.category, (m.get(c.category) ?? 0) + 1), new Map<string, number>())),
  };

  if (args.json) console.log(JSON.stringify(args.json ? { summary, full: result } : summary));
  else console.log(JSON.stringify(summary, null, 2));
}

main().catch((err) => {
  console.error(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err), stack: err instanceof Error ? err.stack : undefined }));
  process.exit(1);
});
