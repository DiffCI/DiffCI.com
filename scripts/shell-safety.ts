/**
 * THE INVARIANT (promoted 2026-08-27, after three independent occurrences):
 *
 *     No child process receiving repository-controlled or path-derived arguments may execute
 *     through a shell.
 *
 * `shell: true` changes the argument model from execve semantics - an argv array the OS receives
 * verbatim - to string concatenation, where a space splits one argument into two and `&`, `|`, `^`,
 * `>` and friends become operators. On Windows that is not optional: `npm.cmd`, `npx.cmd` and
 * `corepack.cmd` are batch shims, and Node >=18.20/20.12 refuses to spawn them directly
 * (CVE-2024-27980), so any code invoking them needs a shell.
 *
 * Three places got this wrong before it was named, all with the same symptom and none caught by
 * review: the agent build (esbuild `--outfile=C:\...\Swati Kale\...`), the package inspector (`tar`),
 * and the dogfood harness (`npm install <absolute .tgz path>`). A fourth was found by audit rather
 * than by failure: the execution-validation script passes repository-derived TEST FILE PATHS through
 * a shell, which would corrupt silently on any repository with a space in a path.
 *
 * Two ways to satisfy the invariant, in order of preference:
 *
 *   1. Do not use a shell. Prefer a library's Node API over its CLI, and prefer arguments that are
 *      relative to `cwd` over absolute paths.
 *   2. Where a shell is unavoidable, call `assertShellSafeArgs()` first. Silent corruption becomes a
 *      loud refusal, which is the same fail-closed posture the rest of this codebase takes.
 */

/** Anything a POSIX shell or cmd.exe treats as other than a literal character. */
const SHELL_METACHARACTERS = /[\s&|<>^"'`$();!*?[\]{}~#\\]/;

export class ShellSafetyError extends Error {
  constructor(
    message: string,
    public readonly argument: string,
  ) {
    super(message);
    this.name = "ShellSafetyError";
  }
}

/**
 * Throws if any argument would be reinterpreted by a shell. Call this immediately before any
 * `spawnSync`/`execFileSync` with `shell: true`.
 *
 * `context` names the call site so the failure says which spawn refused and why, rather than leaving
 * someone to guess from a stack trace.
 */
export function assertShellSafeArgs(args: readonly string[], context: string): void {
  for (const arg of args) {
    if (SHELL_METACHARACTERS.test(arg)) {
      throw new ShellSafetyError(
        `${context}: refusing to pass "${arg}" through a shell - it contains a character a shell would reinterpret. ` +
          `Pass it relative to cwd, or invoke the tool without a shell. See scripts/shell-safety.ts.`,
        arg,
      );
    }
  }
}

/** Non-throwing form, for callers that want to degrade rather than abort. */
export function findShellUnsafeArgument(args: readonly string[]): string | undefined {
  return args.find((arg) => SHELL_METACHARACTERS.test(arg));
}

export { SHELL_METACHARACTERS };
