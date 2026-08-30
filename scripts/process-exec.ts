/**
 * The one place this harness starts a child process.
 *
 * WHY IT IS SHARED WITH THE CALIBRATION TESTS. `zod-qualify-01` ran for three hours inside a stage the
 * harness believed it had bounded at twenty-five minutes. Calibration tests that call `spawnSync`
 * themselves would establish how Node behaves; they would not establish how THIS HARNESS behaves,
 * because a parallel implementation can differ in exactly the option that matters. Qualification and
 * calibration therefore go through this function and no other:
 *
 *     qualification  ->  execBounded  <-  calibration
 *
 * If a bound does not hold here, both the experiment and the test that checks the experiment are
 * affected identically, which is the only arrangement in which the test is worth running.
 */
import { spawnSync } from "node:child_process";

import { cpuSecondsBetween, readChildCpuTicks } from "./compute-usage.js";

/**
 * Environment for every child process this harness spawns.
 *
 * COREPACK_ENABLE_DOWNLOAD_PROMPT is the one that mattered. Corepack asks for confirmation before
 * downloading a package manager it does not yet have cached; spawned with no usable stdin, that prompt
 * fails and the install dies. TanStack/query was recorded as "install failed" for this reason while the
 * identical command succeeded by hand against a warm cache - a spurious disqualification that would
 * have removed the most structurally interesting repository from the corpus.
 *
 * CI=1 keeps runners non-interactive and out of watch mode. FORCE_COLOR=0 asks for uncoloured output,
 * though it is not sufficient on its own - vitest colourises under CI regardless, which defeated the
 * output parsers until they learned to strip ANSI. The parsers no longer depend on this being obeyed.
 */
export const NON_INTERACTIVE_ENV = {
  CI: "1",
  FORCE_COLOR: "0",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  npm_config_yes: "true",
} as const;

export interface BoundedExecResult {
  /** null when the process was killed by a signal or the timeout - a failure to complete, never success. */
  status: number | null;
  /** stdout and stderr concatenated, which is what the output parsers read. */
  out: string;
  /** Kept separate as well, because a runner that dies rather than reports puts the reason on stderr. */
  stdout: string;
  stderr: string;
  /** Wall time actually taken. Compared against the bound by the calibration suite. */
  ms: number;
  /** True when the process was killed for exceeding `timeoutMs`. */
  timedOut: boolean;
  /** The signal that killed it, when one did. */
  signal: string | null;
  /**
   * CPU-seconds this process tree actually consumed, or undefined where it cannot be measured.
   *
   * Undefined rather than 0: "could not tell" and "consumed nothing" are different facts, and treating
   * the first as the second understates cost in the direction that flatters DiffCI.
   */
  cpuSeconds?: number;
}

export interface BoundedExecOptions {
  cwd?: string;
  timeoutMs: number;
  /**
   * Only ever true for fixed literal argv. Repository-derived arguments must never reach a shell -
   * see scripts/shell-safety.ts for the invariant and the four separate times it has been violated.
   */
  shell?: boolean;
  env?: Record<string, string>;
}

/**
 * Run one command with a wall-clock bound, capturing everything it printed.
 *
 * The bound is enforced by `spawnSync`'s own `timeout`, which kills the direct child. Whether that
 * bounds a process TREE - a child that outlives its parent while holding the stdio pipe - is
 * platform-dependent and is asserted by the calibration suite rather than assumed here.
 */
export function execBounded(command: string, argv: string[], options: BoundedExecOptions): BoundedExecResult {
  const started = Date.now();
  const cpuBefore = readChildCpuTicks();
  const result = spawnSync(command, argv, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    shell: options.shell ?? false,
    env: { ...process.env, ...NON_INTERACTIVE_ENV, ...(options.env ?? {}) },
  });

  const cpuAfter = readChildCpuTicks();

  return {
    status: result.status,
    cpuSeconds: cpuSecondsBetween(cpuBefore, cpuAfter),
    out: `${result.stdout ?? ""}${result.stderr ?? ""}`,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ms: Date.now() - started,
    // Node reports ETIMEDOUT on the error object when it killed the child for exceeding `timeout`.
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    signal: result.signal ?? null,
  };
}

/** Run a JS entry point under this same Node binary. The shape every test runner is invoked through. */
export function execNodeScript(scriptPath: string, argv: string[], options: BoundedExecOptions): BoundedExecResult {
  return execBounded(process.execPath, [scriptPath, ...argv], { ...options, shell: false });
}
