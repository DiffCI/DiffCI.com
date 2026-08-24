/**
 * Production wiring for relationship-based classification (2026-08-23, deepseek-harness benchmark):
 * the HEAD inventory is produced ONCE by analyzeGitDelta (src/git/git-diff.ts readRepositoryInventory)
 * and handed to ImpactAnalyzer by every production entrypoint. These tests exercise the REAL
 * entrypoints on a real temporary git repository - not the analyzer in isolation - so a regression
 * that drops the `{ repositoryFiles }` argument in any path shows up here.
 */
import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { analyzeGitDelta, readRepositoryInventory } from "../../src/git/git-diff.js";
import { runDiffCIAnalysis } from "../../src/research/diffci/adapter.js";
import { runShadowAnalysis } from "../../src/shadow/runner.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { CommitDelta } from "../../src/research/types.js";

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-companion-wiring-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'wiring@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Wiring Test'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "wiring-fixture", version: "1.0.0", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true }, include: ["**/*.ts"] }));
  const src = join(dir, "src/calc.ts");
  mkdirSync(dirname(src), { recursive: true });
  writeFileSync(src, "export function calc(n: number): number { return n * 2; }\n");
  writeFileSync(join(dir, "src/calc.test.ts"), "import { calc } from './calc.js';\nif (calc(1) !== 2) throw new Error('x');\n");
  mkdirSync(join(dir, "packages/llm"), { recursive: true });
  writeFileSync(join(dir, "packages/llm/README.md"), "# llm\n");
  writeFileSync(join(dir, "packages/llm/README.zh.md"), "# llm (zh)\n");
  writeFileSync(join(dir, "packages/llm/README.i18n.yaml"), "README.md: aaaa\nREADME.zh.md: bbbb\n");
  return dir;
}
function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath });
  execSync(`git commit --quiet --allow-empty -m "${message}"`, { cwd: repoPath });
}
function sha(repoPath: string, ref = "HEAD"): string { return execSync(`git rev-parse ${ref}`, { cwd: repoPath, encoding: "utf8" }).trim(); }
function makeCommitDelta(baseSha: string, headSha: string): CommitDelta {
  return {
    repository: "fixture/wiring", baseSha, headSha, logicalDeltaKey: `fixture/wiring:${baseSha}:${headSha}:t:t`, experimentId: "t", diffCiVersion: "t", schemaVersion: "t", category: "unknown",
    gitDelta: { baseSha, headSha, files: [], directories: [], summary: { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: 0 }, analysis: { empty: false, configChanged: false, dependencyManifestChanged: false, lockfileChanged: false, workflowChanged: false, infrastructureChanged: false, databaseChanged: false } },
  };
}
const registry = () => createTaskRegistry([{ id: "test:unit", command: "npm test", category: "test", inputPatterns: ["src/**/*"] }]);
const hasUnknown = (reasons: readonly string[]) => reasons.some((r) => r.startsWith("Unknown changed file"));

