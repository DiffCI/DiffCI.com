/**
 * What a command's execution actually established, from the two signals available.
 *
 * THE INVARIANT (2026-08-29, learned from a real false green):
 *
 *   A process's exit status is authoritative for whether execution succeeded. Parsed framework output
 *   provides classification detail and CANNOT override a non-zero exit.
 *
 * TanStack/query was qualified as "suite green on 2 consecutive runs" by a harness that read
 * `Tests 2 passed (2)` and ignored that nx had exited 1 after reporting
 * "Running target test:lib for 26 projects and 9 tasks they depend on failed". The parser was not
 * wrong about the line it read - it read the FIRST summary, which for an orchestrator is one project's
 * result, not the run's. One verdict away from admitting a repository whose baseline was never green
 * into the safety corpus, where every classification derived from it afterwards would have rested on
 * that baseline.
 *
 * WHY THE CONTRADICTION IS NOT RESOLVED INTO A FAILURE COUNT. When the exit status says "failed" and
 * the readable summary says "zero failures", the honest answer is not to invent a number for how many
 * tests failed - it is that this output cannot be trusted to describe the whole run. Inferring a count
 * would be manufacturing the very thing the evidence does not contain.
 *
 * WHY THIS WILL MATTER BEYOND TESTS. A CI task is increasingly an orchestrator - nx, turbo, bazel,
 * gradle, maven, a shell pipeline - with leaf tools underneath it. The orchestration layer's success or
 * failure is part of the safety boundary, and leaf-tool output can never be more authoritative than the
 * process that executed the task. Nothing is built on that here; the principle is recorded where it was
 * learned.
 */

export type ExecutionVerdict =
  /** Exited cleanly and the readable summary agrees: nothing failed. */
  | "GREEN"
  /** Something failed, and the output says how much. */
  | "RED"
  /** The process failed but the readable summary claims nothing did. Refuse; do not infer a count. */
  | "CONTRADICTORY_EXECUTION_EVIDENCE"
  /** No summary could be read at all. Never zero - "could not tell" is not "nothing failed". */
  | "UNREADABLE";

/**
 * `exitStatus` is `null` when a process was killed by a signal or a timeout - which is a failure to
 * complete, never a success, and is treated as non-zero throughout.
 */
export function classifyExecution(exitStatus: number | null, parsedFailures: number | undefined): ExecutionVerdict {
  if (parsedFailures === undefined) return "UNREADABLE";

  const exitedCleanly = exitStatus === 0;

  // A positive failure count is self-consistent with any non-zero exit, and is informative even if the
  // process also died afterwards. Report what failed.
  if (parsedFailures > 0) return "RED";

  if (exitedCleanly) return "GREEN";

  return "CONTRADICTORY_EXECUTION_EVIDENCE";
}

/** Only a GREEN execution may contribute a green baseline. Everything else refuses, for its own reason. */
export function isGreenExecution(exitStatus: number | null, parsedFailures: number | undefined): boolean {
  return classifyExecution(exitStatus, parsedFailures) === "GREEN";
}

/** The sentence recorded against a refusal, so a reader sees which of the two signals disagreed. */
export function explainExecution(exitStatus: number | null, parsedFailures: number | undefined): string {
  switch (classifyExecution(exitStatus, parsedFailures)) {
    case "GREEN":
      return `exited 0 with 0 parsed failures`;
    case "RED":
      return `${parsedFailures} test(s) failed (exit ${String(exitStatus)})`;
    case "CONTRADICTORY_EXECUTION_EVIDENCE":
      return `CONTRADICTORY_EXECUTION_EVIDENCE: the runner exited ${String(exitStatus)} but the summary this harness could read reported 0 failures. The output cannot be trusted to describe the whole run - typically an orchestrator reporting per project. Refusing to infer a failure count from it.`;
    case "UNREADABLE":
      return `no failure count could be read from the runner's output (exit ${String(exitStatus)})`;
  }
}
