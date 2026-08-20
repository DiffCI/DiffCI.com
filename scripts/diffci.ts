import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { buildDependencyGraph } from "../src/repo/graph.js";
import { ImpactAnalyzer } from "../src/repo/impact.js";
import type { ImpactResult } from "../src/repo/impact-types.js";
import { DefaultCIPlanner } from "../src/planner/planner.js";
import { buildDentalPresenceTaskRegistry } from "../src/planner/task-registry.js";
import { explain } from "../src/planner/explain.js";
import { runShadowAnalysis, runGit } from "../src/shadow/runner.js";
import { DiffCiPersistence } from "../src/shadow/persistence.js";

// One level up from scripts/ - this file lives at <repo-root>/scripts/diffci.ts. Was "../.." before
// this repo moved out of DentalPresence.in's diffci/ subfolder (2026-08-21); that resolved to the OLD
// parent monorepo's root, which no longer exists relative to this file at all now that this repo IS the
// root - fixed to analyze this repo's own history/tree, which is what every command below assumes.
const repoPath = resolve(dirname(import.meta.filename), "..");
const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build"];

function parseArgs(argv: string[]) {
  const args = argv.slice(2);
  const result: Record<string, string | boolean | string[]> = { _: [] };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--base") {
      result.base = args[++i];
    } else if (key === "--head") {
      result.head = args[++i];
    } else if (key === "--json") {
      result.json = true;
    } else if (!key.startsWith("-")) {
      if (result.command === undefined) {
        result.command = key;
      } else {
        (result._ as string[]).push(key);
      }
    }
  }
  return result;
}

function toValidationProposal(result: ImpactResult) {
  const selectedCategories: import("../src/repo/impact-types.js").ImpactSelectionCategory[] = [
    ...result.affectedTests.map((t) => ({ path: t.path, category: "GRAPH_SELECTED" as const })),
    ...result.affectedEntryPoints.map((e) => ({ path: e.path, category: "GRAPH_SELECTED" as const })),
  ];
  if (result.fallbackRequired) {
    selectedCategories.push({ path: "*", category: "GLOBAL_SAFETY" as const });
  }
  if (result.affectedTests.some((t) => t.reasons.includes("ALWAYS_RUN_POLICY"))) {
    selectedCategories.push({ path: "*", category: "ALWAYS_RUN" as const });
  }
  return {
    mode: result.fallbackRequired ? ("FULL" as const) : ("SELECTIVE" as const),
    selectedTests: result.affectedTests.map((t) => t.path),
    selectedCategories,
    alwaysRunChecks: result.affectedTests.filter((t) => t.reasons.includes("ALWAYS_RUN_POLICY")).map((t) => t.path),
    affectedEntryPoints: result.affectedEntryPoints.map((e) => e.path),
    reasons: result.evidence,
    fallbackReasons: result.fallbackReasons,
  };
}

async function runImpact(args: Record<string, string | boolean | string[]>) {
  const base = args.base as string | undefined;
  const head = args.head as string | undefined;
  const json = args.json === true;
  if (!base || !head) {
    console.error("Usage: diffci impact --base <sha> --head <sha> [--json]");
    process.exit(1);
  }

  if (!existsSync(resolve(repoPath, "package.json"))) {
    throw new Error(`Expected repo root with package.json at ${repoPath}`);
  }

  const gitResult = await analyzeGitDelta({ baseSha: base, headSha: head, repoPath });
  if (!gitResult.success) {
    console.error(gitResult.error);
    process.exit(1);
  }

  const graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });

  const analyzer = new ImpactAnalyzer();
  const result = analyzer.analyze(gitResult.delta, graphResult, graphResult.profile);
  const proposal = toValidationProposal(result);

  if (json) {
    console.log(JSON.stringify({ impact: result, proposal }, null, 2));
    return;
  }

  console.log(`Analysis status: ${result.analysisStatus}`);
  console.log(`Fallback required: ${result.fallbackRequired}`);
  if (result.fallbackReasons.length > 0) {
    console.log("Fallback reasons:");
    for (const reason of result.fallbackReasons) {
      console.log(`  - ${reason}`);
    }
  }
  console.log(`Affected source files: ${result.affectedSourceFiles.length}`);
  for (const path of result.affectedSourceFiles) console.log(`  ${path}`);
  console.log(`Affected tests: ${result.affectedTests.length}`);
  for (const test of result.affectedTests) console.log(`  ${test.path} (${test.reasons.join(", ")})`);
  console.log(`Affected entry points: ${result.affectedEntryPoints.length}`);
  for (const ep of result.affectedEntryPoints) console.log(`  ${ep.path} (${ep.kind})`);
  console.log(`Risk signals: ${result.riskSignals.length}`);
  for (const signal of result.riskSignals) console.log(`  [${signal.level}] ${signal.reason}: ${signal.message}`);
}

