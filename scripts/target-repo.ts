/**
 * Shared target-repo resolution for the DentalPresence-specific audit/benchmark tools
 * (audit-dentalpresence-graph.ts, audit-dentalpresence-impact.ts, benchmark-dentalpresence.ts). These
 * point DiffCI's own analysis engine AT the DentalPresence.in repository - they've never analyzed this
 * package's own source, unlike diffci.ts/diffci-shadow.ts.
 *
 * Until 2026-08-21 this repo lived nested one level inside DentalPresence.in/diffci/, so the target was
 * always exactly two directories up from scripts/ - a fixed relative path worked. Now that this repo has
 * moved out to its own top-level location, DentalPresence.in is a SIBLING folder, not an ancestor, and
 * there's no path derivable purely from this file's own location that's guaranteed correct on every
 * machine. DENTALPRESENCE_REPO_PATH lets a caller say exactly where it is; the default guesses the one
 * layout this was actually moved into (a same-name sibling of this repo's own parent folder) and fails
 * loudly - not silently analyzing the wrong tree - if that guess doesn't hold.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";

export function resolveDentalPresenceRepoPath(): string {
  const fromEnv = process.env.DENTALPRESENCE_REPO_PATH;
  const repoPath = fromEnv ? resolve(fromEnv) : resolve(dirname(import.meta.filename), "..", "..", "DentalPresence.in");

  if (!existsSync(resolve(repoPath, "package.json"))) {
    throw new Error(
      `Expected a DentalPresence.in checkout with package.json at ${repoPath} (${fromEnv ? "from DENTALPRESENCE_REPO_PATH" : "guessed as a sibling folder of this repo"}). ` +
        `Set DENTALPRESENCE_REPO_PATH to the real checkout path if it lives somewhere else.`,
    );
  }
  return repoPath;
}
