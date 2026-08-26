/**
 * Repo-agnostic probe (Phase 01, 2026-08-26).
 *
 * PURPOSE. Phase 01's exit criterion is "5 external repositories, 2 test frameworks, zero per-repo
 * code". Before changing anything, this measures where the engine actually stands against real external
 * repositories, stage by stage, and records every point at which it refuses or silently degrades. It is
 * a MEASUREMENT tool: it imports the real engine modules (no reimplementation, no mocks) and never
 * writes to the shadow pipeline, the Worker, or D1.
 *
 * It deliberately runs the full production path in order:
 *
 *   1. eligibility   collectMetadata()          - the gate that excluded vitest-dev/vitest
 *   2. delta         analyzeGitDelta()          - HEAD~1..HEAD on the cloned default branch
 *   3. graph         buildDependencyGraph()     - real ts.Program, real confidence
 *   4. impact        ImpactAnalyzer.analyze()   - selection + fallback
 *   5. discovery     discoverTestRunnerConfigs()- which frameworks the repo declares
 *   6. command       generateSelectiveTestCommandSpecs() - what DiffCI would actually RUN
 *
 * Stage 6 is the one most likely to be wrong in a way unit tests never showed: the engine can select
 * the right vitest files and then emit a `tsx --test` command that would not run them.
 *
 * CLONE LOCATION MATTERS. `createProgram()` calls `ts.findConfigFile(repoPath, ...)`, which walks UP
 * from the repository root and will happily find an ANCESTOR tsconfig.json outside the cloned repo
 * entirely (flagged as a known latent bug in src/research/repository/collector.ts). Cloning under this
 * repository would therefore make every probed repo look like it has a tsconfig. The probe refuses to
 * run in that situation rather than producing quietly wrong numbers.
 *
 * Usage:
 *   npx tsx scripts/repo-agnostic-probe.ts owner/name [owner/name ...] [--out report.json] [--keep]
 *   DIFFCI_PROBE_DIR=/some/path   where clones live (default: <tmp>/diffci-repo-agnostic-probe)
 *   GITHUB_CLONE_TOKEN            optional, for rate limits
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";

import { analyzeGitDelta } from "../src/git/git-diff.js";
import { buildDependencyGraph } from "../src/repo/graph.js";
import { ImpactAnalyzer } from "../src/repo/impact.js";
import { discoverTestRunnerConfigs } from "../src/repo/test-discovery.js";
import { collectMetadata } from "../src/research/repository/collector.js";
import { commandSpecToString, planSelectiveTestCommands } from "../src/planner/test-command.js";
import { runPathBaseline } from "../src/planner/path-baseline.js";
import type { ResearchRepository } from "../src/research/types.js";

const CLONE_DEPTH = 10;
const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build"];

export interface StageOutcome {
  status: "OK" | "REFUSED" | "ERROR" | "SKIPPED";
  detail?: string;
}

export interface ProbeResult {
  repository: string;
  headSha?: string;
  baseSha?: string;
  /** Structural facts about the repository, independent of any engine verdict. */
  shape: {
    rootTsconfig: boolean;
    nestedTsconfigCount: number;
    packageManager: string;
    declaredTestScripts: string[];
    frameworksDeclared: string[];
  };
  stages: {
    clone: StageOutcome;
    eligibility: StageOutcome;
    delta: StageOutcome;
    graph: StageOutcome;
    impact: StageOutcome;
    discovery: StageOutcome;
    command: StageOutcome;
  };
  graph?: {
    nodes: number;
    edges: number;
    sourceNodes: number;
    testNodes: number;
    confidence: string;
    durationMs: number;
  };
  impact?: {
    commitsAnalysed: number;
    fullCount: number;
    selectiveCount: number;
    fallbackReasons: string[];
    affectedSourceFiles: number;
    affectedTests: number;
    analysisStatus: string;
  };
  /** How the PATH baseline - the comparator DiffCI measures savings against - behaved on the same commits. */
  pathBaseline?: { selectiveCount: number; fullCount: number; matchedRules: string[] };
  /** Test files the engine itself discovered (profile.testFilePaths), not what the repo claims. */
  discoveredTestFiles?: number;
  /** The command DiffCI would actually execute for the selected tests, and whether it is plausible
   * for the framework the repository declares. This is the honest end of the chain. */
  emittedCommands?: string[];
  commandFrameworkMismatch?: string;
}

function run(args: string[], cwd: string, timeoutMs = 300_000): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: process.env.GITHUB_CLONE_TOKEN
      ? { ...process.env, GIT_ASKPASS: "echo", GIT_TERMINAL_PROMPT: "0" }
      : { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
}

