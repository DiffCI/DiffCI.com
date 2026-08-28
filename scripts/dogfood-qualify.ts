/**
 * Repository qualification: can this repository contribute evidence, and of which kind?
 *
 * TWO INDEPENDENT CAPABILITIES, and conflating them is how "tested on 20 repositories" comes to imply
 * twenty repositories contributed safety evidence.
 *
 *   OBSERVATION-QUALIFIED  DiffCI can inspect it and produce a decision. Needs only a checkout.
 *                          Yields: decisions, efficiency versus the comparator, refusal behaviour.
 *
 *   MUTATION-QUALIFIED     Its real suite installs, builds and runs GREEN reproducibly, so differential
 *                          mutation recall can actually be measured. Needs a working toolchain.
 *                          Yields: safety evidence, and nothing else does.
 *
 * A repository can be the first without being the second - zod is exactly that. It is not intrinsically
 * unsuitable; it is unqualified *under this harness environment*, because its build shells out to a
 * package manager this harness does not put on PATH. That is a deliberate scope boundary, not a
 * property of zod, and the distinction is recorded rather than flattened.
 *
 * THIS GATE IS DELIBERATELY CHEAP AND RUNS AT HEAD. Clone, install, build, run the suite once, ask
 * whether it is green. A repository that cannot pass at HEAD will not pass at ten historical commits,
 * and finding that out here costs one install instead of ten mutation loops.
 *
 * Usage:
 *   npm run dogfood:qualify -- --corpus scripts/dogfood-corpus.json [--only owner/name] [--write]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertShellSafeArgs } from "./shell-safety.js";
import { parseTestOutput } from "./test-output-parsers.js";

const repoRoot = resolve(dirname(import.meta.filename), "..");

export type Capability = "yes" | "no" | "unknown";

export interface CorpusEntry {
  source: string;
  stresses: string;
  commits?: number;
  /** DiffCI can analyse it. Established by the observation pass, not here. */
  observationQualified?: Capability;
  /**
   * Its suite runs green reproducibly under THIS harness. Only repositories marked `yes` may
   * contribute safety evidence.
   */
  mutationQualified?: Capability;
  /** Why the mutation verdict is what it is - environmental reasons are recorded, not hidden. */
  mutationQualificationReason?: string;
  mutationQualifiedAt?: string;
  /** The documented sequence. Absent means "npm install, no build" was assumed. */
  install?: string[];
  build?: string[];
  testModule?: string;
  testArgs?: string[];
}

function runShell(args: string[], cwd: string, timeoutMs: number): { status: number | null; out: string; ms: number } {
  assertShellSafeArgs(args, "dogfood-qualify");
  const started = Date.now();
  const [exec, ...rest] = args;
  const resolved = process.platform === "win32" && !exec!.endsWith(".cmd") ? `${exec}.cmd` : exec!;
  const result = spawnSync(resolved, rest, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, ms: Date.now() - started };
}

/** No shell: the runner is invoked through `node` so nothing repository-derived is concatenated. */
function runTests(repoPath: string, entry: CorpusEntry, timeoutMs: number): { status: number | null; out: string; ms: number } {
  const started = Date.now();
  const module = join(repoPath, entry.testModule ?? "node_modules/vitest/vitest.mjs");
  const result = spawnSync(process.execPath, [module, ...(entry.testArgs ?? ["run"])], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return { status: result.status, out: `${result.stdout ?? ""}${result.stderr ?? ""}`, ms: Date.now() - started };
}

interface Verdict {
  source: string;
  mutationQualified: Capability;
  reason: string;
  failures?: number;
  framework?: string;
  durations: { clone: number; install: number; build: number; test: number };
}

function qualify(entry: CorpusEntry, scratch: string, timeoutMs: number): Verdict {
  const durations = { clone: 0, install: 0, build: 0, test: 0 };
  const dest = join(scratch, entry.source.replace("/", "__"));

  const cloneStarted = Date.now();
  if (!existsSync(dest)) {
    // Shallow: qualification only ever looks at HEAD, and full history on a large monorepo is minutes
    // of download that answers nothing.
    const cloned = spawnSync("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${entry.source}.git`, dest], { encoding: "utf8" });
    if (cloned.status !== 0) {
      durations.clone = Date.now() - cloneStarted;
      return { source: entry.source, mutationQualified: "no", reason: "could not clone", durations };
    }
  }
  durations.clone = Date.now() - cloneStarted;

  const install = runShell(entry.install ?? ["npm", "install", "--no-audit", "--no-fund"], dest, timeoutMs);
  durations.install = install.ms;
  if (install.status !== 0) {
    return { source: entry.source, mutationQualified: "no", reason: `install failed: ${lastLine(install.out)}`, durations };
  }

  if (entry.build) {
    const built = runShell(entry.build, dest, timeoutMs);
    durations.build = built.ms;
    if (built.status !== 0) {
      return { source: entry.source, mutationQualified: "no", reason: `build failed: ${lastLine(built.out)}`, durations };
    }
  }

  const tested = runTests(dest, entry, timeoutMs);
  durations.test = tested.ms;
  const parsed = parseTestOutput(tested.out);

  // Unparseable output is NOT zero failures. A repository whose runner this harness cannot read is
  // unqualified, because every later classification would rest on a number nobody could produce.
  if (parsed.failures === undefined) {
    return { source: entry.source, mutationQualified: "no", reason: `could not read a failure count from the runner: ${lastLine(tested.out)}`, durations };
  }
  if (parsed.failures > 0) {
    return { source: entry.source, mutationQualified: "no", reason: `${parsed.failures} test(s) failing at HEAD`, failures: parsed.failures, framework: parsed.framework, durations };
  }

  return { source: entry.source, mutationQualified: "yes", reason: "suite is green at HEAD under the documented sequence", failures: 0, framework: parsed.framework, durations };
}

function lastLine(output: string): string {
  return (output.trim().split("\n").filter(Boolean).pop() ?? "no output").slice(0, 180);
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const corpusPath = resolve(flag("corpus") ?? join(repoRoot, "scripts", "dogfood-corpus.json"));
  const only = flag("only");
  const write = args.includes("--write");
  const timeoutMs = Number(flag("timeout") ?? 25 * 60_000);

  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusEntry[];
  const scratch = mkdtempSync(join(tmpdir(), "diffci-qualify-"));

  console.log(`\nRepository qualification - can this repository contribute SAFETY evidence?\n  scratch: ${scratch}\n`);

  for (const entry of corpus) {
    if (only && entry.source !== only) continue;
    process.stdout.write(`  ${entry.source.padEnd(28)} `);
    const verdict = qualify(entry, scratch, timeoutMs);
    const seconds = Object.values(verdict.durations).reduce((a, b) => a + b, 0) / 1000;
    console.log(`${verdict.mutationQualified === "yes" ? "MUTATION-QUALIFIED" : "not qualified"}  (${seconds.toFixed(0)}s)`);
    console.log(`      ${verdict.reason}`);

    if (write) {
      entry.mutationQualified = verdict.mutationQualified;
      entry.mutationQualificationReason = verdict.reason;
      entry.mutationQualifiedAt = new Date().toISOString();
    }
  }

  if (write) {
    writeFileSync(corpusPath, `${JSON.stringify(corpus, null, 2)}\n`);
    console.log(`\n  corpus updated: ${corpusPath}`);
  }

  const qualified = corpus.filter((e) => e.mutationQualified === "yes").length;
  console.log(`\n  ${qualified} of ${corpus.length} repositories are mutation-qualified.`);
  console.log("  Only these can contribute safety evidence. The rest remain useful for observation.\n");
}

main();
