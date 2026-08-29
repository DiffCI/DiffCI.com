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
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertShellSafeArgs } from "./shell-safety.js";
import { classifyExecution, explainExecution } from "./execution-verdict.js";
import { execBounded, execNodeScript } from "./process-exec.js";
import { parseTestOutput, stripAnsi } from "./test-output-parsers.js";


const repoRoot = resolve(dirname(import.meta.filename), "..");

export type Capability = "yes" | "no" | "unknown";

/**
 * WHY QUALIFICATION RUNS THE SUITE MORE THAN ONCE.
 *
 * hono failed this gate with exactly one failing test, and a re-run was completely green: 147 files,
 * 4961 tests, nothing failing. It is not dirty. It has a flaky test.
 *
 * Flakiness is a WORSE problem for mutation recall than dirtiness, and the difference matters:
 *
 *   A dirty baseline produces ENVIRONMENT_DIRTY. That is an honest refusal to measure.
 *   A flaky baseline produces a CLASSIFICATION, and the classification may be wrong. A flake during
 *   the mutated run reads as "the mutation was detected" and manufactures a RECALL_CONFIRMED; a flake
 *   during the selected run reads as detection where the selection actually missed. Either way the
 *   safety number is fiction, and nothing downstream can tell.
 *
 * So a repository qualifies only if its suite is green on CONSECUTIVE runs. One green run says
 * nothing about the second.
 */
const DEFAULT_BASELINE_RUNS = 2;

/**
 * Which qualifier produced a verdict. Bumped whenever the RULES for reaching one change.
 *
 * Not decoration. A verdict from before 2026-08-29 was produced by a qualifier that ignored the
 * runner's exit status and recorded no evidence, and one of those verdicts was a false green
 * (tanstack-qualify-02, permanently classified INVALID VERDICT). Such a result may still be preserved -
 * a red or flaky verdict from the old qualifier is not made wrong by the guard's absence, and it can
 * still exclude a repository from the safety denominator - but it is NOT as auditable as a
 * corrected-harness result, and nothing should treat the two as interchangeable.
 *
 * The source tarball's sha256 already identifies the exact code that ran. This says what that code
 * GUARANTEED, which is the part a later reader actually needs.
 *
 *   1.x  parsed failure counts only. No exit-status check, no recorded evidence.
 *   2.0  exit status is authoritative (CONTRADICTORY_EXECUTION_EVIDENCE), per-run evidence recorded,
 *        every stage including clone bounded by a timeout.
 */
export const QUALIFIER_VERSION = "2.0.0";

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
  /** Which environment produced the verdict - the image digest, or a host description if not in it. */
  mutationQualifiedIn?: string;
  /** Which qualifier produced it, and therefore what the verdict guaranteed. See QUALIFIER_VERSION. */
  mutationQualifiedBy?: string;
  /** The documented sequence. Absent means "npm install, no build" was assumed. */
  install?: string[];
  build?: string[];
  testModule?: string;
  testArgs?: string[];
}

function runShell(args: string[], cwd: string, timeoutMs: number): { status: number | null; out: string; ms: number } {
  assertShellSafeArgs(args, "dogfood-qualify");
  const [exec, ...rest] = args;
  // .cmd shims on Windows can only be spawned through a shell; the argv here is fixed literals.
  const resolved = process.platform === "win32" && !exec!.endsWith(".cmd") ? `${exec}.cmd` : exec!;
  return execBounded(resolved, rest, { cwd, timeoutMs, shell: process.platform === "win32" });
}

/**
 * Summary-shaped lines from a runner's output, wherever they appear.
 *
 * Recorded so a qualification verdict can be audited against what the runner printed. An orchestrator
 * (nx, turbo) emits one summary per project plus its own aggregate, and seeing all of them is the only
 * way to tell a genuinely green run from a first-project-passed misread.
 */
function summaryLines(output: string): string[] {
  return stripAnsi(output)
    .split(/\r?\n/)
    .filter((l) => /Test Files|^\s*Tests\s|No test files|\d+ (passed|failed|skipped)|Successfully ran|targets? failed|NX /i.test(l))
    .map((l) => l.trim())
    .slice(-25);
}

/** No shell: the runner is invoked through `node` so nothing repository-derived is concatenated. */
function runTests(repoPath: string, entry: CorpusEntry, timeoutMs: number): { status: number | null; out: string; ms: number } {
  const module = join(repoPath, entry.testModule ?? "node_modules/vitest/vitest.mjs");
  return execNodeScript(module, entry.testArgs ?? ["run"], { cwd: repoPath, timeoutMs });
}

