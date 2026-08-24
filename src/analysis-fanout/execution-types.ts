/**
 * Types for execution validation (2026-08-24): a NEW capability of the analysis-fanout Worker, sibling
 * to (not a replacement for) the existing analyze-mode ShardRecord/AnalysisShard state machine. Where
 * analyze mode runs the FROZEN DiffCI engine (never modified) to produce a selection verdict, execute
 * mode takes an already-produced verdict for ONE merge and actually runs the TARGET repository's own
 * install/build/test commands - full suite and DiffCI-selected subset - then applies one generic,
 * repo-agnostic mutation (see mutation.ts) to prove failure-detection recall is not vacuous.
 *
 * This never touches the frozen engine (src/repo/*, src/git/*, scripts/diffci-benchmark-external.ts,
 * scripts/diffci-blind-baseline.ts) - it consumes an engine result as input.
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
  /** DiffCI's own selected test file paths for this merge (from a prior analyze-mode result) - the
   * exact set execution validation is trying to prove correct, never recomputed here. */
  selectedTestPaths: string[];
  totalTestsInGraph: number;
  /** The prior analyze-mode row's own measured analysis wall time (ms) for this exact merge - threaded
   * through verbatim, never re-measured here (execution and analysis are separately timed; combining
   * them silently would misreport "analysis overhead" as whatever this DO happens to take). */
  analysisOverheadMs: number;
}

export type ExecutionStep =
  | "bootstrapping"
  | "cloning"
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
  stderrTail?: string;
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
  selectedTestPaths: string[];
  totalTestsInGraph: number;
  analysisOverheadMs: number;
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
    installMs?: number;
    pretestMs?: number;
  };
  baseline?: { full: TestRunResult; selected: TestRunResult };
  mutation?: MutationInfo;
  mutant?: { full: TestRunResult; selected: TestRunResult };
  /** Set once both baseline and mutant runs exist. `analysisOverheadMs` is threaded in from the prior
   * analyze-mode result that produced `selectedTestPaths` - never re-measured here (execution and
   * analysis are separately timed, per the task's own rule against combining them silently). */
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
