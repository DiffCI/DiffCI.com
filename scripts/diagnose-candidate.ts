/**
 * One candidate, fully instrumented: where does the time go, and where does the selection become empty?
 *
 * WHY THIS EXISTS. `se-prettier-04` spent 4h11m observing 25 candidates - about 601 seconds each against
 * a full suite that runs in 214 - and produced zero non-empty selective decisions. Two failures, and
 * neither is diagnosable from a funnel: an aggregate "graph = 480s" cannot distinguish one expensive
 * traversal from 1,557 cheap ones, and a final verdict of FULL cannot say at which boundary the
 * candidate set collapsed.
 *
 * IT MEASURES, IT DOES NOT OPTIMISE. Nothing in the analyser is touched. Multiplicity is captured by
 * wrapping the analyser's DEPENDENCIES - `typescript`, `node:fs`, `node:child_process` - before the
 * pipeline is imported, so the behaviour recorded is exactly the behaviour of the current commit. If an
 * obviously repeated operation shows up while reading this output, it is NOT to be fixed in the same
 * pass: a clean before-state is the whole point, and diagnosis entangled with treatment yields neither.
 *
 * Every expensive operation is reported as {calls, totalMs, maxMs} plus cardinalities, because the
 * question is not "how long did the graph take" but "did something that should happen once happen once".
 *
 * Usage:
 *   npm run diagnose:candidate -- --repo <clone> [--base <sha>] [--head <sha>] [--out trace.json]
 */
import { createRequire } from "node:module";

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

interface OpStat {
  calls: number;
  totalMs: number;
  maxMs: number;
  /** Distinct first-argument values, when they are strings - how many different files, not how many reads. */
  distinct?: Set<string>;
}

// ESM has no require, and the counters must patch the very modules the analyser will import.
const require = createRequire(import.meta.url);

const STATS = new Map<string, OpStat>();

function record(name: string, ms: number, key?: unknown): void {
  let stat = STATS.get(name);
  if (!stat) {
    stat = { calls: 0, totalMs: 0, maxMs: 0, distinct: new Set() };
    STATS.set(name, stat);
  }
  stat.calls += 1;
  stat.totalMs += ms;
  if (ms > stat.maxMs) stat.maxMs = ms;
  // Bounded: a million distinct paths would cost more memory than the measurement is worth.
  if (typeof key === "string" && stat.distinct && stat.distinct.size < 50_000) stat.distinct.add(key);
}

/** Wraps one method in place. The wrapper only times; arguments and return value pass through untouched. */
function wrap(host: Record<string, any>, method: string, label: string, keyOf?: (args: any[]) => unknown): void {
  const original = host[method];
  if (typeof original !== "function") return;
  host[method] = function instrumented(this: unknown, ...args: any[]) {
    const t0 = process.hrtime.bigint();
    try {
      return original.apply(this, args);
    } finally {
      record(label, Number(process.hrtime.bigint() - t0) / 1e6, keyOf ? keyOf(args) : undefined);
    }
  };
}

function installCounters(): void {
  // TypeScript first - the prime suspect for work proportional to tests x graph.
  try {
    const ts = require("typescript");
    wrap(ts, "createProgram", "typescript.createProgram");
    wrap(ts, "createSourceFile", "typescript.createSourceFile", (a) => a[0]);
    wrap(ts, "parseJsonConfigFileContent", "typescript.parseJsonConfigFileContent");
    wrap(ts, "readConfigFile", "typescript.readConfigFile", (a) => a[0]);
    wrap(ts, "parseConfigFileTextToJson", "typescript.parseConfigFileTextToJson", (a) => a[0]);
    wrap(ts, "createCompilerHost", "typescript.createCompilerHost");
    wrap(ts, "preProcessFile", "typescript.preProcessFile");
    wrap(ts, "resolveModuleName", "typescript.resolveModuleName", (a) => `${a[0]}`);
    if (ts.sys) {
      wrap(ts.sys, "readFile", "typescript.sys.readFile", (a) => a[0]);
      wrap(ts.sys, "readDirectory", "typescript.sys.readDirectory", (a) => a[0]);
      wrap(ts.sys, "fileExists", "typescript.sys.fileExists", (a) => a[0]);
    }
  } catch {
    // Absent typescript is itself a finding, and the run continues so the rest is still measured.
  }

  const fs = require("node:fs");
  wrap(fs, "readFileSync", "fs.readFileSync", (a) => String(a[0]));
  wrap(fs, "readdirSync", "fs.readdirSync", (a) => String(a[0]));
  wrap(fs, "statSync", "fs.statSync", (a) => String(a[0]));
  wrap(fs, "lstatSync", "fs.lstatSync", (a) => String(a[0]));
  wrap(fs, "existsSync", "fs.existsSync", (a) => String(a[0]));
  wrap(fs, "realpathSync", "fs.realpathSync", (a) => String(a[0]));

  const cp = require("node:child_process");
  wrap(cp, "spawnSync", "child_process.spawnSync", (a) => `${a[0]} ${(a[1] ?? []).slice(0, 2).join(" ")}`);
  wrap(cp, "execFileSync", "child_process.execFileSync", (a) => `${a[0]} ${(a[1] ?? []).slice(0, 2).join(" ")}`);
  wrap(cp, "execSync", "child_process.execSync", (a) => String(a[0]).slice(0, 60));
}

