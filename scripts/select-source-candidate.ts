/**
 * Pick one ordinary source-change candidate by mechanical rule, BEFORE any analyser result is seen.
 *
 * The previous Prettier trace landed on a Renovate lockfile bump, which the safety policy correctly
 * widened to FULL - a correct decision that says nothing about whether selection works. Choosing the
 * next candidate by hand after seeing which ones go SELECTIVE would be cherry-picking, so the filter
 * is written down here, applied to history in order, and the FIRST match wins.
 *
 * The rules are the user's, transcribed without addition:
 *   - modifies at least one ordinary implementation source file
 *   - does NOT modify package.json, lockfiles, tsconfig/jest/config or other known global-risk files
 *   - is not dependency automation
 *   - is not test-only
 *   - small: 1-5 implementation files changed
 *   - A1 (2026-08-30): at least one implementation file inside the comparator's execution scope
 *
 * Usage: npm run select:candidate -- --repo <clone> [--limit 400]
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const SOURCE_EXTENSIONS = /\.(js|mjs|cjs|jsx|ts|mts|cts|tsx)$/;

/** Files whose change triggers a critical global risk signal, which is what widened the last candidate. */
const GLOBAL_RISK = [
  /^package\.json$/,
  /(^|\/)package\.json$/,
  /(^|\/)(yarn\.lock|package-lock\.json|pnpm-lock\.yaml|bun\.lockb)$/,
  /(^|\/)tsconfig[^/]*\.json$/,
  /(^|\/)(jest|vitest|babel|rollup|webpack|eslint|prettier)\.config\.[^/]+$/,
  /(^|\/)\.yarnrc\.yml$/,
  /^\.github\//,
  /(^|\/)\.[^/]*rc(\.[^/]+)?$/,
];

/** Prettier keeps implementation under src/ and tests under tests/; test files are excluded either way. */
function isTestPath(path: string): boolean {
  return /(^|\/)(tests?|__tests__)\//.test(path) || /\.(test|spec)\.[^/]+$/.test(path) || /jsfmt\.spec\./.test(path);
}

/**
 * An ordinary implementation source file, in any `src/` directory rather than only the repository's.
 *
 * This read `path.startsWith("src/")` until 2026-08-30, which was shaped by the only repository it had
 * been used on. Prettier keeps its implementation in a root `src/`; a monorepo keeps it in
 * `packages/<name>/src/`, so the filter matched NOTHING across 298 typescript-eslint commits and
 * reported "no candidate" for a repository with hundreds of ordinary source changes.
 *
 * Widened before any DiffCI result for any typescript-eslint candidate had been produced - the
 * ordering matters, and it is preserved: this is a filter that could not match, not a threshold moved
 * because the answer was inconvenient.
 */
function isImplementationSource(path: string): boolean {
  return /(^|\/)src\//.test(path) && SOURCE_EXTENSIONS.test(path) && !isTestPath(path);
}

function isGlobalRisk(path: string): boolean {
  return GLOBAL_RISK.some((re) => re.test(path));
}

/**
 * Paths the full-suite comparator does not execute (COMPUTE_PROOF_V1 amendment A1).
 *
 * A change confined to a package the comparator excludes has ZERO optimisation opportunity by
 * construction: if no test for that package runs, there is no test compute for DiffCI to avoid, and
 * the experiment measures nothing about DiffCI. Passed in per repository rather than hard-coded,
 * because the exclusion is a property of that repository's own test command.
 */
function isOutsideComparatorScope(path: string, excludedScopes: readonly string[]): boolean {
  return excludedScopes.some((scope) => path === scope || path.startsWith(`${scope}/`));
}

const DEPENDENCY_AUTOMATION = /^(update dependency|update .* to v|lock file maintenance|chore\(deps\)|build\(deps\))/i;

