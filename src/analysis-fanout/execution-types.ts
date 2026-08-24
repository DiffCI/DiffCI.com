/**
 * Types for execution validation (2026-08-24): a NEW capability of the analysis-fanout Worker, sibling
 * to (not a replacement for) the existing analyze-mode ShardRecord/AnalysisShard state machine. Where
 * analyze mode runs the FROZEN DiffCI engine (never modified) to produce a selection verdict, execute
 * mode takes an already-produced verdict for ONE merge and actually runs the TARGET repository's own
 * install/build/test commands - full suite and DiffCI-selected subset - then applies one generic,
 * repo-agnostic mutation (see mutation.ts) to prove failure-detection recall is not vacuous.
 *
 * This never MODIFIES the frozen engine (src/repo/*, src/git/*, scripts/diffci-benchmark-external.ts,
 * scripts/diffci-blind-baseline.ts). It normally consumes an already-produced selection as input; when
 * the caller omits one, the shard derives it itself (2026-08-24) by bootstrapping the SAME frozen
 * engine tarball AnalysisShard already uses into its own sandbox and invoking the frozen, unmodified
 * scripts/diffci-benchmark-external.ts --json against the freshly-cloned target repo - entirely on
 * Cloudflare, never locally (the standing "always use Cloudflare" rule applies to this derivation too,
 * not just install/test execution).
 */

/** How to invoke a repository's own package manager / test runner. Extensible per repository; a
 * repository with no entry in repo-execution-profiles.ts is reported as "not configured" - execution
 * is never silently faked or approximated with a generic guess. */
export interface RepoExecutionProfile {
  repository: string; // resolved "owner/name"
  packageManager: "yarn" | "npm" | "pnpm";
  /** Argv run via the package-manager's own invocation (e.g. corepack yarn). No shell string - avoids
   * quoting/injection issues the harness has hit before (2026-08-24 CLI tar/r2 fixes). */
  installArgv: string[];
  /** Steps required before tests can run at all (e.g. `prisma generate`). Empty if none. */
  pretestArgv: string[][];
  /** Base test invocation; selected file paths are appended as trailing positional args for the
   * selected-suite run. Must match the repository's REAL CI unit-test job, not an approximation. */
  testArgv: string[];
  /** Environment variables the real CI job sets for this command (e.g. TZ=UTC). */
  testEnv?: Record<string, string>;
  /** Vitest JSON reporter flag shape differs slightly by version; documented per repo, not guessed. */
  reporterArgv: string[];
}

export interface ExecutionSpec {
  runId: string;
  repository: string;
  mergeSha: string;
  baseSha: string;
  prNumber: number | null;
  subject: string;
  /** The pack record's own fields (mirrors ShardRecord) - the Worker looks these up from
   * `manifests/<runId>/pack-record.json` in R2 and re-verifies them exactly like /v1/run does, so the
   * caller never has to (and never can) hand-supply an unverified tarball/checksum pair. */
  tarballKey: string;
  tarballSha256: string;
  frozenManifestKey: string;
  engineChecksum: string;
  /** DiffCI's own selected test file paths for this merge, from a prior analyze-mode result - the exact
   * set execution validation is trying to prove correct. OMIT (undefined/empty) to have the shard
   * derive its own selection instead, by running the frozen scripts/diffci-benchmark-external.ts
   * against the freshly-cloned target repo inside its own sandbox (the `deriving-selection` step) -
   * useful when no prior analyze-mode row exists for this exact merge. */
  selectedTestPaths?: string[];
  totalTestsInGraph?: number;
  /** The prior analyze-mode row's own measured analysis wall time (ms) for this exact merge - threaded
   * through verbatim, never re-measured here, UNLESS omitted alongside selectedTestPaths, in which case
   * the `deriving-selection` step measures its own real wall time instead of leaving this blank. */
  analysisOverheadMs?: number;
  /** Command-shape experimentation (2026-08-24, cal.com command-shape mission): when present, REPLACES
   * `profile.testArgv` for every test-run step (full-baseline/selected-baseline/full-mutant/selected-mutant)
   * in this run only - the stored repo-execution-profiles.ts entry (the CI-verified real command) is
   * never modified. Exists to test whether a different invocation shape (e.g. adding `--project <name>`)
   * actually narrows execution, without a new DO mode or a full pipeline rewrite for every candidate.
   * A run using this MUST be labeled as a command-shape experiment, never conflated with a real
   * CI-command baseline measurement - see ExecutionRecord.testArgvOverride and the run's own subject. */
  testArgvOverride?: string[];
}

export type ExecutionStep =
  | "bootstrapping"
  | "cloning"
  | "deriving-selection"
  | "installing"
  | "pretest"
  | "full-baseline"
  | "selected-baseline"
  | "mutating"
  | "full-mutant"
  | "selected-mutant"
  | "reverting"
  | "finalizing"
  | "done"
  | "failed"
  | "cancelled";

/**
 * Whether structured evidence exists at all for a test-run step, independent of whether the run itself
 * passed/failed - "the process exited" and "we can trust what it reported" are separate questions.
 *  - `complete`: the JSON report parsed successfully.
 *  - `missing-report`: the report file could not be read (2026-08-24 real finding: this happened on
 *    every one of the first four cal.com test-run steps - never silently treated as zero tests).
 *  - `malformed-report`: a report file existed but failed to parse as the expected shape.
 */
export type ObservabilityStatus = "complete" | "missing-report" | "malformed-report";

