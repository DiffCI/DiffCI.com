/**
 * Produces the calibration the economic eligibility gate needs, from a repository nobody has studied.
 *
 * The gate models a cost per test file as `fullCpu / testFiles`. Both were previously supplied by hand
 * from a qualification run someone had already read, which works for hono, zod and vue and cannot work
 * for a prospect's repository - the only place the gate is commercially useful.
 *
 * This runs the documented install and the full suite ONCE, measures CPU through the same calibrated
 * primitive every other measurement uses, and reads the test-file count out of the runner's own output.
 *
 * IT REFUSES RATHER THAN GUESSES. If the file count cannot be parsed, or the suite does not exit 0, or
 * CPU cannot be measured, no calibration is emitted. A fabricated denominator would silently rescale
 * every prediction the gate makes afterwards, and a suite that was not green is not a cost baseline.
 *
 * Usage:
 *   npm run calibrate -- --repo <clone> --install "corepack|pnpm|install" \
 *     [--build "corepack|pnpm|build"] [--test-module node_modules/vitest/vitest.mjs] \
 *     [--test-args "run|--project|unit*"] --out calibration.json
 */
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { execBounded, execNodeScript } from "./process-exec.js";
import { classifyExecution, explainExecution } from "./execution-verdict.js";
import { parseTestFileCount, parseTestOutput } from "./test-output-parsers.js";

function main(): void {
  const args = process.argv.slice(2);
  const flag = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const list = (k: string, fallback: string[]): string[] => {
    const v = flag(k);
    return v ? v.split("|") : fallback;
  };

  // Checked as a flag, not by resolving it: `resolve("")` is the current directory, which exists, so a
  // missing --repo would silently calibrate against whatever repository this was invoked from.
  const repoFlag = flag("repo");
  if (!repoFlag) throw new Error("--repo <clone> is required");
  const repoPath = resolve(repoFlag);
  if (!existsSync(repoPath)) throw new Error(`no such repository clone: ${repoPath}`);

  const install = list("install", ["npm", "install", "--no-audit", "--no-fund"]);
  const build = flag("build") ? flag("build")!.split("|") : undefined;
  const testModule = flag("test-module") ?? "node_modules/vitest/vitest.mjs";
  const testArgs = list("test-args", ["run"]);
  const timeoutMs = Number(flag("timeout") ?? 25 * 60_000);

  const step = (name: string, argv: string[]) => {
    const [exec, ...rest] = argv;
    const resolved = process.platform === "win32" && !exec!.endsWith(".cmd") ? `${exec}.cmd` : exec!;
    const r = execBounded(resolved, rest, { cwd: repoPath, timeoutMs, shell: process.platform === "win32" });
    console.log(`  [stage] ${name.padEnd(10)} ${(r.ms / 1000).toFixed(1)}s  exit=${String(r.status)}`);
    return r;
  };

  const installed = step("install", install);
  if (installed.status !== 0) throw new Error(`install failed: ${installed.out.slice(-400)}`);

  if (build) {
    const built = step("build", build);
    if (built.status !== 0) throw new Error(`build failed: ${built.out.slice(-400)}`);
  }

  const started = Date.now();
  const suite = execNodeScript(join(repoPath, testModule), testArgs, { cwd: repoPath, timeoutMs });
  console.log(`  [stage] ${"full suite".padEnd(10)} ${((Date.now() - started) / 1000).toFixed(1)}s  exit=${String(suite.status)}`);

  // The exit status outranks any parsed count - see scripts/execution-verdict.ts. A suite that did not
  // complete cleanly is not a cost baseline, whatever its output says.
  const parsed = parseTestOutput(suite.out);
  const verdict = classifyExecution(suite.status, parsed.failures);
  if (verdict !== "GREEN") {
    throw new Error(`calibration suite is not green: ${explainExecution(suite.status, parsed.failures)}`);
  }

  const testFiles = parseTestFileCount(suite.out);
  if (testFiles === undefined) {
    throw new Error(
      "could not read a test-file count from the runner's output. Refusing to emit a calibration: a " +
        "guessed denominator would silently rescale every prediction made from it.",
    );
  }
  if (suite.cpuSeconds === undefined) {
    throw new Error("CPU could not be measured (no /proc). Calibration must be produced in the canonical Linux environment.");
  }

  const calibration = {
    producedAt: new Date().toISOString(),
    repoPath,
    commands: { install, build, testModule, testArgs },
    fullCpuSeconds: suite.cpuSeconds,
    fullWallMs: suite.ms,
    testFiles,
    cpuPerFile: suite.cpuSeconds / testFiles,
    framework: parsed.framework,
    platform: `${process.platform} node ${process.version}`,
  };

  const out = flag("out");
  if (out) writeFileSync(resolve(out), `${JSON.stringify(calibration, null, 2)}\n`);

  console.log(`\n  full CPU     ${calibration.fullCpuSeconds.toFixed(2)} CPU-s`);
  console.log(`  test files   ${testFiles}   (read from the runner, not supplied)`);
  console.log(`  CPU/file     ${calibration.cpuPerFile.toFixed(4)} CPU-s`);
  console.log(`  framework    ${parsed.framework ?? "unknown"}\n`);
}

main();