function main(): void {
  const args = process.argv.slice(2);
  const flagOf = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const repo = resolve(flagOf("repo") ?? "");
  if (!flagOf("repo")) throw new Error("--repo <clone> is required");
  const limit = Number(flagOf("limit") ?? 400);
  // A1: paths the comparator does not execute, comma-separated. Empty means the comparator covers
  // the whole repository, which was true of Prettier and is why this did not exist before.
  const excludedScopes = (flagOf("exclude-scope") ?? "").split(",").map((s2) => s2.trim()).filter(Boolean);
  // MECHANISM_PROOF_01 needs five candidates rather than one. The RULE is unchanged - still the first
  // matches in history order - only how many of them are taken. One successful mutant establishes
  // existence but is fragile; a single lucky selection is not a mechanism.
  const count = Number(flagOf("count") ?? 1);
  const trace = args.includes("--trace");
  // MECHANISM_ISOLATION_01: the eligible shape is "changed implementation, ZERO changed tests". The
  // only addition to the frozen filter, declared in the protocol before the pool was enumerated.
  const requireNoTestEdit = args.includes("--no-test-edit");

  const git = (...a: string[]): string => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const shas = git("rev-list", `--max-count=${limit}`, "HEAD").trim().split("\n");

  console.log(`\n  SOURCE-CANDIDATE SELECTION - first match in history order wins\n`);
  console.log(`  scanning ${shas.length} commits from HEAD\n`);

  let examined = 0;
  let drawn = 0;
  for (const sha of shas) {
    const parents = git("rev-list", "--parents", "-n", "1", sha).trim().split(/\s+/).slice(1);
    if (parents.length !== 1) continue; // merges have no single base
    const base = parents[0]!;
    const subject = git("log", "-1", "--format=%s", sha).trim();
    const files = git("diff", "--name-only", `${base}..${sha}`).trim().split("\n").filter(Boolean);
    if (files.length === 0) continue;
    examined += 1;

    const implementation = files.filter(isImplementationSource);
    const outOfScope = implementation.filter((f) => isOutsideComparatorScope(f, excludedScopes));
    const risky = files.filter(isGlobalRisk);
    const tests = files.filter(isTestPath);

    const rejections: string[] = [];
    if (implementation.length === 0) rejections.push("no implementation source file changed");
    if (implementation.length > 5) rejections.push(`${implementation.length} implementation files - over the 1-5 bound`);
    if (risky.length > 0) rejections.push(`global-risk file(s): ${risky.slice(0, 4).join(", ")}`);
    if (DEPENDENCY_AUTOMATION.test(subject)) rejections.push("dependency automation");
    if (tests.length === files.length) rejections.push("test-only change");
    if (requireNoTestEdit && tests.length > 0) rejections.push(`changes ${tests.length} test file(s) - outside the isolation shape`);
    if (implementation.length > 0 && outOfScope.length === implementation.length) {
      rejections.push(`A1: every implementation file is outside the comparator's scope (${outOfScope.slice(0, 3).join(", ")})`);
    }

    // --trace records the WHOLE traversal, not only the matches. Added 2026-08-31 after the
    // generation-C candidate universe was already drawn, so it cannot influence any selection: the
    // rejections were always computed, they were simply never printed, which left "why was this commit
    // not a candidate?" unanswerable from the artefact.
    if (rejections.length > 0) {
      if (trace) console.log(`    - ${sha.slice(0, 9)}  REJECTED  ${rejections.join("; ")}   [${subject.slice(0, 60)}]`);
      continue;
    }
    if (trace) console.log(`    + ${sha.slice(0, 9)}  MATCH     [${subject.slice(0, 60)}]`);

    drawn += 1;
    console.log(`  CANDIDATE ${drawn} of ${count} - selected after examining ${examined} commit(s)\n`);
    console.log(`    head     ${sha}`);
    console.log(`    base     ${base}`);
    console.log(`    subject  ${subject}`);
    console.log(`\n    why it qualified:`);
    console.log(`      implementation files changed  ${implementation.length}  (1-5 required)`);
    for (const f of implementation) console.log(`        ${f}`);
    console.log(`      test files also changed       ${tests.length}  (not test-only)`);
    for (const f of tests.slice(0, 6)) console.log(`        ${f}`);
    console.log(`      global-risk files             0  (none of package.json, lockfiles, tsconfig, configs, .github)`);
    console.log(`      dependency automation         no`);
    console.log(
      `      A1 comparator scope           ${excludedScopes.length === 0 ? "whole repository" : `excluded: ${excludedScopes.join(", ")}`}`,
    );
    console.log(`      total files in diff           ${files.length}`);
    console.log(`\n  Recorded BEFORE any analyser result for this candidate was produced.\n`);
    if (drawn >= count) return;
  }

  console.log(
    `  ${drawn === 0 ? "NO CANDIDATE" : `ONLY ${drawn} of ${count} candidates`} matched the filter in ${examined} examined commit(s).\n`,
  );
}

main();