interface Verdict {
  source: string;
  mutationQualified: Capability;
  reason: string;
  failures?: number;
  framework?: string;
  durations: { clone: number; install: number; build: number; test: number };
  /** Failure count from each baseline run, in order. Differing values are the flakiness signal. */
  observedFailures?: Array<number | undefined>;
  /**
   * What each baseline run actually reported (2026-08-29).
   *
   * Added after a qualification returned "suite green on 2 consecutive runs" whose only artefact was
   * that sentence. The verdict could not be checked against anything, and the parser it rested on reads
   * the FIRST summary line in the output - which for an orchestrator that runs many projects is one
   * project's result, not the run's. A verdict nobody can audit is not evidence.
   */
  evidence?: Array<{ run: number; exitStatus: number | null; failures: number | undefined; summary: string[] }>;
}

/**
 * Progress printed as each stage COMPLETES, not collected and printed at the end.
 *
 * zod-qualify-01 was killed at a three-hour ceiling having printed nothing, so which stage consumed
 * the time is unknowable. A run that gets killed is precisely the run whose partial progress matters,
 * and progress that only exists in a return value never survives the kill.
 */
function stage(name: string, ms: number): void {
  console.log(`      [stage] ${name.padEnd(12)} ${(ms / 1000).toFixed(1)}s`);
}

function qualify(entry: CorpusEntry, scratch: string, timeoutMs: number, baselineRuns: number, cloneDepth: number): Verdict {
  const durations = { clone: 0, install: 0, build: 0, test: 0 };
  const evidence: NonNullable<Verdict["evidence"]> = [];
  const dest = join(scratch, entry.source.replace("/", "__"));

  const cloneStarted = Date.now();
  if (!existsSync(dest)) {
    // FULL clone by default, reversing an earlier shortcut.
    //
    // Qualification only reads HEAD, so a shallow clone looked like free speed. It is not: TanStack's
    // documented build is `nx affected --target=build`, which computes what changed relative to a git
    // base and therefore needs history. Shallow-cloning it produced a disqualification that said more
    // about the harness than the repository.
    //
    // Giving a git-dependent build actual git history is a normal property of that build, not
    // historical environment reconstruction. `--clone-depth` still allows shallow where it is safe.
    const depth = cloneDepth > 0 ? ["--depth", String(cloneDepth)] : [];
    // Bounded like every other stage (2026-08-29). This was the one command in the qualification
    // sequence with NO timeout at all, so a stalled clone could hold a run open indefinitely while
    // every "each command is capped" statement about the harness remained technically true and
    // practically wrong.
    const cloned = execBounded("git", ["clone", "--quiet", ...depth, `https://github.com/${entry.source}.git`, dest], { timeoutMs });
    if (cloned.status !== 0) {
      durations.clone = Date.now() - cloneStarted;
      return { source: entry.source, mutationQualified: "no", reason: "could not clone", durations };
    }
  }
  durations.clone = Date.now() - cloneStarted;
  stage("clone", durations.clone);

  const install = runShell(entry.install ?? ["npm", "install", "--no-audit", "--no-fund"], dest, timeoutMs);
  durations.install = install.ms;
  stage("install", install.ms);
  if (install.status !== 0) {
    return { source: entry.source, mutationQualified: "no", reason: `install failed: ${lastLine(install.out)}`, durations };
  }

  if (entry.build) {
    const built = runShell(entry.build, dest, timeoutMs);
    durations.build = built.ms;
    stage("build", built.ms);
    if (built.status !== 0) {
      return { source: entry.source, mutationQualified: "no", reason: `build failed: ${lastLine(built.out)}`, durations };
    }
  }

  const observed: Array<number | undefined> = [];
  let framework: string | undefined;
  for (let attempt = 0; attempt < baselineRuns; attempt++) {
    const tested = runTests(dest, entry, timeoutMs);
    durations.test += tested.ms;
    stage(`baseline ${attempt + 1}`, tested.ms);
    const parsed = parseTestOutput(tested.out);
    framework ??= parsed.framework;
    observed.push(parsed.failures);
    evidence.push({ run: attempt + 1, exitStatus: tested.status, failures: parsed.failures, summary: summaryLines(tested.out) });

    // Unparseable output is NOT zero failures. A repository whose runner this harness cannot read is
    // unqualified, because every later classification would rest on a number nobody could produce.
    if (parsed.failures === undefined) {
      return { source: entry.source, mutationQualified: "no", reason: `run ${attempt + 1}: could not read a failure count from the runner: ${lastLine(tested.out)}`, durations, observedFailures: observed, evidence };
    }

    // The exit status outranks the parsed count - see scripts/execution-verdict.ts for the invariant
    // and the real false green that produced it.
    if (classifyExecution(tested.status, parsed.failures) === "CONTRADICTORY_EXECUTION_EVIDENCE") {
      return {
        source: entry.source,
        mutationQualified: "no",
        reason: `run ${attempt + 1}: ${explainExecution(tested.status, parsed.failures)}`,
        durations,
        observedFailures: observed,
        evidence,
      };
    }
  }

  const counts = observed as number[];
  const allGreen = counts.every((c) => c === 0);
  const anyGreen = counts.some((c) => c === 0);

  if (allGreen) {
    return { source: entry.source, mutationQualified: "yes", reason: `suite green on ${baselineRuns} consecutive runs under the documented sequence`, failures: 0, framework, durations, observedFailures: observed, evidence };
  }

  // Green once and red once is the dangerous case, and it is called out by name rather than folded
  // into "dirty" - the remedy is different. A dirty repository needs its environment fixed; a flaky
  // one needs its unstable tests identified and excluded, or it must not contribute safety evidence.
  if (anyGreen) {
    return {
      source: entry.source,
      mutationQualified: "no",
      reason: `FLAKY: failure counts differed across runs (${counts.join(", ")}). A flaky baseline does not merely refuse to measure - it produces classifications that may be wrong.`,
      failures: Math.max(...counts),
      framework,
      durations,
      observedFailures: observed,
    };
  }

  return { source: entry.source, mutationQualified: "no", reason: `${counts[0]} test(s) failing at HEAD on every run (${counts.join(", ")})`, failures: counts[0], framework, durations, observedFailures: observed, evidence };
}

