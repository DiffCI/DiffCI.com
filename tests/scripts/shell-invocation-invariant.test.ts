/**
 * THE INVARIANT: no child process receiving repository-controlled or path-derived arguments may
 * execute through a shell.
 *
 * Promoted from "a bug we keep hitting" to an enforced rule after four occurrences - three found by
 * failure (the agent build, the package inspector, the dogfood harness) and one by audit (the
 * execution-validation script, which passes test file paths discovered inside a cloned repository
 * straight through `shell: true` on Windows).
 *
 * Four is not bad luck. `shell: true` is unavoidable on Windows for `.cmd` shims - npm, npx and
 * corepack are all batch files, and Node refuses to spawn them directly since CVE-2024-27980 - so the
 * option keeps reappearing legitimately, and each time it does, the argument model silently changes
 * from execve to string concatenation.
 *
 * This test cannot tell which arguments are path-derived, so it does not try. It enforces the
 * procedure instead: every file that opts into a shell must also call `assertShellSafeArgs`, which
 * turns silent corruption into a loud refusal. A new shell spawn therefore fails here until someone
 * has thought about it.
 */
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { describe, it } from "node:test";

import { assertShellSafeArgs, findShellUnsafeArgument, ShellSafetyError } from "../../scripts/shell-safety.js";

const repoRoot = join(dirname(import.meta.filename), "..", "..");
const SEARCH_ROOTS = ["src", "scripts"];

/** Matches an actual `shell:` spawn option, not the word appearing in prose or in generated YAML. */
const SHELL_OPTION = /(^|[\s{,])shell:\s*(true|process\.platform === "win32"|isWin)\b/;

function sourceFiles(dir: string): string[] {
  const absolute = join(repoRoot, dir);
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules") continue;
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.(ts|mts|cts|mjs|cjs|js)$/.test(full)) found.push(full);
    }
  };
  walk(absolute);
  return found;
}

/** Strips comments so prose describing the hazard is not mistaken for the hazard. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("shell-invocation invariant", () => {
  it("every file that spawns through a shell also guards its arguments", () => {
    const offenders: string[] = [];

    for (const root of SEARCH_ROOTS) {
      for (const file of sourceFiles(root)) {
        const code = stripComments(readFileSync(file, "utf8"));
        if (!SHELL_OPTION.test(code)) continue;
        if (code.includes("assertShellSafeArgs")) continue;
        offenders.push(relative(repoRoot, file).replace(/\\/g, "/"));
      }
    }

    assert.deepEqual(
      offenders,
      [],
      "these files spawn a child process through a shell without calling assertShellSafeArgs():\n  " +
        offenders.join("\n  ") +
        "\nEither avoid the shell (prefer a Node API over a CLI, and cwd-relative arguments over absolute paths)\n" +
        "or call assertShellSafeArgs() immediately before the spawn. See scripts/shell-safety.ts.",
    );
  });

  it("refuses the exact argument that broke each of the four call sites", () => {
    // Real values, not synthetic ones: every string here corrupted a real spawn on this machine.
    const realFailures = [
      "--outfile=C:\\Users\\Swati Kale\\OneDrive\\Desktop\\DiffCI.com\\dist-agent\\index.mjs",
      "C:\\Users\\Swati Kale\\OneDrive\\Desktop\\DiffCI.com\\dist-agent\\diffci-observer-0.1.0.tgz",
      "packages/my package/src/thing.test.ts",
    ];
    for (const arg of realFailures) {
      assert.throws(() => assertShellSafeArgs([arg], "test"), ShellSafetyError, `"${arg}" must be refused`);
    }
  });

  it("allows the argument shapes the fixes produce", () => {
    // Each fix removed the hazard rather than escaping it: relative paths, and fixed literals.
    assert.doesNotThrow(() => assertShellSafeArgs(["install", "--no-audit", "./agent.tgz"], "test"));
    assert.doesNotThrow(() => assertShellSafeArgs(["pack", "--json"], "test"));
    assert.doesNotThrow(() => assertShellSafeArgs(["wrangler", "d1", "execute", "diffci-product", "--remote", "--file=src/ingest/cloudflare/schema.sql"], "test"));
  });

  it("ENGINE_COVERAGE_01 item 1: an npm --before=<ISO-8601 cutoff> argument is shell-safe, verified not assumed", () => {
    // src/ci-inference/infer.ts appends this flag to a genuine npm install operation's argv. Its own
    // implementation plan (docs/engine-coverage-01-item-1-implementation-plan.md §5.4) claims this stays
    // on the shell-safe path because an ISO-8601 timestamp shares no character with SHELL_METACHARACTERS
    // - asserted here as a real test, not left as a comment's claim.
    const cutoffs = ["2026-09-01T08:25:03Z", "2026-07-26T14:51:09Z", "2026-01-01T00:00:00.000Z"];
    for (const cutoff of cutoffs) {
      const arg = `--before=${cutoff}`;
      assert.equal(findShellUnsafeArgument([arg]), undefined, `"${arg}" must stay on the shell-safe path`);
      assert.doesNotThrow(() => assertShellSafeArgs(["install", arg], "ci-reproduction inference arm"));
    }
  });

  it("catches every character a shell would reinterpret, not only spaces", () => {
    // A space is the one that actually bit, which makes the others easy to forget.
    for (const hostile of ["a&b", "a|b", "a>b", "a<b", "a;b", "a$b", "a`b", "a(b", "a*b", "a?b", 'a"b', "a'b", "a\\b", "a\tb"]) {
      assert.equal(findShellUnsafeArgument([hostile]), hostile, `"${hostile}" must be treated as shell-unsafe`);
    }
  });

  it("names the call site in the refusal, so a failure says which spawn refused", () => {
    try {
      assertShellSafeArgs(["with space"], "build-agent: npm pack");
      assert.fail("expected a refusal");
    } catch (error) {
      assert.match((error as Error).message, /build-agent: npm pack/);
      assert.match((error as Error).message, /shell-safety/);
    }
  });
});
