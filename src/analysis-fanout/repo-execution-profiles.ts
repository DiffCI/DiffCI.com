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
  /**
   * deepseek-ai/deepseek-harness (2026-08-25, DeepSeek execution-validation mission, Phase 5). Confirmed
   * verbatim from .github/workflows/ci.yml, package.json, and scripts/run-gates.ts (see
   * docs/research/2026-08-25-deepseek-execution-validation/01-identity-and-validation-universe-inventory.md).
   *
   * UNIT FAMILY ONLY: this is the only family DiffCI's static engine currently selects tests for
   * (`totalTestsInGraph` ~1015-1031 = root vitest.config.ts's test surface). Real CI's actual unit-test
   * gate is coverage-instrumented and partitioned (`pnpm run check:ci:coverage` -> `test:coverage:partitioned`
   * -> multiple single-worker `vitest run --coverage` processes merged), which has no simple per-file
   * selective-invocation shape. `testArgv: ["test"]` instead targets the plain, uninstrumented
   * `"test": "vitest run"` script - the same underlying vitest.config.ts test surface, without coverage
   * instrumentation or partitioning, matching the Cal.com precedent's choice to measure the corrected,
   * reliably-selectable command shape rather than force-fit real CI's own heavier wrapper. This is a
   * deliberate, documented narrowing (see the inventory report's completeness label), not an
   * approximation error. Snapshot (`test:snapshot`) and E2E (`test:e2e`, credential-gated) are
   * documented in the same report but not yet wired here - DiffCI has no selection to validate against
   * them (it doesn't select snapshot/e2e tests at all), so there is nothing for this profile to execute
   * selectively in those families this round.
   *
   * `--ignore-scripts` on install (deviating from the CI workflow's bare `pnpm install --frozen-lockfile`)
   * intentionally preserved from the pre-existing local harness (scripts/diffci-execution-validation.ts,
   * 2026-08-23, never actually run) - a sandbox-safety policy (no arbitrary postinstall script execution
   * inside the shared container), not a CI-fidelity shortcut. The unit family does not depend on any
   * postinstall-built artifact (confirmed: no build prerequisite for `vitest run` per the inventory).
   *
   * Whether `corepack pnpm test <reporterArgv> --outputFile.json=... <files>` actually forwards the
   * trailing file-filter arguments to vitest (pnpm's own argument-forwarding semantics for `pnpm run
   * <script> <extra args>` are NOT assumed identical to yarn's, per the Cal.com `--` lesson) is NOT yet
   * empirically confirmed for this repository - see the pending argument-forwarding probe report before
   * trusting any selective run made with this profile.
   */
  "deepseek-ai/deepseek-harness": {
    repository: "deepseek-ai/deepseek-harness",
    packageManager: "pnpm",
    installArgv: ["install", "--frozen-lockfile", "--ignore-scripts"],
    pretestArgv: [],
    testArgv: ["test"],
    reporterArgv: ["--reporter=json", "--reporter=default"],
    // 15 minutes (2026-08-25, provisional pending canary): no repo-declared per-job timeout exists for
    // this family (only the unrelated windows/windows-native jobs set timeout-minutes), and this
    // repository's modeled unit-test graph (~1015-1031 files) is roughly 4x cal.com's (~406), so cal.com's
    // proven 10-minute cap is deliberately not reused as-is. Revisit after the canary run's real full-suite
    // duration is observed.
    maxTestRunMs: 15 * 60_000,
  },
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
    // 10 minutes (2026-08-24): every normal observation of this command (isolated OR --no-isolate
    // selective) finishes in well under 4 minutes; the one anomalous run (--no-isolate, full 406-file
    // suite) ran past 20 minutes with no sign of finishing. 10 minutes gives real variance headroom
    // while still catching that failure mode instead of polling forever.
    maxTestRunMs: 10 * 60_000,
  },
};

export function getRepoExecutionProfile(repository: string): RepoExecutionProfile | undefined {
  return PROFILES[repository];
}

export function listConfiguredRepositories(): string[] {
  return Object.keys(PROFILES);
}
