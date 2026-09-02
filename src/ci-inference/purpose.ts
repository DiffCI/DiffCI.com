/**
 * What an operation is FOR, derived from structure rather than from text that happens to contain a
 * framework's name.
 *
 * CI_REPRODUCTION_SAMPLE_01 produced two false TEST classifications on two unrelated repositories, from
 * the same rule (`infer.ts:63`, `/\b(jest|vitest|mocha|ava)\b/` applied to the whole command line):
 *
 *   gh issue close $ISSUE --comment "…https://github.com/jestjs/jest/blob/…"   → classified TEST
 *   git apply test/patches/jest-worker+30.4.1.patch                            → classified TEST
 *
 * One is an issue-closing command, the other applies a patch. In both the executable is not a test
 * runner at all; a *substring* of an argument was. So DiffCI planned an issue-triage job as jest's test
 * pipeline, and a Deno runtime job as webpack's.
 *
 * The rule this file replaces it with:
 *
 *   **Incidental text may not establish purpose. Only the executable position, or a script the
 *   repository itself declares, may.**
 *
 * Evidence strength is explicit, because "we recognised a command" and "we guessed from a filename" are
 * different claims and only one of them should license a plan.
 */

/** How a purpose was established. Ordered strongest first; `NONE` means nothing established it. */
export type PurposeBasis =
  /** The binary being invoked is a test runner / compiler / linter. The strongest signal available. */
  | "EXECUTABLE_POSITION"
  /** `npm run x` where the repository's own `scripts.x` body resolves to a recognised command. */
  | "SCRIPT_BODY"
  /** `npm run x` where `x` is declared by the repository and its NAME is conventional (`test:*`). */
  | "SCRIPT_NAME"
  | "NONE";

export type OperationPurpose = "install" | "build" | "lint" | "typecheck" | "test" | "security" | "generate" | "unknown";

export interface PurposeVerdict {
  purpose: OperationPurpose;
  basis: PurposeBasis;
  /** What was actually looked at, so a receipt can show the derivation rather than assert it. */
  evidence: string;
}

/** Shell operators that end one command and begin another. */
const COMMAND_SEPARATOR = /\s*(?:\|\||&&|\||;)\s*/;

/**
 * The tokens of the FIRST command on a line, even when the line as a whole is not safe argv.
 *
 * This is the layering rule made concrete: `yarn cover:integration:a --ci … || yarn … -f` cannot become
 * safe argv, and webpack's integration job therefore lost its TEST purpose entirely — 31 job instances
 * reporting `provides: ["INSTALL"]` while the real suite ran 57,666 tests. Failing to build argv is a
 * statement about the EXECUTOR. It must not delete what the step is for.
 */
export function firstCommandTokens(line: string): string[] {
  const [first = ""] = line.trim().split(COMMAND_SEPARATOR);
  return first.split(/\s+/).filter(Boolean);
}

/** `node_modules/.bin/jest` and `./scripts/x.js` reduce to `jest` and `x.js`. */
function basename(token: string): string {
  const cleaned = token.replace(/\\/g, "/");
  return cleaned.slice(cleaned.lastIndexOf("/") + 1);
}

/** Runners invoked directly. Matched against the EXECUTABLE, never against arguments. */
const EXECUTABLE_PURPOSE: Array<[RegExp, OperationPurpose]> = [
  [/^(jest|vitest|mocha|ava|jasmine|tap|karma|cypress|playwright)(\.(js|cjs|mjs))?$/i, "test"],
  [/^(tsc|tsgo)$/i, "typecheck"],
  [/^(eslint|biome|oxlint|standard)$/i, "lint"],
  [/^(webpack|rollup|vite|esbuild|tsup|parcel)$/i, "build"],
];

/** Package managers whose next tokens name a script rather than a program. */
const PACKAGE_MANAGER = /^(npm|yarn|pnpm|bun|corepack)$/i;

const INSTALL_SUBCOMMAND = /^(ci|install|i|add|up|upgrade)$/i;

/** Script NAMES the ecosystem uses conventionally. Acceptable only for a script the repo declares. */
const SCRIPT_NAME_PURPOSE: Array<[RegExp, OperationPurpose]> = [
  [/^test(:|$)/i, "test"],
  [/^(unit|e2e|spec|jest|vitest|mocha)$/i, "test"],
  [/^(build|compile|bundle|prepack|prepare)(:|$)/i, "build"],
  [/^(lint|eslint)(:|$)/i, "lint"],
  [/^(typecheck|tsc|types|check-types)(:|$)/i, "typecheck"],
  [/^(generate|codegen|prebuild)(:|$)/i, "generate"],
  [/^(audit|security)(:|$)/i, "security"],
];

/**
 * Commands that execute another command, contributing no purpose of their own.
 *
 * `nyc --reporter=json jest --ci` is a TEST operation; the coverage wrapper is bookkeeping around the
 * runner. Stopping at `nyc` is how webpack's `cover:integration:a` body would still have looked
 * purposeless after the substring rule was removed — the defect would have survived its own fix.
 */
