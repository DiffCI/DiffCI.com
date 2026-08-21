/**
 * Tests the deployment/version-selection helper logic introduced by the 2026-08-21 source-integrity fix
 * (scripts/shadow-source-lib.ts) against a real, isolated throwaway git repo - never against this
 * repository's own working tree, which is routinely dirty mid-development and would make these tests
 * flaky for a reason that has nothing to do with the code under test.
 */
import assert from "node:assert";
import { execSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { currentHeadSha, isValidSha, isWorkingTreeDirty, packageSource } from "../../scripts/shadow-source-lib.js";

function createTempGitRepo(): string {
  const dir = join(tmpdir(), `diffci-shadow-source-test-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  execSync("git init --quiet", { cwd: dir });
  execSync("git config user.email 'test@diffci.local'", { cwd: dir });
  execSync("git config user.name 'Test User'", { cwd: dir });
  execSync("git config core.autocrlf false", { cwd: dir });
  return dir;
}

function commitAll(repoPath: string, message: string): void {
  execSync("git add -A", { cwd: repoPath });
  execSync(`git commit --quiet -m "${message}"`, { cwd: repoPath });
}

function getSha(repoPath: string): string {
  return execSync("git rev-parse HEAD", { cwd: repoPath, encoding: "utf8" }).trim();
}

describe("shadow-source-lib", () => {
  let repoPath: string;

  before(() => {
    repoPath = createTempGitRepo();
    writeFileSync(join(repoPath, "src.txt"), "hello\n");
    commitAll(repoPath, "initial");
  });

  after(() => {
    rmSync(repoPath, { recursive: true, force: true });
  });

  it("currentHeadSha matches `git rev-parse HEAD` and is a valid full SHA", () => {
    const sha = currentHeadSha(repoPath);
    assert.strictEqual(sha, getSha(repoPath));
    assert.strictEqual(isValidSha(sha), true);
  });

  it("isWorkingTreeDirty is false right after a clean commit", () => {
    assert.strictEqual(isWorkingTreeDirty(repoPath), false);
  });

  it("isWorkingTreeDirty is true for an uncommitted MODIFICATION to a tracked file", () => {
    writeFileSync(join(repoPath, "src.txt"), "modified, not committed\n");
    assert.strictEqual(isWorkingTreeDirty(repoPath), true);
    // Restore cleanliness for the tests that follow.
    execSync("git checkout -- src.txt", { cwd: repoPath });
    assert.strictEqual(isWorkingTreeDirty(repoPath), false);
  });

  it("isWorkingTreeDirty is true for a genuinely UNTRACKED file - it would silently end up in the tarball otherwise", () => {
    writeFileSync(join(repoPath, "untracked.txt"), "not added, not committed\n");
    try {
      assert.strictEqual(isWorkingTreeDirty(repoPath), true);
    } finally {
      rmSync(join(repoPath, "untracked.txt"));
    }
  });

  it("packageSource REFUSES a dirty working tree by default - the whole point of this fix", () => {
    writeFileSync(join(repoPath, "src.txt"), "dirty again\n");
    try {
      assert.throws(() => packageSource(repoPath), /uncommitted changes/);
    } finally {
      execSync("git checkout -- src.txt", { cwd: repoPath });
    }
  });

  it("packageSource(allowDirty:true) proceeds anyway, still stamping the last commit's SHA (a debug-only escape hatch, never the canonical deploy path)", () => {
    writeFileSync(join(repoPath, "src.txt"), "dirty but allowed\n");
    try {
      const packaged = packageSource(repoPath, { allowDirty: true });
      try {
        assert.strictEqual(packaged.sourceSha, getSha(repoPath));
      } finally {
        packaged.cleanup();
      }
    } finally {
      execSync("git checkout -- src.txt", { cwd: repoPath });
    }
  });

  it("packageSource on a clean tree produces a tarball whose archiveHash is a real SHA-256 of its own bytes, and sourceSha is real HEAD", () => {
    const packaged = packageSource(repoPath);
    try {
      assert.strictEqual(packaged.sourceSha, currentHeadSha(repoPath));
      assert.strictEqual(existsSync(packaged.tarballPath), true);
      const bytes = readFileSync(packaged.tarballPath);
      assert.strictEqual(packaged.sizeBytes, bytes.byteLength);
      const independentHash = createHash("sha256").update(bytes).digest("hex");
      assert.strictEqual(packaged.archiveHash, independentHash);
    } finally {
      packaged.cleanup();
    }
    assert.strictEqual(existsSync(packaged.tarballPath), false, "cleanup() must actually remove the tarball");
  });

  it("packaging a SECOND commit produces a DIFFERENT sourceSha and a different archiveHash - version identity actually tracks content", () => {
    const first = packageSource(repoPath);
    try {
      writeFileSync(join(repoPath, "src.txt"), "second commit content\n");
      commitAll(repoPath, "second commit");
      const second = packageSource(repoPath);
      try {
        assert.notStrictEqual(second.sourceSha, first.sourceSha);
        assert.notStrictEqual(second.archiveHash, first.archiveHash);
      } finally {
        second.cleanup();
      }
    } finally {
      first.cleanup();
    }
  });
});
