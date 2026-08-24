import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  indexLockPath,
  isStaleGitLock,
  isPidAlive,
  recoverStaleGitLock,
} from "../../src/analysis-fanout/git-lock.js";

describe("git-lock stale recovery (P1 harness isolation)", () => {
  it("no lock file -> not stale", () => {
    assert.equal(
      isStaleGitLock("/nonexistent/repo", { readLock: () => undefined, isPidAlive: () => true }),
      false,
    );
  });

  it("a live holder PID -> not stale (lock is genuinely held)", () => {
    assert.equal(
      isStaleGitLock("/repo", { readLock: () => "12345\n", isPidAlive: () => true }),
      false,
    );
  });

  it("a dead holder PID -> stale", () => {
    assert.equal(
      isStaleGitLock("/repo", { readLock: () => "12345\n", isPidAlive: () => false }),
      true,
    );
  });

  it("an empty or non-numeric lock -> stale (never a live holder)", () => {
    assert.equal(isStaleGitLock("/repo", { readLock: () => "", isPidAlive: () => true }), true);
    assert.equal(isStaleGitLock("/repo", { readLock: () => "not-a-pid", isPidAlive: () => true }), true);
  });

  it("isPidAlive reports the current process alive and a very high PID dead", () => {
    assert.equal(isPidAlive(process.pid), true);
    assert.equal(isPidAlive(999_999_999), false);
  });

  it("recoverStaleGitLock removes a stale lock from a real git repo and is idempotent", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-gitlock-"));
    try {
      execSync("git init --quiet", { cwd: dir });
      const lock = indexLockPath(dir);
      writeFileSync(lock, "999999999\n");
      assert.equal(existsSync(lock), true);
      assert.equal(recoverStaleGitLock(dir), true);
      assert.equal(existsSync(lock), false);
      // Already gone: a second call is a no-op, not an error.
      assert.equal(recoverStaleGitLock(dir), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("recoverStaleGitLock leaves a lock held by a live PID in place", () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-gitlock-live-"));
    try {
      execSync("git init --quiet", { cwd: dir });
      const lock = indexLockPath(dir);
      writeFileSync(lock, `${process.pid}\n`);
      assert.equal(recoverStaleGitLock(dir), false);
      assert.equal(existsSync(lock), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});