/**
 * Stage 1A replay harness (2026-08-21). Reads the self-contained safety-case fixtures under
 * tests/fixtures/stage1a-safety-cases/ (see that directory's README.md for the schema and index) and,
 * by default, just prints them - useful as a stable, queryable reference to the 8 historical-miss
 * forensic findings and the valtio anomaly without needing network access or a live repo clone.
 *
 * With --replay <repoCacheDir>, additionally attempts to re-run the real DiffCI analysis pipeline
 * (the same runDiffCIAnalysis() used everywhere else in this codebase) against each fixture's
 * {repository, baseSha, headSha}, IF that repository is already cloned under repoCacheDir (this script
 * deliberately does not clone repositories itself - see the fixtures README for why external
 * repositories should not become a live, fragile test dependency). This lets a future change to
 * graph.ts/impact.ts be checked against these exact known cases: did testsTotal/testsSelectedByDiffci/
 * graphConfidence change from what Stage 0 recorded? For valtio-impossible-count.json specifically,
 * replay also reports whether testCountInvariantViolation now fires (it should, post-fix).
 *
 * Usage: npx tsx scripts/replay-safety-fixtures.ts [--replay <repoCacheDir>]
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { runDiffCIAnalysis } from "../src/research/diffci/adapter.js";
import { buildGenericTaskRegistry } from "../src/research/baseline/registry.js";
import { parseRepositoryWorkflows } from "../src/research/baseline/workflow-parser.js";
import { analyzeRepository } from "../src/repo/analyzer.js";
import type { CommitDelta } from "../src/research/types.js";

interface SafetyCaseFixture {
  repository: string;
  baseSha: string;
  headSha: string;
  changedFiles: string[];
  stage0Recorded: { fallback: boolean; graphConfidence: string; testsTotal: number; testsSelectedByPath: number; testsSelectedByDiffci: number };
  historicalEvidence: { failingJob: string | null; failingStep: string | null; errorMessage: string | null; confirmedUnrelatedToCode: boolean | null };
  classification: string;
  notes: string;
}

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

const FIXTURES_DIR = resolve(import.meta.dirname, "../tests/fixtures/stage1a-safety-cases");

function loadFixtures(): { name: string; fixture: SafetyCaseFixture }[] {
  return readdirSync(FIXTURES_DIR)
    .filter((f) => f.endsWith(".json"))
    .map((name) => ({ name, fixture: JSON.parse(readFileSync(resolve(FIXTURES_DIR, name), "utf8")) as SafetyCaseFixture }));
}

async function replayOne(repoCacheDir: string, name: string, fixture: SafetyCaseFixture): Promise<void> {
  const [owner, repoName] = fixture.repository.split("/");
  const repoPath = resolve(repoCacheDir, `${owner}--${repoName}`);
  if (!existsSync(repoPath)) {
    console.log(`  [${name}] SKIPPED - ${repoPath} not cloned locally`);
    return;
  }
  try {
    const gitResult = await analyzeGitDelta({ repoPath, baseSha: fixture.baseSha, headSha: fixture.headSha });
    if (!gitResult.success) {
      console.log(`  [${name}] git-delta-failed: ${gitResult.error}`);
      return;
    }
    const identity: CommitDelta = {
      repository: fixture.repository, baseSha: fixture.baseSha, headSha: fixture.headSha,
      logicalDeltaKey: `${fixture.repository}:${fixture.baseSha}:${fixture.headSha}:replay:stage1a`,
      experimentId: "stage1a-replay", diffCiVersion: "replay", schemaVersion: "stage1a-replay-1",
      category: "unknown", gitDelta: gitResult.delta,
    };
    const profile = analyzeRepository({ repoPath, excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"] });
    const parsedWorkflows = parseRepositoryWorkflows(profile, repoPath);
    const taskRegistry = buildGenericTaskRegistry(profile, "typescript", parsedWorkflows);
    const analysis = await runDiffCIAnalysis({ repoPath, commitDelta: identity, taskRegistry, timeoutMs: 180_000 });

    const testsTotal = analysis.profile.testFilePaths.length;
    const testsSelectedByDiffci = analysis.plan.selectedTests.length;
    const invariantViolated = testsSelectedByDiffci > testsTotal;

    console.log(`  [${name}] replayed:`);
    console.log(`    graphConfidence: ${analysis.classification.graphConfidence} (recorded: ${fixture.stage0Recorded.graphConfidence})`);
    console.log(`    testsTotal: ${testsTotal} (recorded: ${fixture.stage0Recorded.testsTotal})`);
    console.log(`    testsSelectedByDiffci: ${testsSelectedByDiffci} (recorded: ${fixture.stage0Recorded.testsSelectedByDiffci})`);
    if (name === "valtio-impossible-count.json") {
      console.log(`    testCountInvariantViolation would now fire: ${invariantViolated} (expected: true, the guard added in Phase 6 flags it without clamping)`);
    } else if (invariantViolated) {
      console.log(`    ⚠ UNEXPECTED: this fixture now also shows an impossible count - investigate`);
    }
  } catch (error: unknown) {
    console.log(`  [${name}] replay-error: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const fixtures = loadFixtures();
  console.log(`Loaded ${fixtures.length} Stage 1A safety-case fixtures from ${FIXTURES_DIR}\n`);
  for (const { name, fixture } of fixtures) {
    console.log(`${name}: ${fixture.repository} @ ${fixture.headSha.slice(0, 10)} - ${fixture.classification}`);
    console.log(`  ${fixture.notes}`);
  }
  if (args.replay) {
    console.log(`\n--replay set: attempting live re-analysis against ${args.replay}\n`);
    for (const { name, fixture } of fixtures) {
      await replayOne(args.replay, name, fixture);
    }
  } else {
    console.log(`\n(pass --replay <repoCacheDir> to re-run real analysis against already-cloned repositories)`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
