/**
 * Generic, repo-agnostic historical-regression mutation (2026-08-24).
 *
 * The task requires "success is not inferred merely because historical code passes both suites" - a
 * passing full+selected run on unmodified code proves nothing about failure-detection recall. The
 * mutation must reintroduce a REAL failure that the merge's own tests should catch.
 *
 * Design choice: whole-file revert of the FIRST non-test, non-asset source file the merge changed,
 * back to its exact PRE-MERGE (base) content - via `git show <baseSha>:<path>`, not a synthetic
 * hand-authored bug and not hunk-level patching. Rationale:
 *   - It is the most historically grounded mutation possible: "if this PR's own change were undone,
 *     would the suite notice?" is exactly the regression the PR's own tests were written to catch.
 *   - It generalizes to ANY merge on ANY configured repository automatically - no per-PR authoring,
 *     no fragile hunk-boundary parsing, no risk of producing a syntactically invalid file (the base
 *     version is by definition a real, previously-valid file).
 *   - It is fully auditable: the applied/reverted diff is exactly `git diff base head -- <path>`,
 *     reversed - visible in the record, not opaque.
 * Trade-off, stated plainly: a merge whose only source file is newly added has no base version to
 * revert to - `selectFileToMutate` returns undefined and the caller must report
 * "no revertible source file", never fabricate one.
 */
import { execFileSync } from "node:child_process";

export interface MutationCandidate {
  path: string;
  baseContent: string;
}

/** Picks the file to mutate: the first path in `sourceFiles` (already caller-filtered to non-test,
 * non-asset, real source changes) that existed at `baseSha`. Returns undefined if none did (all were
 * newly added by this merge) - this is a real, reportable limitation, not an error to paper over. */
export function selectFileToMutate(
  repoDir: string,
  baseSha: string,
  sourceFiles: readonly string[],
): MutationCandidate | undefined {
  for (const path of sourceFiles) {
    try {
      const baseContent = execFileSync("git", ["show", `${baseSha}:${path}`], { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      return { path, baseContent };
    } catch {
      continue; // did not exist at base - try the next candidate, if any
    }
  }
  return undefined;
}
