/**
 * Per-repository execution profiles (2026-08-24) - how to actually build and test a repository, taken
 * directly from its own real CI workflow, never approximated. A repository with no entry here cannot
 * be execution-validated; `getRepoExecutionProfile()` returns undefined and the caller must report
 * "not configured", never fall back to a generic guessed command.
 *
 * cal.com's profile is read verbatim from its real workflow (.github/workflows/unit-tests.yml,
 * confirmed 2026-08-24): install via yarn, `yarn prisma generate`, then `yarn test -- --no-isolate`
 * (vitest's default mode = every `**\/*.{test,spec}.*` file except the separate timezone-mode pass -
 * this is exactly the ~250-test "unit" family DiffCI's own test-discovery already found for cal.com).
 */
import type { RepoExecutionProfile } from "./execution-types.js";

const PROFILES: Record<string, RepoExecutionProfile> = {
  "calcom/cal.diy": {
    repository: "calcom/cal.diy",
    packageManager: "yarn",
    installArgv: ["install"],
    pretestArgv: [["prisma", "generate"]],
    testArgv: ["test", "--", "--no-isolate"],
    testEnv: { TZ: "UTC" },
    // "default" alongside "json" (2026-08-24): the json reporter alone prints nothing human-readable to
    // stdout, which left no way to cross-check a missing/malformed structured report against what the
    // test runner actually did. Both write independently - default to the process's own stdout (now
    // captured via getProcessLogs), json to its own --outputFile.json path.
    reporterArgv: ["--reporter=json", "--reporter=default"],
  },
};

export function getRepoExecutionProfile(repository: string): RepoExecutionProfile | undefined {
  return PROFILES[repository];
}

export function listConfiguredRepositories(): string[] {
  return Object.keys(PROFILES);
}