describe("canonical HEAD inventory from analyzeGitDelta", () => {
  it("returns the full HEAD tree once, alongside (not inside) the serializable delta", async () => {
    const repo = createRepo();
    try {
      commitAll(repo, "initial");
      const base = sha(repo);
      writeFileSync(join(repo, "packages/llm/README.i18n.yaml"), "README.md: cccc\nREADME.zh.md: dddd\n");
      commitAll(repo, "update pairing record");
      const head = sha(repo);
      const result = await analyzeGitDelta({ repoPath: repo, baseSha: base, headSha: head });
      assert.ok(result.success);
      assert.ok(result.inventory, "inventory should be present on success");
      assert.strictEqual(result.inventory.headSha, head);
      assert.strictEqual(result.inventory.source, "git-ls-tree");
      for (const p of ["package.json", "src/calc.ts", "packages/llm/README.md", "packages/llm/README.i18n.yaml"]) assert.ok(result.inventory.files.has(p), p);
      assert.strictEqual("inventory" in result.delta, false, "GitDelta itself must stay free of the inventory");
      assert.strictEqual(JSON.stringify(result.delta).includes("git-ls-tree"), false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("failure path: an unlistable HEAD yields no inventory (never throws, never an empty 'trusted' set)", () => {
    const repo = createRepo();
    try {
      commitAll(repo, "initial");
      assert.strictEqual(readRepositoryInventory("0".repeat(40), repo), undefined);
      assert.strictEqual(readRepositoryInventory("not-a-ref", repo), undefined);
      assert.strictEqual(readRepositoryInventory(sha(repo), join(repo, "does-not-exist")), undefined);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});

describe("production entrypoints activate the companion rule through the canonical inventory", () => {
  it("Stage 2F path (runDiffCIAnalysis): a modified <doc>.i18n.yaml beside <doc>.md is not an unknown file", async () => {
    const repo = createRepo();
    try {
      commitAll(repo, "initial");
      const base = sha(repo);
      writeFileSync(join(repo, "packages/llm/README.i18n.yaml"), "README.md: cccc\nREADME.zh.md: dddd\n");
      commitAll(repo, "update pairing record");
      const head = sha(repo);
      const analysis = await runDiffCIAnalysis({ repoPath: repo, commitDelta: makeCommitDelta(base, head), taskRegistry: registry() });
      assert.strictEqual(hasUnknown(analysis.fallbackReasons), false, JSON.stringify(analysis.fallbackReasons));
      assert.strictEqual(analysis.classification.fallbackRequired, false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("shadow path (runShadowAnalysis): same commit pair, same verdict as the Stage 2F path", async () => {
    const repo = createRepo();
    try {
      commitAll(repo, "initial");
      const base = sha(repo);
      writeFileSync(join(repo, "packages/llm/README.i18n.yaml"), "README.md: cccc\nREADME.zh.md: dddd\n");
      commitAll(repo, "update pairing record");
      const head = sha(repo);
      const record = await runShadowAnalysis({ repoPath: repo, baseSha: base, headSha: head });
      assert.strictEqual(hasUnknown(record.fallbackReasons), false, JSON.stringify(record.fallbackReasons));
      assert.strictEqual(record.impactFallback, false);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("deleted companion whose document survives at HEAD is docs; deleted together with its document stays unknown -> fallback", async () => {
    const repo = createRepo();
    try {
      commitAll(repo, "initial");
      const base = sha(repo);
      rmSync(join(repo, "packages/llm/README.i18n.yaml"));
      commitAll(repo, "drop pairing record only");
      const recordOnly = await runShadowAnalysis({ repoPath: repo, baseSha: base, headSha: sha(repo) });
      assert.strictEqual(hasUnknown(recordOnly.fallbackReasons), false);
      assert.strictEqual(recordOnly.impactFallback, false);

      const base2 = sha(repo);
      execSync("git checkout --quiet HEAD~1 -- packages/llm/README.i18n.yaml", { cwd: repo });
      commitAll(repo, "restore record");
      const base3 = sha(repo);
      rmSync(join(repo, "packages/llm"), { recursive: true });
      commitAll(repo, "delete doc + record + zh");
      const both = await runShadowAnalysis({ repoPath: repo, baseSha: base3, headSha: sha(repo) });
      assert.strictEqual(hasUnknown(both.fallbackReasons), true, "companion gone at HEAD -> record must stay unknown");
      assert.strictEqual(both.impactFallback, true);
      void base2;
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("renamed companion: accepted only when the NEW name has a document beside it at HEAD", async () => {
    const repo = createRepo();
    try {
      writeFileSync(join(repo, "packages/llm/GUIDE.md"), "# guide\n");
      commitAll(repo, "initial");
      const base = sha(repo);
      renameSync(join(repo, "packages/llm/README.i18n.yaml"), join(repo, "packages/llm/GUIDE.i18n.yaml"));
      commitAll(repo, "rename record to GUIDE");
      const ok = await runShadowAnalysis({ repoPath: repo, baseSha: base, headSha: sha(repo) });
      assert.strictEqual(hasUnknown(ok.fallbackReasons), false, JSON.stringify(ok.fallbackReasons));

      const base2 = sha(repo);
      renameSync(join(repo, "packages/llm/GUIDE.i18n.yaml"), join(repo, "packages/llm/ORPHAN.i18n.yaml"));
      commitAll(repo, "rename record to a name with no document");
      const orphan = await runShadowAnalysis({ repoPath: repo, baseSha: base2, headSha: sha(repo) });
      assert.strictEqual(hasUnknown(orphan.fallbackReasons), true);
      assert.strictEqual(orphan.impactFallback, true);
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });

  it("mixed delta through the production path: companion + source change selects the source's test, no unknown", async () => {
    const repo = createRepo();
    try {
      commitAll(repo, "initial");
      const base = sha(repo);
      writeFileSync(join(repo, "packages/llm/README.i18n.yaml"), "README.md: eeee\nREADME.zh.md: ffff\n");
      writeFileSync(join(repo, "src/calc.ts"), "export function calc(n: number): number { return n * 3; }\n");
      commitAll(repo, "record + source");
      const record = await runShadowAnalysis({ repoPath: repo, baseSha: base, headSha: sha(repo) });
      assert.strictEqual(hasUnknown(record.fallbackReasons), false, JSON.stringify(record.fallbackReasons));
    } finally { rmSync(repo, { recursive: true, force: true }); }
  });
});
