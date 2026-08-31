/**
 * Universe sanity — the discovery half of apparatus qualification (Step 4, 2026-08-31).
 *
 * `dogfood:qualify` proves a repository INSTALLS, BUILDS and runs GREEN reproducibly. It says nothing
 * about whether DiffCI's model of the test universe matches the runner's, which is exactly what
 * defect 17 got wrong — and got wrong invisibly, for the whole MECHANISM_PROOF_01 experiment.
 *
 * So this asserts, in the canonical environment and against the real pinned tree:
 *
 *   1. the universe resolves to the EXPECTED count (ts-jest b1a97ac4 -> 20, jest's own testMatch);
 *   2. no path under a forbidden prefix (e2e/, examples/, presets/, scripts/, website/) enters it;
 *   3. repeated discovery yields the IDENTICAL paths, not merely the same count;
 *   4. an intentionally half-understood config FAILS WIDE rather than silently narrowing.
 *
 * (4) is the one that matters most. The asymmetry it protects:
 *     uncertainty -> over-inclusion -> wasted compute
 *     mistaken narrowing -> omitted executable test -> potential FALSE GREEN
 *
 * It REFUSES on any mismatch. A qualification pass that reports a discrepancy and exits 0 is how an
 * apparatus defect becomes an experimental result.
 *
 * Executes no test suite and mutates nothing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { analyzeRepository } from "../src/repo/analyzer.js";
import { discoverTestRunnerConfigs } from "../src/repo/test-discovery.js";

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

function flagOf(args: string[], key: string): string | undefined {
  const i = args.indexOf(`--${key}`);
  return i !== -1 ? args[i + 1] : undefined;
}

/** A repository whose config cannot be fully read must keep the WIDE universe. */
function failWideFixture(): Check {
  const root = mkdtempSync(join(tmpdir(), "diffci-failwide-"));
  try {
    const write = (rel: string, content: string): void => {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    };
    write("package.json", `{"name":"half-understood","scripts":{"test":"jest"}}`);
    // The spread cannot be resolved without executing the config, which discovery never does.
    write("jest.config.js", `const extra = require('./globs'); module.exports = { testMatch: ['<rootDir>/src/**/*.spec.ts', ...extra] }`);
    write("src/in-scope.spec.ts", `test("a", () => {});`);
    write("other/out-of-declared-scope.spec.ts", `test("b", () => {});`);

    const discovery = discoverTestRunnerConfigs(root, { test: "jest" });
    const profile = analyzeRepository({ repoPath: root });
    const paths = [...(profile.testFilePaths ?? [])].sort();

    const narrowed = discovery.replacedDefaults || !paths.includes("other/out-of-declared-scope.spec.ts");
    return {
      name: "fail-wide on a half-understood config",
      ok: !narrowed,
      detail: narrowed
        ? `NARROWED on a config it could not fully read (replacedDefaults=${discovery.replacedDefaults}, paths=${JSON.stringify(paths)}). ` +
          `Mistaken narrowing omits an executable test, which is the shape of a false green.`
        : `kept the wide universe (${paths.length} paths) when the declaration could not be fully read`,
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function main(): void {
  const args = process.argv.slice(2);
  const repoPath = resolve(flagOf(args, "repo") ?? "");
  const expected = Number(flagOf(args, "expect-tests") ?? NaN);
  const forbidden = (flagOf(args, "forbid-prefixes") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const outPath = flagOf(args, "out");
  if (!flagOf(args, "repo") || !Number.isInteger(expected)) {
    throw new Error("--repo <clone> and --expect-tests <n> are required");
  }

  const first = analyzeRepository({ repoPath });
  const second = analyzeRepository({ repoPath });
  const paths = [...(first.testFilePaths ?? [])].sort();
  const repeated = [...(second.testFilePaths ?? [])].sort();
  const offending = paths.filter((p) => forbidden.some((prefix) => p === prefix || p.startsWith(`${prefix}/`)));

  const checks: Check[] = [
    {
      name: `universe resolves to exactly ${expected} executable tests`,
      ok: paths.length === expected,
      detail: `found ${paths.length}`,
    },
    {
      name: `no test under ${forbidden.join(", ") || "(none)"} enters the universe`,
      ok: offending.length === 0,
      detail: offending.length === 0 ? "none" : `${offending.length}: ${offending.slice(0, 5).join(", ")}`,
    },
    {
      // Identical PATHS, not merely an identical count. A discovery that returned a different 20 each
      // time would pass a count check and make every selection irreproducible.
      name: "repeated discovery yields the identical paths",
      ok: JSON.stringify(paths) === JSON.stringify(repeated),
      detail: JSON.stringify(paths) === JSON.stringify(repeated) ? "identical" : "DIVERGED between two runs on one tree",
    },
    failWideFixture(),
  ];

  console.log(`\n  UNIVERSE SANITY`);
  console.log(`  repo      ${repoPath}`);
  console.log(`  patterns  ${JSON.stringify(first.testPatterns)}\n`);
  for (const c of checks) console.log(`  ${c.ok ? "PASS" : "FAIL"}  ${c.name}\n        ${c.detail}`);

  const ok = checks.every((c) => c.ok);
  if (outPath) {
    writeFileSync(
      outPath,
      `${JSON.stringify({ ok, repoPath, expected, forbidden, testCount: paths.length, patterns: first.testPatterns, paths, checks }, null, 2)}\n`,
    );
    console.log(`\n  written to ${outPath}`);
  }

  console.log(`\n  ${ok ? "UNIVERSE SANITY PASSED" : "UNIVERSE SANITY FAILED - the analyser is NOT fit to generate new evidence"}\n`);
  if (!ok) process.exit(1);
}

main();