interface PhaseResult<T> {
  value: T;
  wallMs: number;
  cpuMs: number;
  rssMb: number;
}

async function phase<T>(name: string, fn: () => T | Promise<T>): Promise<PhaseResult<T>> {
  const c0 = process.cpuUsage();
  const t0 = process.hrtime.bigint();
  const value = await fn();
  const wallMs = Number(process.hrtime.bigint() - t0) / 1e6;
  const c1 = process.cpuUsage(c0);
  const cpuMs = (c1.user + c1.system) / 1000;
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  console.log(`  [phase] ${name.padEnd(22)} wall ${wallMs.toFixed(0).padStart(8)} ms   cpu ${cpuMs.toFixed(0).padStart(8)} ms   rss ${rssMb.toFixed(0)} MB`);
  return { value, wallMs, cpuMs, rssMb };
}

function flag(args: string[], key: string): string | undefined {
  const i = args.indexOf(`--${key}`);
  return i !== -1 ? args[i + 1] : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoPath = resolve(flag(args, "repo") ?? "");
  if (!flag(args, "repo")) throw new Error("--repo <clone> is required");

  installCounters();

  // Imported AFTER the counters are installed, so the analyser's own module-load work is counted too.
  const { classifyTypeScriptProject, buildDependencyGraph } = await import("../src/repo/graph.js");
  const { analyzeGitDelta } = await import("../src/git/git-diff.js");
  const { ImpactAnalyzer } = await import("../src/repo/impact.js");
  const { runPathBaseline } = await import("../src/planner/path-baseline.js");

  const head = flag(args, "head") ?? execFileSync("git", ["-C", repoPath, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const base = flag(args, "base") ?? execFileSync("git", ["-C", repoPath, "rev-parse", `${head}~1`], { encoding: "utf8" }).trim();

  console.log(`\n  CANDIDATE TRACE`);
  console.log(`  repo: ${repoPath}`);
  console.log(`  base: ${base}`);
  console.log(`  head: ${head}\n`);

  const wholeCpu0 = process.cpuUsage();
  const wholeT0 = process.hrtime.bigint();

  const eligibility = await phase("eligibility", () => classifyTypeScriptProject(repoPath));
  if (!eligibility.value.capable) {
    console.log(`\n  REFUSED at eligibility: ${eligibility.value.reason}\n`);
    return;
  }

  const delta = await phase("gitDelta", async () => analyzeGitDelta({ baseSha: base, headSha: head, repoPath }));
  const deltaResult = delta.value;
  if (!deltaResult.success) {
    console.log(`\n  REFUSED at delta: ${deltaResult.error}\n`);
    return;
  }
  // Narrowed once, here, so every use below is the success shape rather than a non-null assertion.
  const gitDelta = deltaResult.delta;

  const graph = await phase("graphBuild", async () =>
    buildDependencyGraph({ repoPath, excludeDirs: ["node_modules", ".git", "dist", "build", "coverage"] }),
  );

  const impact = await phase("impactAnalysis", () =>
    new ImpactAnalyzer().analyze(gitDelta, graph.value, graph.value.profile, {
      repositoryFiles: deltaResult.inventory?.files,
    } as never),
  );

  const baseline = await phase("pathBaseline", () =>
    runPathBaseline(graph.value.profile.testFilePaths, gitDelta.files, graph.value.profile),
  );

  const wholeWallMs = Number(process.hrtime.bigint() - wholeT0) / 1e6;
  const wholeCpu = process.cpuUsage(wholeCpu0);
  const wholeCpuMs = (wholeCpu.user + wholeCpu.system) / 1000;

  const i = impact.value;
  const profile = graph.value.profile;

  console.log(`\n  NARROWING FUNNEL - where the candidate set becomes what it is\n`);
  const line = (label: string, value: unknown) => console.log(`    ${label.padEnd(34)} ${String(value)}`);
  line("changed files", gitDelta.files.length);
  line("graph nodes", graph.value.graph.nodes.length);
  line("graph edges", graph.value.graph.edges.length);
  line("graph confidence (raw)", graph.value.confidence);
  line("graph confidence (effective)", i.effectiveGraphConfidence);
  line("affected source files", i.affectedSourceFiles.length);
  line("affected assets", i.affectedAssets.length);
  line("affected entry points", i.affectedEntryPoints.length);
  line("test universe", profile.testFilePaths.length);
  line("affected tests (mapped)", i.affectedTests.length);
  line("analysis status", i.analysisStatus);
  line("fallbackRequired", i.fallbackRequired);
  line("FINAL decision", i.fallbackRequired ? "FULL" : "SELECTIVE");
  line("FINAL selected tests", i.fallbackRequired ? profile.testFilePaths.length : i.affectedTests.length);
  line("comparator selected", baseline.value.selectedTests.length);
  if (i.fallbackReasons.length > 0) {
    console.log(`\n    fallback reasons:`);
    for (const reason of i.fallbackReasons.slice(0, 20)) console.log(`      - ${reason}`);
  }
  if (i.riskSignals.length > 0) {
    console.log(`\n    risk signals:`);
    for (const signal of i.riskSignals.slice(0, 20)) console.log(`      - [${signal.level}] ${signal.reason}`);
  }

  console.log(`\n  OPERATION MULTIPLICITY - calls first, time second\n`);
  console.log(`    ${"operation".padEnd(38)} ${"calls".padStart(9)} ${"totalMs".padStart(10)} ${"maxMs".padStart(9)} ${"distinct".padStart(9)}`);
  const rows = [...STATS.entries()].sort((a, b) => b[1].totalMs - a[1].totalMs);
  for (const [name, stat] of rows) {
    console.log(
      `    ${name.padEnd(38)} ${String(stat.calls).padStart(9)} ${stat.totalMs.toFixed(0).padStart(10)} ${stat.maxMs.toFixed(1).padStart(9)} ${String(stat.distinct?.size ?? "-").padStart(9)}`,
    );
  }

  console.log(`\n  TOTALS\n`);
  line("wall", `${(wholeWallMs / 1000).toFixed(1)} s`);
  line("cpu (user+system)", `${(wholeCpuMs / 1000).toFixed(1)} s`);
  line("cpu / wall", (wholeCpuMs / wholeWallMs).toFixed(2));
  line("peak rss", `${(process.memoryUsage().rss / 1024 / 1024).toFixed(0)} MB`);
  console.log(
    `\n  Read the ratio first: cpu ~ wall means a computational/scaling problem; cpu << wall means\n` +
      `  filesystem, subprocess or waiting. Then read the calls column: an operation that should happen\n` +
      `  once and happens once per test is a multiplicity bug whatever the ratio says.\n`,
  );

  const out = flag(args, "out");
  if (out) {
    writeFileSync(
      resolve(out),
      `${JSON.stringify(
        {
          repoPath,
          base,
          head,
          producedAt: new Date().toISOString(),
          platform: `${process.platform} node ${process.version}`,
          note: "NON-CANONICAL developer-host diagnostic. Valid for decision trace and operation multiplicity; not for economics.",
          phases: {
            eligibility: { wallMs: eligibility.wallMs, cpuMs: eligibility.cpuMs },
            gitDelta: { wallMs: delta.wallMs, cpuMs: delta.cpuMs },
            graphBuild: { wallMs: graph.wallMs, cpuMs: graph.cpuMs },
            impactAnalysis: { wallMs: impact.wallMs, cpuMs: impact.cpuMs },
            pathBaseline: { wallMs: baseline.wallMs, cpuMs: baseline.cpuMs },
          },
          totals: { wallMs: wholeWallMs, cpuMs: wholeCpuMs, rssMb: process.memoryUsage().rss / 1024 / 1024 },
          funnel: {
            changedFiles: gitDelta.files.length,
            graphNodes: graph.value.graph.nodes.length,
            graphEdges: graph.value.graph.edges.length,
            graphConfidenceRaw: graph.value.confidence,
            graphConfidenceEffective: i.effectiveGraphConfidence,
            affectedSourceFiles: i.affectedSourceFiles.length,
            affectedAssets: i.affectedAssets.length,
            affectedEntryPoints: i.affectedEntryPoints.length,
            testUniverse: profile.testFilePaths.length,
            affectedTests: i.affectedTests.length,
            analysisStatus: i.analysisStatus,
            fallbackRequired: i.fallbackRequired,
            finalDecision: i.fallbackRequired ? "FULL" : "SELECTIVE",
            finalSelectedTests: i.fallbackRequired ? profile.testFilePaths.length : i.affectedTests.length,
            comparatorSelected: baseline.value.selectedTests.length,
            fallbackReasons: i.fallbackReasons,
            riskSignals: i.riskSignals.map((s: any) => ({ level: s.level, reason: s.reason })),
          },
          operations: Object.fromEntries(
            rows.map(([name, stat]) => [name, { calls: stat.calls, totalMs: Math.round(stat.totalMs), maxMs: Math.round(stat.maxMs), distinct: stat.distinct?.size ?? null }]),
          ),
        },
        null,
        2,
      )}\n`,
    );
    console.log(`  trace written to ${resolve(out)}\n`);
  }
}

void main();
