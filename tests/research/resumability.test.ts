import { strict as assert } from "node:assert";
import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { analyzeCommit, type RepoBenchmarkResult, type Stage0ConfigSnapshot } from "../../src/research/benchmark/runner.js";
import { LocalEvidenceStore } from "../../src/research/store/evidence.js";
import { createTaskRegistry } from "../../src/planner/task-registry.js";
import type { ResearchRepository, RepositoryMetadata } from "../../src/research/types.js";

// Exercises the resumability fix in src/research/benchmark/runner.ts: a rerun must recognize an
// already-completed logicalDeltaKey and skip re-analysis entirely, per the Stage 0 spec's
// resumability requirement. See diffci/docs/research/2026-08-20-stage0-full-experiment-architecture.md.

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-resume-"));
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'resume@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Resume Test'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "resume-fixture", version: "1.0.0", type: "module" }));
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

function fakeMetadata(localPath: string): RepositoryMetadata {
  return {
    repository: "fixture/resume",
    cloneUrl: "https://example.invalid/fixture/resume.git",
    localPath,
    primaryLanguage: "typescript",
    framework: "none",
    sizeClass: "small",
    license: "MIT",
    defaultBranch: "main",
    commitCount: 2,
    sourceFiles: 2,
    workflowFiles: 0,
    languageSupport: { diffciGraphCapable: true, reason: "" },
  };
}

const repo: ResearchRepository = { owner: "fixture", name: "resume", primaryLanguage: "typescript", framework: "none", sizeClass: "small" };

const config: Stage0ConfigSnapshot = {
  experimentId: "resume-test",
  diffciVersion: "test",
  schemaVersion: "test-schema",
  repoCacheDir: "",
  cacheDir: resolve(mkdtempSync(join(tmpdir(), "diffci-resume-cache-"))),
  cloneDepth: 1,
  maxCommitsPerRepository: 10,
  recentCommitWindow: 10,
  excludeMergeCommits: true,
  excludeBotCommits: true,
  graphTimeouts: { smallMs: 30_000 },
};

describe("Stage 0 resumability", () => {
  it("skips re-analysis on rerun once a logicalDeltaKey is already persisted", async () => {
    const repoPath = createRepo();
    const storeDir = mkdtempSync(join(tmpdir(), "diffci-resume-store-"));
    try {
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src/a.ts"), "export const a = 1;\n");
      commitAll(repoPath, "initial");
      const baseSha = getSha(repoPath);
      writeFileSync(join(repoPath, "src/a.ts"), "export const a = 2;\n");
      commitAll(repoPath, "change a");
      const headSha = getSha(repoPath);

      const store = new LocalEvidenceStore(storeDir);
      const taskRegistry = createTaskRegistry([{ id: "test:unit", command: "npm test", category: "test", inputPatterns: ["src/**/*"] }]);
      const commit = { baseSha, headSha };

      const firstResult: RepoBenchmarkResult = { metadata: fakeMetadata(repoPath), records: [], errors: [], resumedFromExisting: 0 };
      await analyzeCommit(commit, repo, taskRegistry, firstResult, store, config);

      assert.equal(firstResult.records.length, 1, "first run should analyze and persist exactly one record");
      assert.equal(firstResult.resumedFromExisting, 0);
      assert.equal(firstResult.errors.length, 0);
      const firstRecord = firstResult.records[0]!;

      // Prove the second call cannot possibly re-run real analysis: delete the repo working copy
      // entirely. If resumability is broken and analyzeCommit tries to re-analyze, this will throw
      // (git/graph work against a path that no longer exists) and the test will fail loudly.
      rmSync(repoPath, { recursive: true, force: true });

      const secondResult: RepoBenchmarkResult = { metadata: fakeMetadata(repoPath), records: [], errors: [], resumedFromExisting: 0 };
      await analyzeCommit(commit, repo, taskRegistry, secondResult, store, config);

      assert.equal(secondResult.records.length, 1, "resumed run should still produce exactly one record");
      assert.equal(secondResult.resumedFromExisting, 1, "must be counted as resumed, not freshly analyzed");
      assert.equal(secondResult.errors.length, 0, "must not attempt (and fail) real analysis against the deleted repo");
      // Compare against the JSON-round-tripped form of the original record, not the raw in-memory
      // object: the evidence store persists as JSON, which drops keys whose value is `undefined`
      // (e.g. an absent graphLoadWarmMs on a cold-cache run) - that's an artifact of persistence, not
      // a resumability defect.
      assert.deepEqual(secondResult.records[0], JSON.parse(JSON.stringify(firstRecord)), "resumed record must be identical to the originally persisted one");
    } finally {
      rmSync(repoPath, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });

  it("uses distinct logicalDeltaKeys (and therefore distinct evidence) for the same commit SHAs in two different repositories", async () => {
    // Regression guard for cross-repository cache/evidence contamination: two different repos that
    // happen to produce identical base/head SHAs (e.g. both freshly `git init`'d fixtures) must not
    // collide in the evidence store, because logicalDeltaKey embeds "owner/name".
    const repoAPath = createRepo();
    const repoBPath = createRepo();
    const storeDir = mkdtempSync(join(tmpdir(), "diffci-resume-store-cross-"));
    try {
      for (const dir of [repoAPath, repoBPath]) {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
        commitAll(dir, "initial");
      }
      const baseShaA = getSha(repoAPath);
      const baseShaB = getSha(repoBPath);
      writeFileSync(join(repoAPath, "src/a.ts"), "export const a = 2;\n");
      commitAll(repoAPath, "change a");
      writeFileSync(join(repoBPath, "src/a.ts"), "export const a = 2;\n");
      commitAll(repoBPath, "change a");
      const headShaA = getSha(repoAPath);
      const headShaB = getSha(repoBPath);

      const store = new LocalEvidenceStore(storeDir);
      const taskRegistry = createTaskRegistry([{ id: "test:unit", command: "npm test", category: "test", inputPatterns: ["src/**/*"] }]);
      const repoA: ResearchRepository = { owner: "fixture", name: "repo-a", primaryLanguage: "typescript", framework: "none", sizeClass: "small" };
      const repoB: ResearchRepository = { owner: "fixture", name: "repo-b", primaryLanguage: "typescript", framework: "none", sizeClass: "small" };

      const resultA: RepoBenchmarkResult = { metadata: fakeMetadata(repoAPath), records: [], errors: [], resumedFromExisting: 0 };
      await analyzeCommit({ baseSha: baseShaA, headSha: headShaA }, repoA, taskRegistry, resultA, store, config);
      const resultB: RepoBenchmarkResult = { metadata: fakeMetadata(repoBPath), records: [], errors: [], resumedFromExisting: 0 };
      await analyzeCommit({ baseSha: baseShaB, headSha: headShaB }, repoB, taskRegistry, resultB, store, config);

      assert.equal(resultA.resumedFromExisting, 0, "repo A must be freshly analyzed, not resumed from repo B's evidence");
      assert.equal(resultB.resumedFromExisting, 0, "repo B must be freshly analyzed, not resumed from repo A's evidence");
      assert.notEqual(resultA.records[0]!.identity.logicalDeltaKey, resultB.records[0]!.identity.logicalDeltaKey);
    } finally {
      rmSync(repoAPath, { recursive: true, force: true });
      rmSync(repoBPath, { recursive: true, force: true });
      rmSync(storeDir, { recursive: true, force: true });
    }
  });
});