async function runPlan(args: Record<string, string | boolean | string[]>) {
  const base = args.base as string | undefined;
  const head = args.head as string | undefined;
  const json = args.json === true;
  if (!base || !head) {
    console.error("Usage: diffci plan --base <sha> --head <sha> [--json]");
    process.exit(1);
  }

  if (!existsSync(resolve(repoPath, "package.json"))) {
    throw new Error(`Expected repo root with package.json at ${repoPath}`);
  }

  const gitResult = await analyzeGitDelta({ baseSha: base, headSha: head, repoPath });
  if (!gitResult.success) {
    console.error(gitResult.error);
    process.exit(1);
  }

  const graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });
  const impact = new ImpactAnalyzer().analyze(gitResult.delta, graphResult, graphResult.profile);
  const registry = buildDentalPresenceTaskRegistry();
  const planner = new DefaultCIPlanner(registry);
  const plan = planner.plan({ delta: gitResult.delta, impact, profile: graphResult.profile });

  if (json) {
    console.log(JSON.stringify({ plan, impact }, null, 2));
    return;
  }

  console.log(`Plan mode: ${plan.safety.fallbackRequired ? "FULL_FALLBACK" : "SELECTIVE"}`);
  console.log(`Selected tests: ${plan.selectedTests.length}`);
  for (const t of plan.selectedTests) console.log(`  ${t}`);
  console.log(`Tasks to run: ${plan.tasks.filter((t) => t.status !== "SKIP_CANDIDATE").length}/${plan.tasks.length}`);
  for (const task of plan.tasks) {
    const marker = task.status === "SKIP_CANDIDATE" ? "SKIP" : "RUN";
    console.log(`  [${marker}] ${task.id} (${task.status})${task.reason ? ` - ${task.reason}` : ""}`);
    if (task.commandSpec) {
      console.log(`       ${task.commandSpec.executable} ${task.commandSpec.args.join(" ")}`);
    }
  }
  console.log(`Always-run tasks: ${plan.alwaysRunTasks.length}`);
  for (const id of plan.alwaysRunTasks) console.log(`  ${id}`);
  if (plan.fallbackReasons.length > 0) {
    console.log("Fallback reasons:");
    for (const reason of plan.fallbackReasons) {
      console.log(`  - ${reason}`);
    }
  }
}

async function runExplain(args: Record<string, string | boolean | string[]>) {
  const positional = args._ as string[];
  const target = positional[0];
  if (!target) {
    console.error("Usage: diffci explain --base <sha> --head <sha> <target> [--json]");
    process.exit(1);
  }
  const base = args.base as string | undefined;
  const head = args.head as string | undefined;
  const json = args.json === true;
  if (!base || !head) {
    console.error("Usage: diffci explain --base <sha> --head <sha> <target> [--json]");
    process.exit(1);
  }

  const gitResult = await analyzeGitDelta({ baseSha: base, headSha: head, repoPath });
  if (!gitResult.success) {
    console.error(gitResult.error);
    process.exit(1);
  }

  const graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });
  const impact = new ImpactAnalyzer().analyze(gitResult.delta, graphResult, graphResult.profile);
  const registry = buildDentalPresenceTaskRegistry();
  const planner = new DefaultCIPlanner(registry);
  const plan = planner.plan({ delta: gitResult.delta, impact, profile: graphResult.profile });

  const explanation = explain(target, plan, impact);
  if (json) {
    console.log(JSON.stringify({ target, explanation }, null, 2));
    return;
  }
  console.log(`Target: ${target}`);
  console.log(`Verdict: ${explanation.verdict}`);
  if (explanation.reason) console.log(`Reason: ${explanation.reason}`);
  console.log("Evidence:");
  for (const item of explanation.evidence) {
    console.log(`  - ${item.reason}: ${item.message}${item.affectedFile ? ` (${item.affectedFile})` : ""}`);
  }
}

async function runBenchmark(args: Record<string, string | boolean | string[]>) {
  const json = args.json === true;
  const persistence = new DiffCiPersistence({ directory: resolve(repoPath, ".diffci/shadow") });
  await persistence.init();

  const commitLines = runGit(["rev-list", "--no-merges", "--max-count", "50", "HEAD"], repoPath)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  if (commitLines.length === 0) {
    console.error("No commits found in repository.");
    process.exit(1);
  }

  const runs = [];
  for (let i = 0; i < commitLines.length; i++) {
    const headSha = commitLines[i]!;
    let baseSha: string;
    try {
      baseSha = runGit(["rev-parse", `${headSha}^`], repoPath).trim();
    } catch {
      continue;
    }

    process.stderr.write(`Benchmarking commit ${i + 1}/${commitLines.length}: ${headSha.substring(0, 12)}...`);
    try {
      const record = await runShadowAnalysis({
        repoPath,
        baseSha,
        headSha,
        excludeDirs: EXCLUDE_DIRS,
        cacheDir: resolve(repoPath, ".diffci/cache/graphs"),
      });
      persistence.recordShadow(record);
      runs.push(record);
      process.stderr.write(" done\n");
    } catch (error: unknown) {
      process.stderr.write(` skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  if (json) {
    console.log(JSON.stringify({ sampleSize: runs.length, runs }, null, 2));
    return;
  }

  console.log(`Completed benchmark runs: ${runs.length}/${commitLines.length}`);
  console.log(`Fallback runs: ${runs.filter((r) => r.plan.safety.fallbackRequired).length}`);
  console.log(`Always-run tasks: ${runs[0]?.plan.alwaysRunTasks.length ?? 0}`);
  console.log(`Shadow records written to: ${resolve(repoPath, ".diffci/shadow/shadow-runs.jsonl")}`);
}

async function main() {
  const args = parseArgs(process.argv);
  const command = args.command as string | undefined;
  switch (command) {
    case "impact":
      await runImpact(args);
      break;
    case "plan":
      await runPlan(args);
      break;
    case "explain":
      await runExplain(args);
      break;
    case "benchmark":
      await runBenchmark(args);
      break;
    default:
      console.error("Unknown command. Usage: diffci impact|plan|explain|benchmark ...");
      process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
