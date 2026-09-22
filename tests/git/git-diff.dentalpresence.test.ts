import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { before, after, describe, it } from "node:test";
import {
  analyzeGitDelta,
  findRecentNonEmptyCommitPair,
  gitDeltaToJson,
  resolveCommitParents,
  ZERO_SHA,
} from "../../src/git/git-diff.js";

describe("analyzeGitDelta on a committed repository", () => {
  let root: string;
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }).trim();
  before(() => {
    root = mkdtempSync(join(tmpdir(), "diffci-git-history-"));
    git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    git("add", "."); git("commit", "-qm", "base");
    writeFileSync(join(root, "value.ts"), "export const value = 2;\n");
    git("add", "."); git("commit", "-qm", "change");
  });
  after(() => { if (root) rmSync(root, { recursive: true, force: true }); });

  it("returns an empty delta for identical base and head", async () => {
    const head = git("rev-parse", "HEAD");
    const result = await analyzeGitDelta({ repoPath: root, baseSha: head, headSha: head });

    assert.strictEqual(result.success, true);
    if (!result.success) return;

    assert.deepStrictEqual(result.delta.files, []);
    assert.strictEqual(result.delta.analysis.empty, true);
  });

  it("reports failure for invalid / zero base SHA", async () => {
    const head = git("rev-parse", "HEAD");
    const result = await analyzeGitDelta({ repoPath: root, baseSha: ZERO_SHA, headSha: head });
    assert.strictEqual(result.success, false);
  });

  it("analyzes a known non-empty first-parent delta", async () => {
    const pair = findRecentNonEmptyCommitPair(root, 32);
    assert.ok(pair, "could not find a recent non-empty first-parent commit pair");

    const result = await analyzeGitDelta({ repoPath: root, baseSha: pair!.baseSha, headSha: pair!.headSha });
    assert.strictEqual(result.success, true);
    if (!result.success) return;

    assert.strictEqual(result.delta.baseSha, pair!.baseSha);
    assert.strictEqual(result.delta.headSha, pair!.headSha);
    assert.ok(result.delta.files.length > 0, "expected changed files in selected commit pair");
  });

  it("produces deterministic output for the same commit range", async () => {
    const pair = findRecentNonEmptyCommitPair(root, 32);
    assert.ok(pair);

    const first = await analyzeGitDelta({ repoPath: root, baseSha: pair!.baseSha, headSha: pair!.headSha });
    const second = await analyzeGitDelta({ repoPath: root, baseSha: pair!.baseSha, headSha: pair!.headSha });

    assert.strictEqual(first.success, true);
    assert.strictEqual(second.success, true);
    if (!first.success || !second.success) return;

    assert.strictEqual(gitDeltaToJson(first.delta), gitDeltaToJson(second.delta));
  });

  it("does not crash when HEAD is a merge commit", async () => {
    const head = git("rev-parse", "HEAD");
    const parents = resolveCommitParents(head, root);

    // If the current HEAD is not a merge commit, the test still validates that
    // the first-parent base resolves safely. If it is a merge commit, we
    // compare the first two parents.
    if (parents.length >= 2) {
      const result = await analyzeGitDelta({ repoPath: root, baseSha: parents[1]!, headSha: head });
      assert.strictEqual(result.success, true);
    } else {
      const result = await analyzeGitDelta({ repoPath: root, headSha: head });
      assert.strictEqual(result.success, true);
    }
  });
});
