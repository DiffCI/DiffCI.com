/**
 * R2 job-spec construction (Parts 10, 11, 14) - builds the real ExecutionCommand[] sequence
 * workload-runner.cjs executes: acquisition (clone + exact-SHA verification) -> dependency install ->
 * the one pre-registered test command. Every step goes through src/runner/command-policy.ts's
 * validateCommand() before being included - this function refuses to build a spec containing a
 * policy-violating step rather than silently including one workload-runner.cjs would reject anyway.
 */
import { validateCommand, type ExecutionCommand } from "./command-policy.js";

export interface R2JobSpecInput {
  cloneUrl: string; // public, credential-free clone URL (src/runner/repository-policy.ts)
  commitSha: string; // full 40-hex-char SHA, already verified against the real GitHub API before this is ever called
  workspaceDir: string; // e.g. /workspace/job-<opaque-id> (Part 7)
  /** Optional steps that must run before acquisition (e.g. installing a package manager not already
   * present) - still individually policy-validated like every other step. */
  setupSteps?: ExecutionCommand[];
  installCommand: ExecutionCommand; // Part 14 - the safest supported install invocation for this repo
  testCommand: ExecutionCommand; // the ONE pre-registered, harmless test command (Part 28/29)
}

export interface BuildR2JobStepsResult {
  ok: boolean;
  steps?: (ExecutionCommand & { expectedStdout?: string })[];
  error?: string;
}

export function buildR2JobSteps(input: R2JobSpecInput): BuildR2JobStepsResult {
  const allSteps: ExecutionCommand[] = [...(input.setupSteps ?? []), { executable: "git", args: ["clone", "--depth", "1", input.cloneUrl, input.workspaceDir] }, input.installCommand, input.testCommand];
  for (const step of allSteps) {
    const validation = validateCommand(step);
    if (!validation.ok) return { ok: false, error: `step "${step.executable} ${step.args.join(" ")}" failed policy: ${validation.violation}${validation.detail ? ` (${validation.detail})` : ""}` };
  }

  const steps: (ExecutionCommand & { expectedStdout?: string })[] = [
    ...(input.setupSteps ?? []),
    { executable: "git", args: ["clone", "--depth", "1", input.cloneUrl, input.workspaceDir] },
    // Part 11: real, in-container verification - `git rev-parse HEAD`'s stdout must exactly equal the
    // pre-registered, pre-verified SHA. A mismatch aborts the sequence before install/test ever runs
    // (workload-runner.cjs's expectedStdout mechanism), regardless of the clone command's own exit code.
    { executable: "git", args: ["rev-parse", "HEAD"], cwd: input.workspaceDir, expectedStdout: input.commitSha },
    input.installCommand,
    input.testCommand,
  ];
  return { ok: true, steps };
}
