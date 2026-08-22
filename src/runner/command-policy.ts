/**
 * R2 structured execution + command policy (Parts 3, 4, 5). Replaces R1's `eval "$CMD"` bootstrap
 * pattern entirely - no repository workload command is ever built by string concatenation or
 * interpreted via `eval`/`bash -c`/nested `sh -c`.
 *
 * Platform reality, disclosed: the underlying @cloudflare/sandbox SDK's exec()/startProcess() only
 * accept a command STRING - there is no execve(argv[])-style RPC exposed by the platform itself (grep
 * confirmed: BaseExecOptions/ExecOptions/ProcessOptions all take `command: string`, no `args: string[]`
 * variant exists). Given that real constraint, "structured execution" is implemented as: build an
 * ExecutionCommand from validated {executable, args, cwd}, run it through buildSafeShellCommand() (a
 * single, textbook-correct POSIX single-quote escape - literally the standard technique this problem
 * class has one true fix for), and PASS THAT to the shell exactly once. No `eval`, no re-parsing, no
 * nested shell. Every character in an argument's VALUE is treated as an inert literal by the shell
 * (single quotes disable ALL special meaning in POSIX sh except for a single quote itself, which is
 * escaped by closing/re-opening the quote - see shellQuoteArg's own tests for the adversarial proof).
 *
 * For the REAL repository workload specifically (not this module), R2 goes one step further and avoids
 * shell involvement entirely for the actual customer-workload spawn via Node's own
 * child_process.spawn(executable, argsArray, {...}) with no `shell: true` - a genuine, textbook
 * execve()-semantics call with zero shell parsing of any kind. See ops/runner-agent/workload-runner.js.
 * This module (command-policy.ts) is the shared, pure, unit-testable POLICY layer both the Node
 * workload-runner and (for the acquisition phase, which still runs inside the bash agent script) the
 * shell-quoting path are validated against.
 */

export interface ExecutionCommand {
  executable: string;
  args: string[];
  cwd?: string;
}

// R2 Part 4: deliberately restrictive. Only what the ONE controlled experiment needs - `npx` added
// alongside node/npm/git specifically to invoke this repo's own local `tsx` test runner without a
// global install; nothing else is permitted.
export const ALLOWED_EXECUTABLES: ReadonlySet<string> = new Set(["node", "npm", "npx", "git"]);

export type CommandPolicyViolation =
  | "executable_not_allowed"
  | "null_byte_in_argument"
  | "null_byte_in_executable"
  | "empty_executable"
  | "path_traversal_in_cwd";

export interface CommandValidationResult {
  ok: boolean;
  violation?: CommandPolicyViolation;
  detail?: string;
}

/** Never inspects argument CONTENT for "looks dangerous" patterns (Part 5's own point: injection
 * payloads must be neutralized by construction, not detected by a blocklist of substrings, which is
 * always incomplete). The only content-level rejections are structural impossibilities (null bytes -
 * C-string command lines cannot represent them at all) - everything else is a valid, safe argument
 * VALUE once quoted, no matter how shell-metacharacter-heavy it looks. */
export function validateCommand(command: ExecutionCommand): CommandValidationResult {
  if (!command.executable) return { ok: false, violation: "empty_executable" };
  if (command.executable.includes("\0")) return { ok: false, violation: "null_byte_in_executable" };
  if (!ALLOWED_EXECUTABLES.has(command.executable)) {
    return { ok: false, violation: "executable_not_allowed", detail: `"${command.executable}" is not in the R2 allowlist (${[...ALLOWED_EXECUTABLES].join(", ")})` };
  }
  for (const arg of command.args) {
    if (arg.includes("\0")) return { ok: false, violation: "null_byte_in_argument" };
  }
  if (command.cwd && (command.cwd.includes("\0") || /(^|\/)\.\.(\/|$)/.test(command.cwd))) {
    return { ok: false, violation: "path_traversal_in_cwd", detail: `cwd "${command.cwd}" contains a ".." path segment or a null byte` };
  }
  return { ok: true };
}

/** The one, textbook-correct way to embed an arbitrary string as a single, literal shell word:
 * wrap in single quotes, and replace every literal single quote in the value with '\'' (close quote,
 * escaped literal quote, reopen quote). No character in `value` - not `;`, `&&`, `$()`, backticks, `|`,
 * `>`, `*`, whitespace, or a newline - has any special meaning to the shell once quoted this way. */
export function shellQuoteArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a single shell command line from a validated ExecutionCommand. Throws (does not silently
 * degrade) if `command` fails validateCommand() - callers must validate first, but this is a real,
 * enforced backstop, not just documentation.
 */
export function buildSafeShellCommand(command: ExecutionCommand): string {
  const validation = validateCommand(command);
  if (!validation.ok) throw new Error(`refusing to build a shell command for a policy-violating ExecutionCommand: ${validation.violation}${validation.detail ? ` (${validation.detail})` : ""}`);
  const invocation = [shellQuoteArg(command.executable), ...command.args.map(shellQuoteArg)].join(" ");
  return command.cwd ? `cd ${shellQuoteArg(command.cwd)} && ${invocation}` : invocation;
}
