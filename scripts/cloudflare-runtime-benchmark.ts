/**
 * Stage 1B runtime experiment - PILOT (2026-08-21, docs/research/2026-08-21-stage1b-*.md). Measures
 * REAL wall-clock test-EXECUTION time (not analysis time - Stage 0/1A already measured that) for
 * FULL / PATH / DiffCI-selected test subsets on an already-cloned, already-checked-out repository,
 * using vitest directly (bypassing any composite "test" script that also runs lint/typecheck, which
 * would dilute the comparison with identical fixed costs across all three conditions).
 *
 * Deliberately scoped as a pilot on ONE small, fast, vitest-based repository (unjs/defu) rather than a
 * broad multi-repo/multi-runner harness - see the report this produces for why, and for the concrete
 * next steps to generalize this to more repositories and test runners.
 *
 * Runs on Cloudflare Sandbox Containers, NOT real GitHub Actions runners - a genuine, stated
 * environmental difference from Stage 1A's own runtime-experiment design (which called for GitHub
 * Actions for validity), used here because triggering real Actions runs on a third-party repository
 * requires write access this environment does not have. Real, measured wall-clock time either way -
 * just not on GitHub's specific shared-runner hardware/contention profile.
 *
 * Usage: npx tsx scripts/cloudflare-runtime-benchmark.ts --owner <o> --name <n> --base-sha <sha>
 *        --head-sha <sha> --workspace <path> --repetitions <n> [--out <path>]
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDiffCIAnalysis } from "../src/research/diffci/adapter.js";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { analyzeRepository } from "../src/repo/analyzer.js";
import { buildGenericTaskRegistry } from "../src/research/baseline/registry.js";
import { parseRepositoryWorkflows } from "../src/research/baseline/workflow-parser.js";
import { runPathBaseline } from "../src/planner/path-baseline.js";
import type { CommitDelta } from "../src/research/types.js";

function parseArgs(argv: string[]) {
  const args: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg?.startsWith("--")) args[arg.slice(2)] = argv[++i] ?? "";
  }
  return args;
}

function execSyncSafe(cmd: string): { success: boolean; tail: string } {
  try {
    const out = execSync(cmd, { timeout: 60_000, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { success: true, tail: out.slice(-2000) };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { success: false, tail: ((err.stdout ?? "") + (err.stderr ?? "") || err.message || "").slice(-2000) };
  }
}

function timedExec(cmd: string, cwd: string, timeoutMs: number): { wallMs: number; success: boolean; tail: string } {
  const start = Date.now();
  try {
    const out = execSync(cmd, { cwd, timeout: timeoutMs, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return { wallMs: Date.now() - start, success: true, tail: out.slice(-2000) };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    return { wallMs: Date.now() - start, success: false, tail: ((err.stdout ?? "") + (err.stderr ?? "") || err.message || "").slice(-2000) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const owner = args.owner;
  const name = args.name;
  const baseSha = args["base-sha"];
  const headSha = args["head-sha"];
  const workspace = resolve(args.workspace ?? "/workspace");
  const repetitions = Math.max(1, Number.parseInt(args.repetitions ?? "3", 10) || 3);
  const outPath = resolve(args.out ?? `${workspace}/runtime-result.json`);

  if (!owner || !name || !baseSha || !headSha) {
    console.error("Usage: --owner <o> --name <n> --base-sha <sha> --head-sha <sha> --workspace <path> [--repetitions <n>] [--out <path>]");
    process.exit(1);
  }

  const repoPath = `${workspace}/repos/${owner}--${name}`;
  if (!existsSync(repoPath)) {
    console.error(JSON.stringify({ ok: false, error: `${repoPath} not cloned - this script does not clone, see the Worker route that calls it` }));
    process.exit(1);
  }

  // Checkout headSha into the actual working tree - unlike the pure analysis pipeline (which never
  // needs this, per the Stage 1A valtio-anomaly finding), REAL test execution genuinely requires the
  // real file content on disk to match, so this is the one place in the whole research pipeline a
  // checkout is both necessary and correct.
  execSync(`git checkout --force --quiet ${headSha}`, { cwd: repoPath });
  execSync(`git clean -fdx --quiet`, { cwd: repoPath });

  // The sandbox base image ships node/npm/git (verified in prepareContainer) but not pnpm - self-heal
  // via corepack (bundled with modern Node) rather than assuming it's present, the same "verify, don't
  // assume, self-heal loudly" pattern prepareContainer already uses for git/node/npm.
  const pnpmCheck = execSyncSafe("pnpm --version");
  if (!pnpmCheck.success) {
    const corepackAttempt = execSyncSafe("corepack enable && corepack prepare pnpm@latest --activate");
    let recheck = execSyncSafe("pnpm --version");
    let tail = corepackAttempt.tail;
    if (!recheck.success) {
      // corepack itself is missing on this base image (not just inactive) - fall back to a plain
      // global npm install, the most portable option across minimal container images.
      const npmAttempt = execSyncSafe("npm install -g pnpm");
      recheck = execSyncSafe("pnpm --version");
      tail += npmAttempt.tail;
    }
    if (!recheck.success) {
      writeFileSync(outPath, JSON.stringify({ ok: false, stage: "pnpm-setup", tail: (tail + recheck.tail).slice(-2000) }), "utf8");
      console.log(JSON.stringify({ ok: false, stage: "pnpm-setup" }));
      return;
    }
  }

  const installStart = Date.now();
  const installResult = timedExec("pnpm install --frozen-lockfile", repoPath, 180_000);
  const installMs = Date.now() - installStart;
  if (!installResult.success) {
    writeFileSync(outPath, JSON.stringify({ ok: false, stage: "install", tail: installResult.tail }), "utf8");
    console.log(JSON.stringify({ ok: false, stage: "install" }));
    return;
  }

  // Determine FULL / PATH / DiffCI test selections for this exact delta - reusing the real production
  // pipeline, not reimplementing selection logic for this experiment.
  const gitResult = await analyzeGitDelta({ repoPath, baseSha, headSha });
  if (!gitResult.success) throw new Error(`git delta failed: ${gitResult.error}`);
  const identity: CommitDelta = {
    repository: `${owner}/${name}`, baseSha, headSha,
    logicalDeltaKey: `${owner}/${name}:${baseSha}:${headSha}:runtime-pilot:stage1b`,
    experimentId: "stage1b-runtime-pilot", diffCiVersion: "runtime-pilot", schemaVersion: "stage1b-runtime-pilot-1",
    category: "unknown", gitDelta: gitResult.delta,
  };
  const profile = analyzeRepository({ repoPath, excludeDirs: ["node_modules", ".next", "dist", "build", "target", "coverage", ".cache"] });
  const parsedWorkflows = parseRepositoryWorkflows(profile, repoPath);
  const taskRegistry = buildGenericTaskRegistry(profile, "typescript", parsedWorkflows);
  const analysis = await runDiffCIAnalysis({ repoPath, commitDelta: identity, taskRegistry, timeoutMs: 180_000 });
  const pathBaseline = runPathBaseline(analysis.profile.testFilePaths, gitResult.delta.files);

  const fullTests = analysis.profile.testFilePaths;
  const pathTests = pathBaseline.selectedTests;
  const diffciTests = analysis.plan.selectedTests;

  function runCondition(name: string, files: string[]): { name: string; testCount: number; runs: { wallMs: number; success: boolean }[] } {
    const runs: { wallMs: number; success: boolean }[] = [];
    for (let i = 0; i < repetitions; i++) {
      const fileArgs = files.map((f) => `"${f}"`).join(" ");
      const cmd = files.length > 0 ? `npx vitest run ${fileArgs} --no-color` : `echo "no tests selected - nothing to run"`;
      const result = timedExec(cmd, repoPath, 120_000);
      runs.push({ wallMs: result.wallMs, success: files.length === 0 ? true : result.success });
    }
    return { name, testCount: files.length, runs };
  }

  const conditions = {
    FULL: runCondition("FULL", fullTests),
    PATH: runCondition("PATH", pathTests),
    DiffCI: runCondition("DiffCI", diffciTests),
  };

  writeFileSync(outPath, JSON.stringify({
    ok: true, owner, name, baseSha, headSha,
    installMs,
    diffciAnalysisOverheadMs: analysis.timing.totalDiffCiOverheadMs,
    fullTestCount: fullTests.length, pathTestCount: pathTests.length, diffciTestCount: diffciTests.length,
    conditions,
  }, null, 2), "utf8");
  console.log(JSON.stringify({ ok: true, outPath, fullTestCount: fullTests.length, pathTestCount: pathTests.length, diffciTestCount: diffciTests.length }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  process.exit(1);
});