/** Refuses to probe from a directory that has a tsconfig.json anywhere above it - see the header. */
function assertNoAncestorTsconfig(dir: string): void {
  let current = resolve(dir);
  const seen: string[] = [];
  for (;;) {
    const candidate = join(current, "tsconfig.json");
    if (existsSync(candidate)) seen.push(candidate);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (seen.length > 0) {
    throw new Error(
      `Probe directory ${dir} has ancestor tsconfig.json file(s): ${seen.join(", ")}. ` +
        `ts.findConfigFile() walks upward, so every probed repository would falsely appear to have a ` +
        `tsconfig and the graph would be built against the wrong project. Set DIFFCI_PROBE_DIR to a ` +
        `path with no tsconfig.json above it.`,
    );
  }
}

function countNestedTsconfigs(repoPath: string): number {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--", "*tsconfig.json", "tsconfig.json"],
      { cwd: repoPath, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    return out.split("\n").filter((l) => l.trim().endsWith("tsconfig.json")).length;
  } catch {
    return 0;
  }
}

function readPackageJson(repoPath: string): { scripts: Record<string, string>; devDependencies: Record<string, string>; dependencies: Record<string, string> } {
  const path = join(repoPath, "package.json");
  if (!existsSync(path)) return { scripts: {}, devDependencies: {}, dependencies: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      scripts: (parsed.scripts as Record<string, string>) ?? {},
      devDependencies: (parsed.devDependencies as Record<string, string>) ?? {},
      dependencies: (parsed.dependencies as Record<string, string>) ?? {},
    };
  } catch {
    return { scripts: {}, devDependencies: {}, dependencies: {} };
  }
}

/** What the repository itself says its test framework is - from declared dependencies and the literal
 * text of its test scripts. Detection only; nothing here selects or executes anything. */
const FRAMEWORK_MARKERS: Array<{ name: string; dep: string; scriptToken: RegExp }> = [
  { name: "vitest", dep: "vitest", scriptToken: /\bvitest\b/ },
  { name: "jest", dep: "jest", scriptToken: /\bjest\b/ },
  { name: "mocha", dep: "mocha", scriptToken: /\bmocha\b/ },
  { name: "ava", dep: "ava", scriptToken: /\bava\b/ },
  { name: "tap", dep: "tap", scriptToken: /\btap\b/ },
  { name: "node:test", dep: "___never___", scriptToken: /node\s+--test|tsx\s+--test|--test\b/ },
  { name: "playwright", dep: "@playwright/test", scriptToken: /\bplaywright\b/ },
];

function detectDeclaredFrameworks(repoPath: string): { frameworks: string[]; testScripts: string[] } {
  const pkg = readPackageJson(repoPath);
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const testScripts = Object.entries(pkg.scripts)
    .filter(([name]) => /^(test|tests?:|check|ci)/.test(name))
    .map(([name, cmd]) => `${name}=${cmd}`);
  const scriptText = Object.values(pkg.scripts).join(" ; ");
  const frameworks = new Set<string>();
  for (const marker of FRAMEWORK_MARKERS) {
    if (deps[marker.dep] !== undefined) frameworks.add(marker.name);
    else if (marker.scriptToken.test(scriptText)) frameworks.add(marker.name);
  }
  return { frameworks: Array.from(frameworks).sort(), testScripts };
}

function detectPackageManager(repoPath: string): string {
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(repoPath, "yarn.lock"))) return "yarn";
  if (existsSync(join(repoPath, "package-lock.json"))) return "npm";
  if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock"))) return "bun";
  return "unknown";
}

/** True when the emitted command could not possibly run the repository's tests - e.g. a `tsx --test`
 * command for a repository whose tests are vitest suites. Reported, never corrected here. */
function commandMismatch(commands: string[], frameworks: string[]): string | undefined {
  if (commands.length === 0) return undefined;
  const usesNodeTest = commands.some((c) => /(^|\s)(tsx|node)\s/.test(c));
  const frameworkNeeded = frameworks.find((f) => f === "vitest" || f === "jest" || f === "mocha" || f === "ava" || f === "tap");
  if (usesNodeTest && frameworkNeeded) {
    return `emits node:test-style command (${commands[0]!.split(" ").slice(0, 2).join(" ")} ...) for a ${frameworkNeeded} repository`;
  }
  return undefined;
}