const COMMAND_WRAPPER = /^(nyc|c8|istanbul|cross-env|dotenv|env-cmd|retry|nice|time|xvfb-run)$/i;

/** An interpreter whose first non-flag argument is the real program. */
const INTERPRETER = /^(node|npx|bunx|deno|ts-node|tsx)$/i;

/** `KEY=value` prefixes, as `cross-env` and bare shell assignments both produce. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Subcommands a wrapper takes before the program it wraps, e.g. `istanbul cover mocha`. */
const WRAPPER_SUBCOMMAND = /^(cover|exec|run)$/i;

/**
 * Walks past wrappers, interpreters, flags and assignments to the token that is really being run.
 *
 * Only ever advances while the tokens so far are *recognised* wrappers, interpreters or their
 * subcommands. It never scans arbitrary arguments — that is precisely the substring behaviour being
 * removed, and `git apply …jest-worker.patch` stops dead at `git` because `git` is not a wrapper.
 */
function executableChain(tokens: string[]): string[] {
  const chain: string[] = [];
  let afterWrapper = false;
  for (let i = 0; i < tokens.length && chain.length < 4; i += 1) {
    const token = tokens[i]!;
    if (token.startsWith("-") || ASSIGNMENT.test(token)) continue;
    const name = basename(token);
    if (afterWrapper && WRAPPER_SUBCOMMAND.test(name)) continue;
    chain.push(token);
    const isWrapper = COMMAND_WRAPPER.test(name) || INTERPRETER.test(name);
    if (!isWrapper) break;
    afterWrapper = true;
  }
  return chain;
}

function purposeOfExecutable(token: string): OperationPurpose | undefined {
  const name = basename(token);
  for (const [pattern, purpose] of EXECUTABLE_PURPOSE) if (pattern.test(name)) return purpose;
  return undefined;
}

/**
 * Resolves what a line is for.
 *
 * `lookupScript` returns the body of a script the repository declares, or undefined. It is injected so
 * this module never touches the filesystem and can be tested exhaustively.
 *
 * `depth` bounds script-to-script recursion; a cycle yields `unknown` rather than hanging.
 */
export function purposeOfLine(line: string, lookupScript: (name: string) => string | undefined, depth = 0): PurposeVerdict {
  const tokens = firstCommandTokens(line);
  if (tokens.length === 0) return { purpose: "unknown", basis: "NONE", evidence: "empty command" };

  const [head, ...rest] = tokens as [string, ...string[]];

  // Walk past coverage wrappers and interpreters: `nyc … jest`, `node ./node_modules/.bin/jest --ci`.
  for (const candidate of executableChain(tokens)) {
    const direct = purposeOfExecutable(candidate);
    if (direct) return { purpose: direct, basis: "EXECUTABLE_POSITION", evidence: `executable \`${basename(candidate)}\`` };
  }

  if (PACKAGE_MANAGER.test(basename(head))) {
    // `yarn`, `npm ci`, `yarn add -D webpack@5`, `yarn up @babel/*@^7` — dependency operations.
    //
    // A package manager with NO non-flag argument is a bare install: `yarn` and `yarn --immutable` both
    // install, which is how jest and babel-loader begin. Requiring a subcommand missed them.
    const sub = rest.find((t) => !t.startsWith("-"));
    if (sub === undefined || INSTALL_SUBCOMMAND.test(sub)) {
      return { purpose: "install", basis: "EXECUTABLE_POSITION", evidence: `\`${[basename(head), sub].filter(Boolean).join(" ")}\`` };
    }

    // `npm run x` / `yarn x` — the script name, then the script's own body.
    const scriptName = rest.filter((t) => !t.startsWith("-")).find((t) => t !== "run");
    if (scriptName) {
      const body = lookupScript(scriptName);
      if (body !== undefined && depth < 5) {
        const nested = purposeOfLine(body, lookupScript, depth + 1);
        if (nested.purpose !== "unknown") {
          return { purpose: nested.purpose, basis: "SCRIPT_BODY", evidence: `script \`${scriptName}\` → ${nested.evidence}` };
        }
      }
      // The repository declares this script, so its NAME is the repository's own statement of intent.
      // Only ever consulted for a script that exists - a name alone proves nothing about a script that
      // does not.
      if (body !== undefined) {
        for (const [pattern, purpose] of SCRIPT_NAME_PURPOSE) {
          if (pattern.test(scriptName)) return { purpose, basis: "SCRIPT_NAME", evidence: `declared script named \`${scriptName}\`` };
        }
      }
    }
  }

  return { purpose: "unknown", basis: "NONE", evidence: `no recognised executable or declared script in \`${tokens.slice(0, 3).join(" ")}\`` };
}

/**
 * May this verdict license a plan?
 *
 * `SCRIPT_NAME` is admitted because the repository declared that script itself. `NONE` never is — and
 * the substring rule that produced both of the sample's false positives cannot even be expressed here,
 * because no basis corresponds to "the text mentioned a framework somewhere".
 */
export function establishesPurpose(verdict: PurposeVerdict): boolean {
  return verdict.purpose !== "unknown" && verdict.basis !== "NONE";
}
