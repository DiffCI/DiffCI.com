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
 *
 * `testArgv` deliberately does NOT include the `--` the real CI workflow line shows (2026-08-24
 * argument-forwarding-mission finding, confirmed empirically via a dedicated Cloudflare diagnostic
 * probe - see docs/research/2026-08-24-calcom-execution-observability/07-argument-forwarding-root-cause.md
 * and 08-plain-filter-confirmation.md): in this repository's installed Yarn/Vitest combination, `yarn
 * test -- <anything>` silently drops everything after the `--` and runs the plain `vitest run` with NO
 * extra arguments at all - proven with a smoking-gun pair (`yarn test -- --definitely-invalid-diffci-
 * option` ran the full ~260s suite, exit 0; `yarn test --definitely-invalid-diffci-option`, no
 * separator, correctly failed in ~1.6s with Vitest's own `CACError: Unknown option`). Dropping the `--`
 * (confirmed via the same probe: `yarn test --no-isolate <file>` forwards BOTH `--no-isolate` and the
 * file filter correctly - HONORED_EXACTLY, 2 files requested, 2 executed) fixes not only selective
 * execution but the FULL-suite baseline too: every full-suite run before this fix was silently missing
 * `--no-isolate` as well (it was swallowed identically), so prior full-suite timing figures in this
 * repository's execution-validation history do not reflect real CI's actual `--no-isolate` behavior and
 * must be re-measured under this corrected command before being trusted for economics. */
import type { RepoExecutionProfile } from "./execution-types.js";

const PROFILES: Record<string, RepoExecutionProfile> = {
  "calcom/cal.diy": {
    repository: "calcom/cal.diy",
    packageManager: "yarn",
    installArgv: ["install"],
    pretestArgv: [["prisma", "generate"]],
    testArgv: ["test", "--no-isolate"],
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