/**
 * The most informative line of a failure, which is rarely the last one.
 *
 * TanStack/query recorded its verdict as `install failed: at process.processTimers` - a stack frame,
 * carrying no information about what went wrong. A qualification reason that a future reader cannot
 * act on is barely better than no reason, so this prefers lines that actually name an error and falls
 * back to the tail only when nothing does.
 */
function lastLine(output: string): string {
  const lines = output.trim().split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length === 0) return "no output";

  const meaningful = lines.filter((line) => !/^at\s/.test(line) && !/^\s*\d+\s*\|/.test(line));
  const named = meaningful.find((line) => /\b(ERR_|ERROR|Error:|ELIFECYCLE|ENOENT|EACCES|ETIMEDOUT|failed|not found|Cannot find|unsupported|Unsupported)\b/i.test(line));
  return (named ?? meaningful[meaningful.length - 1] ?? lines[lines.length - 1]!).slice(0, 200);
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
  const baselineRuns = Number(flag("baseline-runs") ?? DEFAULT_BASELINE_RUNS);
  // 0 means a full clone. Builds that ask git what changed need history to answer.
  const cloneDepth = Number(flag("clone-depth") ?? 0);

  const corpus = JSON.parse(readFileSync(corpusPath, "utf8")) as CorpusEntry[];
  const scratch = mkdtempSync(join(tmpdir(), "diffci-qualify-"));

  // A verdict is only meaningful alongside the environment that produced it. A repository that fails
  // on a developer host and passes in the canonical image has not changed; the environment has.
  const validationImage = process.env.DIFFCI_VALIDATION_IMAGE ?? null;
  console.log("\nRepository qualification - can this repository contribute SAFETY evidence?");
  console.log(`  scratch: ${scratch}`);
  console.log(`  environment: ${validationImage ?? `${process.platform}, node ${process.version} (NOT the canonical validation image)`}`);
  console.log(`  qualifier:   ${QUALIFIER_VERSION}`);
  console.log("");

  for (const entry of corpus) {
    if (only && entry.source !== only) continue;
    process.stdout.write(`  ${entry.source.padEnd(28)} `);
    const verdict = qualify(entry, scratch, timeoutMs, baselineRuns, cloneDepth);
    const seconds = Object.values(verdict.durations).reduce((a, b) => a + b, 0) / 1000;
    console.log(`${verdict.mutationQualified === "yes" ? "MUTATION-QUALIFIED" : "not qualified"}  (${seconds.toFixed(0)}s)`);
    console.log(`      ${verdict.reason}`);

    // The verdict's own working. Printed for EVERY outcome, including a green one - a qualification
    // whose only artefact is the sentence "suite green on 2 consecutive runs" cannot be audited by
    // anyone, and that is exactly how a misread orchestrator summary would enter the corpus unchallenged.
    for (const run of verdict.evidence ?? []) {
      console.log(`      run ${run.run}: exit=${run.exitStatus} parsedFailures=${String(run.failures)}`);
      for (const line of run.summary) console.log(`        | ${line}`);
    }

    if (write) {
      entry.mutationQualified = verdict.mutationQualified;
      entry.mutationQualificationReason = verdict.reason;
      entry.mutationQualifiedAt = new Date().toISOString();
      entry.mutationQualifiedIn = validationImage ?? `${process.platform}/node${process.version}`;
      entry.mutationQualifiedBy = `qualifier ${QUALIFIER_VERSION}`;
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
