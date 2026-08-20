import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { runDiffCIAnalysis } from "../../src/research/diffci/adapter.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import { runGenericPathBaseline } from "../../src/research/baseline/path-baseline.js";
import { classifyCommit } from "../../src/research/repository/sampler.js";
import type { CommitDelta } from "../../src/research/types.js";

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-adapter-gitdelta-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'adapter@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Adapter Test'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "adapter-fixture", version: "1.0.0", type: "module" }));
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["**/*.ts"] }),
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

describe("runDiffCIAnalysis gitDelta propagation", () => {
  it("populates commitDelta.gitDelta with the real analyzed delta (regression: was left as an empty placeholder)", async () => {
    const repoPath = createRepo();
    try {
      const srcFile = join(repoPath, "src/calc.ts");
      mkdirSync(dirname(srcFile), { recursive: true });
      writeFileSync(srcFile, "export function calc(n: number): number { return n * 2; }\n");
      commitAll(repoPath, "initial");
      const baseSha = getSha(repoPath);

      writeFileSync(srcFile, "export function calc(n: number): number { return n * 3; }\n");
      commitAll(repoPath, "change calc");
      const headSha = getSha(repoPath);

      const taskRegistry = createTaskRegistry([
        { id: "test:unit", command: "npm test", category: "test", inputPatterns: ["src/**/*"] },
      ]);

      const commitDelta: CommitDelta = {
        repository: "fixture/adapter",
        baseSha,
        headSha,
        logicalDeltaKey: `fixture/adapter:${baseSha}:${headSha}:test:test`,
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

      const analysis = await runDiffCIAnalysis({ repoPath, commitDelta, taskRegistry });

      // The caller's placeholder must be replaced with the real delta, not left empty.
      assert.ok(analysis.identity.gitDelta.files.length > 0, "gitDelta.files should reflect the real changed files, not stay empty");
      assert.deepStrictEqual(
        analysis.identity.gitDelta.files.map((f) => f.path),
        ["src/calc.ts"],
      );

      // Downstream research consumers (runner.ts) read identity.gitDelta.files directly —
      // verify they now see the real changed files instead of always treating the commit as docs-only.
      const category = classifyCommit(analysis.identity.gitDelta.files);
      assert.notStrictEqual(category, "documentation");

      const pathBaseline = runGenericPathBaseline(taskRegistry, analysis.identity.gitDelta.files);
      assert.deepStrictEqual(pathBaseline.selectedTaskIds, ["test:unit"]);
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
    }
  });
});