async function probeRepository(repository: string, probeDir: string, commitSample: number): Promise<ProbeResult> {
  const [owner, name] = repository.split("/");
  const localPath = join(probeDir, `${owner}__${name}`);
  const result: ProbeResult = {
    repository,
    shape: { rootTsconfig: false, nestedTsconfigCount: 0, packageManager: "unknown", declaredTestScripts: [], frameworksDeclared: [] },
    stages: {
      clone: { status: "SKIPPED" },
      eligibility: { status: "SKIPPED" },
      delta: { status: "SKIPPED" },
      graph: { status: "SKIPPED" },
      impact: { status: "SKIPPED" },
      discovery: { status: "SKIPPED" },
      command: { status: "SKIPPED" },
    },
  };

  // 1. clone
  try {
    if (existsSync(join(localPath, ".git"))) {
      run(["fetch", "--depth", String(CLONE_DEPTH), "origin"], localPath);
      result.stages.clone = { status: "OK", detail: "reused existing clone" };
    } else {
      mkdirSync(probeDir, { recursive: true });
      run(
        ["clone", "--depth", String(CLONE_DEPTH), "--single-branch", `https://github.com/${repository}.git`, localPath],
        probeDir,
        600_000,
      );
      result.stages.clone = { status: "OK" };
    }
  } catch (err) {
    result.stages.clone = { status: "ERROR", detail: (err as Error).message.split("\n")[0] };
    return result;
  }

  // Structural facts, recorded regardless of what the engine decides.
  result.shape.rootTsconfig = existsSync(join(localPath, "tsconfig.json"));
  result.shape.nestedTsconfigCount = countNestedTsconfigs(localPath);
  result.shape.packageManager = detectPackageManager(localPath);
  const declared = detectDeclaredFrameworks(localPath);
  result.shape.frameworksDeclared = declared.frameworks;
  result.shape.declaredTestScripts = declared.testScripts;

  // 2. eligibility - the production gate, exactly as the container runs it
  const researchRepo: ResearchRepository = {
    owner: owner!,
    name: name!,
    primaryLanguage: "typescript",
    framework: "unknown",
    sizeClass: "medium",
  };
  try {
    const metadata = collectMetadata(researchRepo, localPath);
    result.stages.eligibility = metadata.exclusionReason
      ? { status: "REFUSED", detail: metadata.exclusionReason }
      : { status: "OK", detail: metadata.languageSupport.reason };
  } catch (err) {
    result.stages.eligibility = { status: "ERROR", detail: (err as Error).message.split("\n")[0] };
  }

  // 3. delta - every later stage needs one, so this runs even when eligibility refused. Running past a
  // refusal is the whole point: it shows whether the refusal reflects a real engine limit.
  //
  // Several consecutive commits are sampled rather than only HEAD~1..HEAD. One commit says almost
  // nothing: a single config-file touch forces FULL on any repository, which would read as an engine
  // limitation when it is simply that commit's content. The FULL/SELECTIVE split over the sample is
  // reported as-is - no commit is chosen for being flattering.
  let deltas: Array<{ base: string; head: string; delta: Awaited<ReturnType<typeof analyzeGitDelta>> }> = [];
  try {
    const revs = run(["rev-list", "--max-count", String(commitSample + 1), "HEAD"], localPath)
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    result.headSha = revs[0];
    result.baseSha = revs[revs.length - 1];
    for (let i = 0; i + 1 < revs.length; i++) {
      const head = revs[i]!;
      const base = revs[i + 1]!;
      deltas.push({ base, head, delta: await analyzeGitDelta({ baseSha: base, headSha: head, repoPath: localPath }) });
    }
    const failed = deltas.filter((d) => !d.delta.success);
    result.stages.delta =
      deltas.length === 0
        ? { status: "REFUSED", detail: "no commit pairs available in the shallow clone" }
        : failed.length === deltas.length
          ? { status: "REFUSED", detail: (failed[0]!.delta as { error: string }).error }
          : {
              status: "OK",
              detail: `${deltas.length - failed.length}/${deltas.length} commit pairs analysed`,
            };
  } catch (err) {
    result.stages.delta = { status: "ERROR", detail: (err as Error).message.split("\n")[0] };
  }

  // 4. graph
  let graphResult: Awaited<ReturnType<typeof buildDependencyGraph>> | undefined;
  try {
    graphResult = await buildDependencyGraph({ repoPath: localPath, excludeDirs: EXCLUDE_DIRS });
    const nodes = graphResult.graph.nodes;
    result.graph = {
      nodes: nodes.length,
      edges: graphResult.graph.edges.length,
      sourceNodes: nodes.filter((n) => n.isSource).length,
      testNodes: nodes.filter((n) => n.isTest).length,
      confidence: graphResult.confidence,
      durationMs: Math.round(graphResult.performance.durationMs),
    };
    result.stages.graph =
      nodes.length === 0
        ? { status: "REFUSED", detail: "graph built with zero nodes" }
        : { status: "OK", detail: `${nodes.length} nodes, confidence ${graphResult.confidence}` };
  } catch (err) {
    result.stages.graph = { status: "ERROR", detail: (err as Error).message.split("\n")[0] };
  }

  // 5. impact, across every sampled commit pair
  if (graphResult && deltas.some((d) => d.delta.success)) {
    try {
      const analyzer = new ImpactAnalyzer();
      const commands = new Set<string>();
      const commandRefusals = new Set<string>();
      const baselineRules = new Set<string>();
      let baselineFull = 0;
      let baselineSelective = 0;
      let full = 0;
      let selective = 0;
      let affectedTests = 0;
      let affectedSources = 0;
      const fallbackReasons = new Set<string>();
      let lastStatus = "";
      for (const entry of deltas) {
        if (!entry.delta.success) continue;
        const impact = analyzer.analyze(entry.delta.delta, graphResult, graphResult.profile, {
          repositoryFiles: entry.delta.inventory?.files,
        });
        lastStatus = impact.analysisStatus;
        affectedSources += impact.affectedSourceFiles.length;
        affectedTests += impact.affectedTests.length;
        if (impact.fallbackRequired) {
          full++;
          for (const reason of impact.fallbackReasons) fallbackReasons.add(reason);
        } else {
          selective++;
          const commandPlan = planSelectiveTestCommands(graphResult.profile, impact.affectedTests.map((t) => t.path));
          if (commandPlan.refusalReason) commandRefusals.add(commandPlan.refusalReason);
          for (const spec of commandPlan.commands) commands.add(commandSpecToString(spec));
        }

        // The PATH baseline is what DiffCI's savings are measured AGAINST - a simple path-rule CI.
        // If it falls back to the full suite on every commit of a repository, every savings figure
        // computed against it is measured against a strawman, so its own fallback rate is as much a
        // property to check as DiffCI's.
        const baseline = runPathBaseline(graphResult.profile.testFilePaths, entry.delta.delta.files, graphResult.profile);
        if (baseline.fallbackRequired) baselineFull++;
        else baselineSelective++;
        for (const rule of baseline.matchedRules) baselineRules.add(rule);
      }
      result.impact = {
        commitsAnalysed: full + selective,
        fullCount: full,
        selectiveCount: selective,
        fallbackReasons: Array.from(fallbackReasons),
        affectedSourceFiles: affectedSources,
        affectedTests,
        analysisStatus: lastStatus,
      };
      result.pathBaseline = { selectiveCount: baselineSelective, fullCount: baselineFull, matchedRules: Array.from(baselineRules) };
      result.stages.impact = { status: "OK", detail: `${selective} SELECTIVE / ${full} FULL over ${full + selective} commits` };

      // 6. command synthesis - what would actually be executed
      result.emittedCommands = Array.from(commands);
      const mismatch = commandMismatch(result.emittedCommands, result.shape.frameworksDeclared);
      result.commandFrameworkMismatch = mismatch;
      result.stages.command = mismatch
        ? { status: "REFUSED", detail: mismatch }
        : commandRefusals.size > 0
          ? { status: "REFUSED", detail: Array.from(commandRefusals)[0]! }
          : result.emittedCommands.length === 0
            ? { status: "SKIPPED", detail: "every sampled commit fell back to FULL - no selective command emitted" }
            : { status: "OK", detail: result.emittedCommands[0]! };
    } catch (err) {
      result.stages.impact = { status: "ERROR", detail: (err as Error).message.split("\n")[0] };
    }
  }

  // 7. test discovery - does the engine's notion of "a test" cover this repository's real tests?
  // Zero configs is NOT a failure: a repository using the default `.test.`/`.spec.` convention with no
  // root config is fully supported. The failure that matters is discovering no test files at all in a
  // repository that plainly has them.
  try {
    const pkg = readPackageJson(localPath);
    const discovery = discoverTestRunnerConfigs(localPath, pkg.scripts);
    const runners = Array.from(new Set(discovery.configs.map((c) => c.runner))).sort();
    const discoveredTestFiles = graphResult?.profile.testFilePaths.length ?? 0;
    result.discoveredTestFiles = discoveredTestFiles;
    result.stages.discovery =
      discoveredTestFiles === 0
        ? {
            status: "REFUSED",
            detail: `zero test files discovered (repository declares: ${result.shape.frameworksDeclared.join(", ") || "no framework"})`,
          }
        : {
            status: "OK",
            detail: `${discoveredTestFiles} test files; ${discovery.configs.length} root config(s)${runners.length > 0 ? ` (${runners.join(", ")})` : " (convention only)"}`,
          };
  } catch (err) {
    result.stages.discovery = { status: "ERROR", detail: (err as Error).message.split("\n")[0] };
  }

  return result;
}

