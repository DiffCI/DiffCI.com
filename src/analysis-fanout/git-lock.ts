/**
 * Git-lock stale recovery for the analysis fan-out harness (2026-08-24).
 *
 * The frozen `scripts/diffci-blind-baseline.ts` replay driver checks each historical merge out of a
 * single shared clone, one merge at a time. A `.git/index.lock` left behind by a crashed or aborted
 * earlier git process (the cal.com "git-lock race": `fatal: Unable to create '.git/index.lock': File
 * exists`) makes the next `git checkout` fail even though no git process is actually running. This
 * module decides whether such a lock is stale (its holder PID is dead) and removes it before the next
 * checkout, so concurrent/serial merge analyses never interfere through a shared git working tree.
 *
 * This file is NOT part of the frozen engine's checksummed `engineFiles` set - it is harness
 * orchestration only and never changes analysis, classification, or verdict behaviour.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";

/** Pure seam so the stale-lock decision is unit-testable without a real filesystem/process table. */
export interface GitLockProbe {
  /** Raw lock-file content, or undefined when no lock file exists. Git writes its holder PID as text. */
  readLock(lockPath: string): string | undefined;
  /** Whether a process with this PID is currently alive. */
  isPidAlive(pid: number): boolean;
}

/** The canonical `.git/index.lock` path for a checked-out repository. */
export function indexLockPath(repoDir: string): string {
  return join(repoDir, ".git", "index.lock");
}

/**
 * Decide whether the `.git/index.lock` at `repoDir` is stale (safe to remove). A lock is NOT stale
 * only when it exists and names a PID that is still alive. An empty/unparseable lock is treated as
 * stale: git writes the holder PID atomically when it creates the lock, so in the harness's serial,
 * synchronous-execution context any lock present at recovery time with no live holder is a leftover.
 */
export function isStaleGitLock(repoDir: string, probe: GitLockProbe): boolean {
  const content = probe.readLock(indexLockPath(repoDir));
  if (content === undefined) return false;
  const pid = Number.parseInt(content.trim(), 10);
  if (Number.isInteger(pid) && pid > 0 && probe.isPidAlive(pid)) return false;
  return true;
}

/**
 * Cross-platform PID liveness check. `process.kill(pid, 0)` never delivers a signal; it throws when the
 * process does not exist, and throws `EPERM` (not `ESRCH`) when it exists but is owned by another user.
 */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

const defaultProbe: GitLockProbe = {
  readLock: (p) => (existsSync(p) ? readFileSync(p, "utf8") : undefined),
  isPidAlive,
};

/**
 * Remove a stale `.git/index.lock` so a subsequent `git checkout` is not poisoned by a crashed/aborted
 * earlier git process. Returns true only when it actually removed a stale lock (idempotent - a missing
 * or genuinely-held lock is left untouched and returns false).
 */
export function recoverStaleGitLock(repoDir: string): boolean {
  if (!isStaleGitLock(repoDir, defaultProbe)) return false;
  unlinkSync(indexLockPath(repoDir));
  return true;
}