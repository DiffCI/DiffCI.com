/**
 * The dogfood corpus runner: the PACKAGED agent against real repositories, in observation mode.
 *
 * WHAT MAKES THIS DIFFERENT FROM EVERY EARLIER REPLAY. Previous benchmarking ran the engine out of
 * this repository's own source tree. That measures the engine. It does not measure the product, and
 * the packaging exercise that produced the agent found four defects that source-tree runs could never
 * have surfaced - a missing shebang, an install that dirtied the observed worktree, unparseable
 * generated YAML, and a guard that silently checked nothing. So this harness installs the exact
 * `npm pack` tarball into a clean prefix and executes THAT binary. It never imports src/client.
 *
 *     private source -> build -> npm pack -> exact .tgz -> clean install -> real repository
 *
 * OBSERVATION ONLY. Nothing here skips, selects, or influences any test run. It records what DiffCI
 * WOULD have chosen. Falsifying those choices requires actually executing the full suite and checking
 * whether any failure falls outside the proposed selection - that is a separate, much slower pass, and
 * deliberately not conflated with this one.
 *
 * Usage:
 *   npm run dogfood -- --repo <path-or-owner/name> [--commits 20] [--out corpus.jsonl]
 *   npm run dogfood -- --corpus scripts/dogfood-corpus.json
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execBounded } from "./process-exec.js";
import { assertShellSafeArgs } from "./shell-safety.js";

const repoRoot = resolve(dirname(import.meta.filename), "..");

interface CorpusEntry {
  /** Local path, or `owner/name` to clone from GitHub. */
  source: string;
  /** Why this repository is in the corpus - which assumption it is meant to stress. */
  stresses: string;
  /** How many recent commits to replay. */
  commits?: number;
}

/** One row of the evidence envelope. Every field is recorded even when it is unknown. */
interface Observation {
  identity: {
    repository: string;
    stresses: string;
    baseSha: string;
    headSha: string;
    agentVersion: string;
    agentIntegrity: string;
    observedAt: string;
  };
  understanding: {
    framework: string | "unknown";
    testUniverse: number | "unknown";
    graphNodes: number | "unknown";
    graphEdges: number | "unknown";
    graphConfidence: string | "unknown";
    changedFiles: number | "unknown";
  };
  decision: {
    status: string;
    stage: string;
    mode: string | "unknown";
    reason: string;
    selected: number | "unknown";
    total: number | "unknown";
  };
  counterfactual: {
    /** What a simple path-rule CI would have selected - DiffCI's honest comparator. */
    baselineMode: string | "unknown";
    baselineSelected: number | "unknown";
    /** Positive means DiffCI selected fewer than the comparator. Negative is a real and useful result. */
    netVersusBaseline: number | "unknown";
  };
  integrity: {
    worktreeUnchanged: boolean | "unknown";
    reportOutsideRepository: boolean | "unknown";
    includesFileContents: boolean | "unknown";
    includesEnvironment: boolean | "unknown";
    includesCredentials: boolean | "unknown";
  };
  economics: {
    analysisMs: number | "unknown";
    graphMs: number | "unknown";
    /**
     * CPU-seconds the whole observation process consumed - the JOINT analysis cost (2026-08-29).
     *
     * Joint, not DiffCI's alone, and deliberately not split. `runPathBaseline` consumes `profile`,
     * which is produced BY `buildDependencyGraph` - so the comparator's selection cannot be computed
     * without the expensive graph step having already run. There is no honest way to divide this
     * number into a DiffCI share and a comparator share, and inventing an allocation would put a
     * fabricated quantity at the centre of the business case.
     *
     * The economics calculation therefore charges ALL of it to DiffCI, which gives the comparator its
     * selection logic for free. That is deliberately generous to the comparator: if DiffCI still wins
     * on that basis, the result is stronger than one resting on a split nobody can defend.
     *
     * undefined where CPU cannot be measured (no /proc), never 0 - "could not tell" and "consumed
     * nothing" must not collapse into the same number.
     */
    jointAnalysisCpuSeconds?: number;
  };
  /** Non-fatal problems worth a human reading them - a new failure class is the point of this exercise. */
  notes: string[];
}

