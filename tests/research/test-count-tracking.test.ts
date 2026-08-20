import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runDiffCIAnalysis } from "../../src/research/diffci/adapter.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import { runPathBaseline } from "../../src/planner/path-baseline.js";
import type { CommitDelta } from "../../src/research/types.js";

// Coverage for the testsTotal/testsSelectedByPath/testsSelectedByDiffci wiring added to
// the Stage 0 benchmark runner (src/research/benchmark/runner.ts). Exercises the same
// building blocks the runner uses (analysis.profile.testFilePaths, analysis.plan.selectedTests,
// and the real production per-test PATH baseline) against a real temp git repo, so both the
// discoverTests()/testFilePaths fix and the planner.ts allTestPaths() fix are validated
// working together, end to end.

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-testcount-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'testcount@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Test Count'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "testcount-fixture", version: "1.0.0", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", allowImportingTsExtensions: true, noEmit: true }, include: ["**/*.ts"] }),
  );
  return dir;
}

function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath });
  execSync(`git commit --quiet -m "${message}"`, { cwd: repoPath });
}

function getSha(repoPath: string, ref = "HEAD"): string {
  return execSync(`git rev-parse ${ref}`, { cwd: repoPath, encoding: "utf8" }).trim();
}

function makeCommitDelta(repository: string, baseSha: string, headSha: string): CommitDelta {
  return {
    repository,
    baseSha,
    headSha,
    logicalDeltaKey: `${repository}:${baseSha}:${headSha}:test:test`,
    experimentId: "test",
    diffCiVersion: "test",
    schemaVersion: "test",
    category: "unknown",
    gitDelta: {
      baseSha,
      headSha,
      files: [],
      directories: [],
      summary: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: 0 },
      analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false },
    },
  };
}

describe("test-count tracking (testsTotal / testsSelectedByPath / testsSelectedByDiffci)", () => {
  it("counts real individual test files and correctly narrows selection for a SELECTIVE-mode change", async () => {
    const repoPath = createRepo();
    try {
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src/a.ts"), "export function a(): number { return 1; }\n");
      writeFileSync(join(repoPath, "src/a.test.ts"), "import { a } from './a'; console.assert(a() === 1);\n");
      writeFileSync(join(repoPath, "src/b.ts"), "export function b(): number { return 2; }\n");
      writeFileSync(join(repoPath, "src/b.test.ts"), "import { b } from './b'; console.assert(b() === 2);\n");
      writeFileSync(join(repoPath, "src/c.test.ts"), "console.assert(true);\n");
      commitAll(repoPath, "initial");
      const baseSha = getSha(repoPath);

      writeFileSync(join(repoPath, "src/a.ts"), "export function a(): number { return 100; }\n");
      commitAll(repoPath, "change a");
      const headSha = getSha(repoPath);

      const taskRegistry = createTaskRegistry([{ id: "test:unit", command: "npm test", category: "test", inputPatterns: ["src/**/*"] }]);
      const commitDelta = makeCommitDelta("fixture/testcount", baseSha, headSha);
      const analysis = await runDiffCIAnalysis({ repoPath, commitDelta, taskRegistry });

      const testsTotal = analysis.profile.testFilePaths.length;
      assert.equal(testsTotal, 3, "should find all 3 real test files, not a glob-pattern count");

      const testsSelectedByDiffci = analysis.plan.selectedTests.length;
      assert.ok(testsSelectedByDiffci >= 1 && testsSelectedByDiffci < testsTotal, "graph-driven selection should narrow below the full total for this isolated change");
      assert.deepStrictEqual(analysis.plan.selectedTests, ["src/a.test.ts"], "only the test that actually imports the changed file should be selected");

      const pathBaseline = runPathBaseline(analysis.profile.testFilePaths, analysis.identity.gitDelta.files);
      assert.equal(pathBaseline.selectedTests.length, testsTotal, "PATH baseline selects all src/ tests for any src/ change (coarser than the graph)");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });

  it("selects every test when the delta forces FULL fallback (regression: allTestPaths() used to return glob strings, not real paths)", async () => {
    const repoPath = createRepo();
    try {
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src/a.test.ts"), "console.assert(true);\n");
      writeFileSync(join(repoPath, "src/b.test.ts"), "console.assert(true);\n");
      commitAll(repoPath, "initial");
      const baseSha = getSha(repoPath);

      writeFileSync(join(repoPath, "package.json"), JSON.stringify({ name: "testcount-fixture", version: "2.0.0", type: "module" }));
      commitAll(repoPath, "bump version");
      const headSha = getSha(repoPath);

      const taskRegistry = createTaskRegistry([{ id: "test:unit", command: "npm test", category: "test", inputPatterns: ["src/**/*"], globalRiskTriggers: ["DEPENDENCY_MANIFEST"] }]);
      const commitDelta = makeCommitDelta("fixture/testcount-fallback", baseSha, headSha);
      const analysis = await runDiffCIAnalysis({ repoPath, commitDelta, taskRegistry });

      assert.equal(analysis.plan.mode, "FULL");
      const testsTotal = analysis.profile.testFilePaths.length;
      const testsSelectedByDiffci = analysis.plan.selectedTests.length;
      assert.equal(testsTotal, 2);
      assert.equal(testsSelectedByDiffci, testsTotal, "FULL fallback must select every real test, not just the 1-2 distinct glob patterns");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
