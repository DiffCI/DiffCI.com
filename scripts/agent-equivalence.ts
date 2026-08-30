/**
 * Do two agent generations produce the same observation, apart from a deliberately added field?
 *
 * WHY THIS EXISTS. The safety corpus - 25 recall-measurable mutations across hono and zod, 25
 * confirmed, 0 observed false greens - was produced by agent generation A. Generation B exposes
 * `pathBaseline.selectedTests`, the comparator's already-computed selection, because the economics
 * experiment must EXECUTE the comparator's tests and a count cannot be executed. That changes the agent
 * digest, and the digest is what ties the safety evidence together.
 *
 * The weak claim available without this script is "the change shouldn't affect selection". The claim
 * available with it is:
 *
 *     The measurement agent changed only the observable comparator-selection surface; pre-existing
 *     observation outputs were unchanged on frozen representative inputs.
 *
 * That is a measurement, not an argument, and it is what makes rerunning the safety corpus unnecessary.
 *
 * The old bundles are NOT regenerated under B. Making the hashes match would destroy the provenance
 * story rather than strengthen it: safety conclusions were produced by A and should keep saying so.
 *
 * Usage:
 *   npm run agent:equivalence -- --repo <clone> --agent-a <a.tgz> --agent-b <b.tgz> [--commits 10]
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { execBounded } from "./process-exec.js";

/** The one field generation B adds. Everything else must be identical. */
const EXPECTED_NEW_FIELDS = ["result.pathBaseline.selectedTests"];

interface InstalledAgent {
  label: string;
  bin: string;
  prefix: string;
  integrity: string;
}

function installAgent(tarball: string, label: string): InstalledAgent {
  const prefix = mkdtempSync(join(tmpdir(), `diffci-agent-${label}-`));
  writeFileSync(join(prefix, "package.json"), JSON.stringify({ name: "diffci-equivalence-host", private: true, version: "0.0.0" }));
  // Copied and referenced relatively: this repository's path contains a space, and npm on Windows can
  // only be spawned through a shell, which would split an absolute path into two arguments.
  writeFileSync(join(prefix, "agent.tgz"), readFileSync(tarball));

  const install = execBounded(process.platform === "win32" ? "npm.cmd" : "npm", ["install", "--no-audit", "--no-fund", "--silent", "./agent.tgz"], {
    cwd: prefix,
    timeoutMs: 10 * 60_000,
    shell: process.platform === "win32",
  });
  if (install.status !== 0) throw new Error(`installing ${label} failed: ${install.out.slice(-500)}`);

  return {
    label,
    prefix,
    bin: join(prefix, "node_modules", "@diffci", "observer", "index.mjs"),
    integrity: `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`,
  };
}

function observe(agent: InstalledAgent, repoPath: string, base: string, head: string): Record<string, unknown> {
  const out = join(agent.prefix, `${head.slice(0, 12)}.json`);
  execBounded("git", ["checkout", "--quiet", "--force", head], { cwd: repoPath, timeoutMs: 60_000 });
  const run = execBounded(process.execPath, [agent.bin, "observe", "--repo", repoPath, "--base", base, "--head", head, "--out", out], {
    timeoutMs: 10 * 60_000,
  });
  if (!existsSync(out)) throw new Error(`${agent.label} wrote no report for ${head.slice(0, 12)} (exit ${run.status}): ${run.out.slice(-400)}`);
  return JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>;
}

/**
 * Every leaf path in an object, so a difference anywhere is found rather than only in fields someone
 * remembered to compare.
 */
function flatten(value: unknown, prefix = "", into: Map<string, string> = new Map()): Map<string, string> {
  if (value === null || typeof value !== "object") {
    into.set(prefix, JSON.stringify(value));
    return into;
  }
  if (Array.isArray(value)) {
    // Arrays compared whole: order matters in these reports and an element-wise walk would hide a
    // reordering behind a pile of equal leaves.
    into.set(prefix, JSON.stringify(value));
    return into;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(child, prefix ? `${prefix}.${key}` : key, into);
  }
  return into;
}