export interface TestRunResult {
  command: string[];
  exitCode: number | null;
  timedOut: boolean;
  wallMs: number;
  /** Parsed from the reporter's JSON output when available; undefined if the reporter never wrote one
   * (e.g. the process crashed before producing output) - never fabricated. */
  files?: number;
  tests?: number;
  passed?: number;
  failed?: number;
  failedTests?: string[];
  /** Last ~8000 chars of the process's own accumulated stdout/stderr (via the sandbox SDK's
   * getProcessLogs, 2026-08-24 - previously never captured for any startProcess-based step). This is
   * the audit trail when the structured report is missing or malformed: what the test runner actually
   * printed, kept regardless of whether the structured report parsed. */
  stdoutTail?: string;
  stderrTail?: string;
  observabilityStatus: ObservabilityStatus;
}

/**
 * Execution-selection invariant (2026-08-24): distinguishes "DiffCI asked for N specific test files" from
 * "the test runner actually ran N specific test files" - a static selection is not evidence of what a
 * black-box test command actually executed. Computed only for a *selected* invocation (never full),
 * comparing `requestedTestFiles` against the parsed report's own executed file list.
 *  - `HONORED_EXACTLY`: the executed file set equals the requested file set exactly.
 *  - `HONORED_WITH_FRAMEWORK_EXPANSION`: every requested file executed, plus some additional files the
 *    runner/framework required (e.g. a shared setup file counted as its own "test file") - the request
 *    was not ignored, just not the exact boundary.
 *  - `IGNORED_OR_BROADENED`: the executed file count is far larger than requested (a strong signal the
 *    filter had no effect and the full/near-full suite ran instead).
 *  - `UNMEASURABLE`: no structured report exists to compare against - never guessed from wall time alone.
 */
export type SelectionHonoredStatus = "HONORED_EXACTLY" | "HONORED_WITH_FRAMEWORK_EXPANSION" | "IGNORED_OR_BROADENED" | "UNMEASURABLE";

export interface RuntimeSelectionEvidence {
  requestedTestFiles: string[];
  /** Distinct file paths actually reflected in the parsed report's failedTests/summary evidence, when
   * derivable; undefined when the report doesn't expose per-file identity DiffCI's parser can read. */
  executedTestFilesKnown: boolean;
  testFilesExecuted?: number;
  totalTestsExecuted?: number;
  status: SelectionHonoredStatus;
  explanation: string;
}

export interface MutationInfo {
  /** The single file mutated: the first non-test source file the merge changed, restored to its exact
   * pre-merge (base) content. See mutation.ts for why "whole-file revert to base" was chosen over
   * synthetic hunk mutation - it is the most historically grounded, simplest-to-audit mutation for a
   * real historical merge, and generalizes to any repository/merge without per-PR authoring. */
  path: string;
  applied: boolean;
  skippedReason?: string; // e.g. "file did not exist at base (newly added)"
}

export interface ExecutionRecord {
  runId: string;
  repository: string;
  mergeSha: string;
  baseSha: string;
  prNumber: number | null;
  subject: string;
  step: ExecutionStep;
  shape: string;
  tarballKey: string;
  tarballSha256: string;
  frozenManifestKey: string;
  engineChecksum: string;
  /** Undefined until either the caller supplied it or the `deriving-selection` step fills it in - never
   * defaulted to an empty array, so "not yet derived" and "derived, zero tests selected" stay distinct. */
  selectedTestPaths?: string[];
  totalTestsInGraph?: number;
  analysisOverheadMs?: number;
  /** See ExecutionSpec.testArgvOverride - carried through verbatim when present. */
  testArgvOverride?: string[];
  /** Set while a test-run step (full-baseline/selected-baseline/full-mutant/selected-mutant) has an
   * in-flight sandbox process; cleared once that step's result is captured. One field reused across the
   * four steps is safe because they run strictly sequentially, never concurrently - exactly the
   * `ShardRecord.processId` convention analysis-shard-do.ts's `analyze()` step already uses, which lets
   * a step resume-by-polling after a DO eviction instead of re-running the command. */
  processId?: string;
  /** `deps.now()` when the current in-flight process was started - used to compute that step's wallMs
   * once it completes, across however many alarm invocations it took to poll to completion. */
  processStartedAt?: number;
  timings: {
    bootstrapMs?: number;
    cloneMs?: number;
    deriveSelectionMs?: number;
    installMs?: number;
    pretestMs?: number;
  };
  baseline?: { full: TestRunResult; selected: TestRunResult };
  /** Computed right after the selected-baseline test run completes - see RuntimeSelectionEvidence.
   * Economics (gross/net saved) are only meaningful when this is HONORED_EXACTLY or
   * HONORED_WITH_FRAMEWORK_EXPANSION; IGNORED_OR_BROADENED or UNMEASURABLE must not be reported as a
   * savings result. */
  runtimeSelection?: RuntimeSelectionEvidence;
  mutation?: MutationInfo;
  mutant?: { full: TestRunResult; selected: TestRunResult };
  /** Set once both baseline runs exist AND an analysisOverheadMs is available (either caller-supplied
   * or self-derived) - if neither ever materializes, economics stays undefined rather than fabricating
   * a zero overhead. */
  economics?: {
    analysisOverheadMs: number;
    fullTestMs: number;
    selectedTestMs: number;
    grossSavedMs: number;
    netSavedMs: number;
    reductionPct: number | null;
  };
  /** Present once the mutant runs complete. `recall` is only ever computed from a REAL observed
   * mutant failure - never asserted from a passing baseline alone (the task's own anti-vacuity rule). */
  recall?: {
    fullSuiteCaughtMutant: boolean;
    selectedSuiteCaughtMutant: boolean;
    /** True only when fullSuiteCaughtMutant is true; a full-suite miss makes recall unmeasurable, not
     * a false "safe" - reported as such, never silently treated as a selected-suite success. */
    recallMeasurable: boolean;
  };
  lastError?: string;
  errorClass?: string;
  startedAt: number;
  heartbeatAt: number;
  finishedAt?: number;
}