function renderTable(results: ProbeResult[]): string {
  const lines: string[] = [];
  const mark = (o: StageOutcome): string =>
    o.status === "OK" ? "OK  " : o.status === "REFUSED" ? "REF " : o.status === "ERROR" ? "ERR " : "--  ";
  lines.push("");
  lines.push("repository                     elig delta graph impct disc  cmd   frameworks");
  lines.push("-".repeat(96));
  for (const r of results) {
    lines.push(
      [
        r.repository.padEnd(30).slice(0, 30),
        mark(r.stages.eligibility),
        mark(r.stages.delta),
        mark(r.stages.graph),
        mark(r.stages.impact),
        mark(r.stages.discovery),
        mark(r.stages.command),
        r.shape.frameworksDeclared.join(",") || "-",
      ].join(" "),
    );
  }
  lines.push("");
  lines.push("Detail");
  lines.push("-".repeat(96));
  for (const r of results) {
    lines.push(`${r.repository}`);
    lines.push(
      `  shape: rootTsconfig=${r.shape.rootTsconfig} nestedTsconfigs=${r.shape.nestedTsconfigCount} pm=${r.shape.packageManager}`,
    );
    for (const [stage, outcome] of Object.entries(r.stages)) {
      if (outcome.status === "SKIPPED") continue;
      lines.push(`  ${stage.padEnd(12)} ${outcome.status.padEnd(8)} ${outcome.detail ?? ""}`);
    }
    if (r.graph) {
      lines.push(
        `  graph stats  nodes=${r.graph.nodes} source=${r.graph.sourceNodes} test=${r.graph.testNodes} edges=${r.graph.edges} confidence=${r.graph.confidence} ${r.graph.durationMs}ms`,
      );
    }
    if (r.pathBaseline) {
      lines.push(`  baseline     ${r.pathBaseline.selectiveCount} SELECTIVE / ${r.pathBaseline.fullCount} FULL - rules: ${r.pathBaseline.matchedRules.join("; ") || "none matched"}`);
    }
    if (r.impact && r.impact.fallbackReasons.length > 0) {
      for (const reason of r.impact.fallbackReasons) lines.push(`  fallback     ${reason}`);
    }
    if (r.emittedCommands && r.emittedCommands.length > 0) {
      for (const cmd of r.emittedCommands) lines.push(`  would run    ${cmd.slice(0, 140)}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repositories: string[] = [];
  let out: string | undefined;
  let commitSample = 5;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--out") out = argv[++i];
    else if (arg === "--commits") commitSample = Number.parseInt(argv[++i] ?? "5", 10) || 5;
    else if (arg === "--keep") continue;
    else if (!arg.startsWith("-")) repositories.push(arg);
  }
  if (repositories.length === 0) {
    console.error(
      "Usage: npx tsx scripts/repo-agnostic-probe.ts owner/name [owner/name ...] [--commits N] [--out report.json]",
    );
    process.exit(1);
  }

  const probeDir = resolve(process.env.DIFFCI_PROBE_DIR ?? join(tmpdir(), "diffci-repo-agnostic-probe"));
  const selfRoot = resolve(dirname(import.meta.filename), "..");
  if (probeDir.startsWith(selfRoot + sep)) {
    throw new Error(
      `Probe directory ${probeDir} is inside this repository (${selfRoot}). ts.findConfigFile() would ` +
        `find this repository's own tsconfig.json above every clone. Set DIFFCI_PROBE_DIR elsewhere.`,
    );
  }
  mkdirSync(probeDir, { recursive: true });
  assertNoAncestorTsconfig(probeDir);

  console.error(`probe dir: ${probeDir}`);
  const results: ProbeResult[] = [];
  for (const repository of repositories) {
    console.error(`probing ${repository} ...`);
    results.push(await probeRepository(repository, probeDir, commitSample));
  }

  console.log(renderTable(results));
  if (out) {
    writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), probeDir, results }, null, 2));
    console.error(`wrote ${out}`);
  }
}

if (import.meta.filename === resolve(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : String(err));
    process.exit(1);
  });
}