function git(args: string[], cwd: string): { stdout: string; ok: boolean } {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { stdout: result.stdout ?? "", ok: result.status === 0 };
}

/**
 * Installs the packed tarball into a throwaway prefix and returns the binary path.
 *
 * A clean prefix per run, not a shared one: the point is to exercise what a customer's runner does on
 * a cold machine, including the dependency install. Reusing node_modules would quietly skip that.
 */
function installAgent(): { bin: string; version: string; integrity: string; prefix: string } {
  const distDir = join(repoRoot, "dist-agent");
  const tarballs = existsSync(distDir) ? readdirSync(distDir).filter((f) => f.endsWith(".tgz")) : [];
  if (tarballs.length !== 1) throw new Error(`expected exactly one .tgz in dist-agent, found ${tarballs.length}. Run: npm run build:agent`);
  const tarball = join(distDir, tarballs[0]!);

  const integrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`;
  const prefix = mkdtempSync(join(tmpdir(), "diffci-agent-"));
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "diffci-dogfood-host", private: true, version: "0.0.0" }));

  // The tarball is COPIED next to the install and referenced by a relative name, rather than passed by
  // absolute path. `npm.cmd` on Windows can only be spawned with shell:true, which concatenates
  // arguments into a command string - and this repository's own path contains a space, so an absolute
  // path splits into two arguments and the install fails. That is now the third place this bug has
  // appeared (the agent build and the package inspector were the others), so the fix here is to remove
  // the space from the argument entirely rather than to quote around it.
  const localTarball = "agent.tgz";
  writeFileSync(join(prefix, localTarball), readFileSync(tarball));

  const installArgs = ["install", "--no-audit", "--no-fund", "--silent", `./${localTarball}`];
  assertShellSafeArgs(installArgs, "dogfood: npm install of the agent tarball");
  execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", installArgs, {
    cwd: prefix,
    stdio: "inherit",
    shell: process.platform === "win32",
  });

  const manifest = JSON.parse(readFileSync(join(prefix, "node_modules", "@diffci", "observer", "package.json"), "utf8")) as { version: string };
  // The bundle itself, not the .bin shim: invoking through `node <path>` works identically on every
  // platform, and the shim's own correctness was verified separately.
  return { bin: join(prefix, "node_modules", "@diffci", "observer", "index.mjs"), version: manifest.version, integrity, prefix };
}

/** Clones (or reuses) a repository into a scratch directory that is safe to check out at will. */
function materialise(source: string, scratch: string): string | undefined {
  if (existsSync(source) && existsSync(join(source, ".git"))) {
    // A local path is copied by cloning, never used in place: this harness checks out historical
    // commits, and doing that in someone's working repository would be unforgivable.
    const dest = join(scratch, source.replace(/[^A-Za-z0-9]/g, "_").slice(-40));
    if (!existsSync(dest)) {
      const cloned = spawnSync("git", ["clone", "--quiet", "--no-hardlinks", source, dest], { encoding: "utf8" });
      if (cloned.status !== 0) return undefined;
    }
    return dest;
  }

  const dest = join(scratch, source.replace("/", "__"));
  if (existsSync(dest)) return dest;
  const cloned = spawnSync("git", ["clone", "--quiet", `https://github.com/${source}.git`, dest], { encoding: "utf8", stdio: "inherit" });
  return cloned.status === 0 ? dest : undefined;
}

function num(value: unknown): number | "unknown" {
  return typeof value === "number" ? value : "unknown";
}

function bool(value: unknown): boolean | "unknown" {
  return typeof value === "boolean" ? value : "unknown";
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "unknown";
}