/**
 * Fields that legitimately differ between any two runs and say nothing about selection semantics.
 *
 * Every entry is a CLOCK or an IDENTITY: a timestamp, a duration, or the agent's own version/hash. None
 * of them is an output of the selector. That restriction is the whole safety of this list - widening it
 * to cover a field that actually describes what the agent decided would let a real divergence pass as
 * noise, which is precisely the failure this check exists to prevent.
 *
 * `producedAt` was added after the first hono run reported it as the only difference across 10 commits
 * and 44 fields. It is a report timestamp, so it belongs here on the rule above rather than because it
 * was inconvenient.
 */
function isVolatile(path: string): boolean {
  return /(^|\.)(producedAt|observedAt|startedAt|finishedAt|durationMs|analysisMs|wallMs|timings|elapsed|agentIntegrity|agentVersion)(\.|$)/i.test(path);
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const repoPath = resolve(flag("repo") ?? "");
  const agentAPath = resolve(flag("agent-a") ?? "");
  const agentBPath = resolve(flag("agent-b") ?? "");
  const commits = Number(flag("commits") ?? 10);
  if (!existsSync(repoPath)) throw new Error("--repo <clone path> is required");
  if (!existsSync(agentAPath) || !existsSync(agentBPath)) throw new Error("--agent-a and --agent-b tarballs are required");

  const log = execBounded("git", ["log", "--first-parent", "--format=%H", "-n", String(commits + 1)], { cwd: repoPath, timeoutMs: 60_000 });
  const shas = log.out.trim().split("\n").map((s) => s.trim()).filter(Boolean);
  if (shas.length < 2) throw new Error("need at least two commits");

  const a = installAgent(agentAPath, "A");
  const b = installAgent(agentBPath, "B");

  console.log(`\n  A ${a.integrity}`);
  console.log(`  B ${b.integrity}\n`);

  let compared = 0;
  const differences: string[] = [];
  const newFieldsSeen = new Set<string>();

  try {
    for (let i = 0; i < shas.length - 1; i++) {
      const head = shas[i]!;
      const base = shas[i + 1]!;

      const reportA = flatten(observe(a, repoPath, base, head));
      const reportB = flatten(observe(b, repoPath, base, head));
      compared++;

      for (const [path, valueA] of reportA) {
        if (isVolatile(path)) continue;
        const valueB = reportB.get(path);
        if (valueB === undefined) {
          differences.push(`${head.slice(0, 9)} ${path}: present in A, ABSENT in B`);
        } else if (valueA !== valueB) {
          differences.push(`${head.slice(0, 9)} ${path}: A=${valueA.slice(0, 90)} B=${valueB.slice(0, 90)}`);
        }
      }
      for (const path of reportB.keys()) {
        if (!reportA.has(path)) newFieldsSeen.add(path);
      }

      const status = differences.length === 0 ? "ok " : "DIFF";
      console.log(`  ${status} ${head.slice(0, 9)}  ${reportA.size} fields compared`);
    }
  } finally {
    rmSync(a.prefix, { recursive: true, force: true });
    rmSync(b.prefix, { recursive: true, force: true });
  }

  const unexpectedNew = [...newFieldsSeen].filter((p) => !EXPECTED_NEW_FIELDS.includes(p));

  console.log(`\n  commits compared        ${compared}`);
  console.log(`  pre-existing differences ${differences.length}`);
  console.log(`  new fields in B          ${[...newFieldsSeen].join(", ") || "(none)"}`);

  for (const d of differences.slice(0, 40)) console.log(`    ${d}`);
  if (unexpectedNew.length > 0) console.log(`\n  UNEXPECTED new field(s): ${unexpectedNew.join(", ")}`);

  if (differences.length > 0 || unexpectedNew.length > 0) {
    console.log(`\n  NOT EQUIVALENT. The safety corpus cannot be carried across this agent change on the strength of this check.\n`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n  EQUIVALENT. B changed only ${EXPECTED_NEW_FIELDS.join(", ")}; every other observation output was identical.\n`);
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main();