function observeCommit(agent: { bin: string; version: string; integrity: string }, repoPath: string, entry: CorpusEntry, base: string, head: string, reportDir: string): Observation {
  const notes: string[] = [];
  const reportPath = join(reportDir, `${head.slice(0, 12)}.json`);

  // The agent analyses the tree as checked out, so historical replay has to move the worktree. This is
  // a throwaway clone; the integrity fields below still verify the agent itself changed nothing.
  const checkout = spawnSync("git", ["checkout", "--quiet", "--force", head], { cwd: repoPath, encoding: "utf8" });
  if (checkout.status !== 0) notes.push(`could not check out ${head.slice(0, 12)}: ${(checkout.stderr ?? "").trim().split("\n")[0]}`);

  // Through execBounded, so the analysis arm is measured by the same calibrated meter as every
  // execution arm - and so the CPU it reports is the whole process tree, not just the direct child.
  const run = execBounded(process.execPath, [agent.bin, "observe", "--repo", repoPath, "--base", base, "--head", head, "--out", reportPath], {
    timeoutMs: 10 * 60 * 1000,
  });
  const wallMs = run.ms;

  if (run.status !== 0) notes.push(`agent exited ${String(run.status)}`);
  if (run.stderr.trim().length > 0) notes.push(`stderr: ${run.stderr.trim().split("\n")[0].slice(0, 200)}`);

  let report: Record<string, unknown> = {};
  if (existsSync(reportPath)) {
    try {
      report = JSON.parse(readFileSync(reportPath, "utf8")) as Record<string, unknown>;
    } catch (error) {
      notes.push(`report is not valid JSON: ${(error as Error).message.slice(0, 120)}`);
    }
  } else {
    notes.push("agent wrote no report");
  }

  const result = (report.result ?? {}) as Record<string, unknown>;
  const graph = (result.graph ?? {}) as Record<string, unknown>;
  const baseline = (result.pathBaseline ?? {}) as Record<string, unknown>;
  const payload = (report.payload ?? {}) as Record<string, unknown>;
  const nonInterference = (report.nonInterference ?? {}) as Record<string, unknown>;
  const timings = (report.timings ?? {}) as Record<string, unknown>;

  const selected = num(result.selectedTests !== undefined ? (result.selectedTests as unknown[]).length : undefined);
  const baselineSelected = num(baseline.selectedTestCount);
  const netVersusBaseline = typeof selected === "number" && typeof baselineSelected === "number" ? baselineSelected - selected : ("unknown" as const);

  const fallbackReasons = Array.isArray(result.fallbackReasons) ? (result.fallbackReasons as string[]) : [];
  // A REFUSED report carries no `result` at all, so mode/selected/total are legitimately absent. An
  // earlier version rendered that as "unknown" in every column, which buried the single most important
  // outcome the corpus can produce: DiffCI declining to analyse a repository it does not understand,
  // with a reason, instead of guessing. REFUSED is a decision and is reported as one.
  const refusal = str(report.refusal);
  const decisionMode = str(report.status) === "REFUSED" ? "REFUSED" : str(result.mode);
  const decisionReason = str(report.status) === "REFUSED" ? refusal : fallbackReasons.length > 0 ? fallbackReasons.join("; ") : str(result.analysisStatus);

  // The whole point of the corpus is to find these, so they are surfaced rather than averaged away.
  if (bool(nonInterference.worktreeUnchanged) === false) notes.push("NON-INTERFERENCE VIOLATED: the agent changed the worktree");
  if (bool(payload.includesFileContents) === true) notes.push("PRIVACY VIOLATED: report claims to include file contents");
  if (bool(payload.includesCredentials) === true) notes.push("PRIVACY VIOLATED: report claims to include credentials");
  if (str(result.mode) === "SELECTIVE" && selected === 0) notes.push("SELECTIVE with zero selected tests - verify this is a genuine no-op change, not a blind spot");
  if (result.blindSpot === true) notes.push("blind spot reported");

  return {
    identity: {
      repository: entry.source,
      stresses: entry.stresses,
      baseSha: base,
      headSha: head,
      agentVersion: agent.version,
      agentIntegrity: agent.integrity,
      observedAt: new Date().toISOString(),
    },
    understanding: {
      framework: str((result.testCommand as Record<string, unknown> | undefined)?.framework ?? result.framework),
      testUniverse: num(result.totalTestCount),
      graphNodes: num(graph.nodes),
      graphEdges: num(graph.edges),
      graphConfidence: str(graph.confidence),
      changedFiles: num(result.changedFileCount),
    },
    decision: {
      status: str(report.status),
      stage: str(report.stage),
      mode: decisionMode,
      reason: decisionReason,
      selected,
      total: num(result.totalTestCount),
    },
    counterfactual: {
      baselineMode: str(baseline.mode),
      baselineSelected,
      netVersusBaseline,
    },
    integrity: {
      worktreeUnchanged: bool(nonInterference.worktreeUnchanged),
      reportOutsideRepository: bool(nonInterference.reportWrittenOutsideRepository),
      includesFileContents: bool(payload.includesFileContents),
      includesEnvironment: bool(payload.includesEnvironment),
      includesCredentials: bool(payload.includesCredentials),
    },
    economics: {
      analysisMs: num(timings.totalMs) === "unknown" ? wallMs : num(timings.totalMs),
      graphMs: num(graph.durationMs),
      jointAnalysisCpuSeconds: run.cpuSeconds,
    },
    notes,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const corpusFile = flag("corpus");
  const entries: CorpusEntry[] = corpusFile
    ? (JSON.parse(readFileSync(resolve(corpusFile), "utf8")) as CorpusEntry[])
    : [{ source: flag("repo") ?? repoRoot, stresses: "ad hoc", commits: Number(flag("commits") ?? 20) }];

  const outPath = resolve(flag("out") ?? join(repoRoot, ".dogfood", "corpus.jsonl"));
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "");

  const scratch = mkdtempSync(join(tmpdir(), "diffci-dogfood-"));
  const reportDir = join(scratch, "reports");
  mkdirSync(reportDir, { recursive: true });

  console.log("Installing the packaged agent from its tarball...");
  const agent = installAgent();
  console.log(`  @diffci/observer@${agent.version}`);
  console.log(`  ${agent.integrity}\n`);

  let observed = 0;
  try {
    for (const entry of entries) {
      console.log(`\n=== ${entry.source}  (${entry.stresses}) ===`);
      const path = materialise(entry.source, scratch);
      if (!path) {
        console.log("  could not obtain this repository - skipped");
        continue;
      }

      const limit = entry.commits ?? 20;
      const log = git(["log", "--first-parent", "--format=%H", "-n", String(limit + 1)], path);
      const shas = log.stdout.trim().split("\n").filter(Boolean);
      if (shas.length < 2) {
        console.log("  fewer than two commits - skipped");
        continue;
      }

      for (let i = 0; i < shas.length - 1; i++) {
        const head = shas[i]!;
        const base = shas[i + 1]!;
        const row = observeCommit(agent, path, entry, base, head, reportDir);
        appendFileSync(outPath, `${JSON.stringify(row)}\n`);
        observed++;

        const mark = row.notes.some((n) => n.includes("VIOLATED")) ? "!!" : row.notes.length > 0 ? " ?" : "  ";
        console.log(
          `  ${mark} ${head.slice(0, 9)}  ${row.decision.mode.padEnd(9)} ${String(row.decision.selected).padStart(4)}/${String(row.decision.total).padEnd(5)}` +
            ` baseline ${String(row.counterfactual.baselineSelected).padStart(5)}  graph ${String(row.understanding.graphNodes).padStart(5)}  ${row.economics.analysisMs}ms` +
            (row.notes.length > 0 ? `  <- ${row.notes[0]}` : ""),
        );
      }
    }
  } finally {
    rmSync(agent.prefix, { recursive: true, force: true });
    // The clones are deliberately left in place: a failure is much easier to investigate with the
    // exact tree that produced it still on disk.
    console.log(`\nclones and reports kept at: ${scratch}`);
  }

  console.log(`\n${observed} observation(s) written to ${outPath}`);
}

main();
