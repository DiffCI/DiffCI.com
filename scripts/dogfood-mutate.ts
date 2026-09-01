/**
 * The mutation-recall pass: turns unfalsifiable observations into a safety measurement.
 *
 * WHY THIS EXISTS. The observation corpus records what DiffCI *would* have selected. On green-to-green
 * history that can never be falsified: no test changes outcome between base and head, so every
 * non-selected test passes whether or not DiffCI's reasoning was sound. A corpus of clean merges
 * cannot support a safety claim at any size. This pass introduces a failure whose blast radius is
 * known, and asks whether DiffCI's selection would have caught it.
 *
 *   historical merge -> full baseline -> controlled mutation -> full mutated run
 *                    -> DiffCI selection -> selected mutated run -> classification
 *
 * THE MUTATION. Whole-file revert of a source file the merge itself changed, back to its exact
 * pre-merge content (src/analysis-fanout/mutation.ts). Not a synthetic bug: "if this change were
 * undone, would the suite notice?" is precisely the regression the merge's own tests exist to catch,
 * it generalises to any merge on any repository without per-case authoring, and it cannot produce a
 * syntactically invalid file because the base version was itself real.
 *
 * WHY THE FULL RUN COMES FIRST, TWICE. A mutation that the FULL suite does not detect measures
 * nothing about DiffCI - the tests simply do not cover that behaviour. Counting those as successes
 * would inflate recall with cases where recall was never at stake. So the full mutated run is the
 * gate: only when it detects the mutation does the selected run mean anything.
 *
 * SELECTION CORRECTNESS IS NOT ECONOMICS. Nothing here is tuned to make DiffCI look good or to
 * produce large savings. The mutation's only job is to establish whether an affected behaviour is
 * detectable outside the proposed selection.
 */
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { selectFileToMutate } from "../src/analysis-fanout/mutation.js";
import { execBounded, type BoundedExecResult } from "./process-exec.js";
import { assertShellSafeArgs } from "./shell-safety.js";
import { parseTestOutput } from "./test-output-parsers.js";


const repoRoot = resolve(dirname(import.meta.filename), "..");

export type Classification =
  /** Full run detects the mutation, and so does the selected subset. DiffCI would have caught it. */
  | "RECALL_CONFIRMED"
  /** Full run detects it, the selected subset does NOT. DiffCI would have reported a false green. */
  | "FALSE_GREEN"
  /** The full suite does not detect the mutation at all, so recall was never at stake here. */
  | "RECALL_UNMEASURABLE"
  /** The suite was not green before the mutation - nothing measured here can be attributed to DiffCI. */
  | "ENVIRONMENT_DIRTY"
  /** The harness itself failed: install error, timeout, no revertible file, missing selection. */
  | "INVALID_RUN"
  /**
   * Baseline is green; this commit MAY be mutated. Only produced by a `--qualify-only` run.
   *
   * Qualification exists because discovering a dirty baseline after ten minutes of install, build and
   * a mutation loop is ten minutes wasted. A repository earns the right to contribute safety evidence
   * BEFORE any mutation is generated, not after.
   */
  | "BASELINE_QUALIFIED";

/**
 * How much execution the selection authorised, relative to the comparator DiffCI itself carries.
 *
 * DELIBERATELY INDEPENDENT OF RECALL. A RECALL_CONFIRMED verdict says the selection contained the
 * test that catches the mutation; it says nothing about the other 123 tests it also ran. On a
 * tightly-coupled monorepo DiffCI has been observed selecting ~65% of a suite where a simple path
 * rule selected far less - safe, and economically worse than knowing nothing. Reporting a single
 * verdict would let "we caught it" quietly stand in for "this was worth running", so the two are
 * scored separately and printed separately.
 */
export type Efficiency =
  /** Fewer tests than the path-rule comparator. DiffCI earned its place. */
  | "EFFICIENT"
  /** Within a test or two of the comparator - the graph bought nothing measurable either way. */
  | "COMPARABLE"
  /** MORE tests than the comparator. Safe, and worse than a rule that knows nothing about the graph. */
  | "SELECTION_OVERBROAD";

/**
 * Runs the comparator's and DiffCI's selections on the unmutated tree and records what each cost.
 *
 * WHAT MAKES A CANDIDATE ECONOMICALLY UNMEASURABLE. Any arm that exits non-zero, or whose CPU could not
 * be read, or whose selection is unavailable. In every one of those cases the arm is recorded with
 * whatever was observed and `measurable` is false - the missing quantity is NEVER substituted with
 * zero, because a zero-cost arm is exactly the error that would manufacture savings.
 *
 * An empty comparator selection is a legitimate measurement, not a failure: a path rule that selects
 * nothing genuinely costs nothing to run, and that is a real (and very hard to beat) comparator.
 */
function measureEconomicArms(
  candidate: Candidate,
  testExec: string,
  fullArgs: string[],
  baseline: { cpuSeconds?: number; ms: number; status: number | null },
  timeoutMs: number,
): NonNullable<MutationResult["economics"]> {
  const { repoPath, comparatorTests, selectedTests } = candidate;

  /**
   * Exactly the shape the safety pass uses for its selected run: the runner's module, then its
   * arguments, then the files.
   *
   * The module path is NOT optional (2026-08-30). Omitting it produced `node run <files>` - node trying
   * to execute a file called "run" - which exited 1 instantly on all 22 hono candidates. The
   * measurability guard caught it and reported 22/22 compute-unmeasurable. Had a failed arm defaulted to
   * zero cost instead, the run would have reported a near-zero DiffCI execution cost against a real
   * full-suite cost and looked like an extraordinary result.
   *
   * Glob arguments are filtered out for the same reason the safety pass filters them: a pattern
   * alongside explicit file paths widens the run back out and stops it being a subset at all.
   */
  const armArgs = (files: string[]): string[] => [...fullArgs.filter((a) => !isFileGlob(a)), ...files];

  const full: ArmCost = { cpuSeconds: baseline.cpuSeconds, wallMs: baseline.ms, exitStatus: baseline.status };

  // An empty selection is not executed - there is nothing to run, and spawning a runner with no files
  // would measure the runner's startup rather than the selection's cost.
  const runArm = (files: string[]): ArmCost =>
    files.length === 0
      ? { cpuSeconds: 0, wallMs: 0, exitStatus: 0 }
      : ((r) => ({
          cpuSeconds: r.cpuSeconds,
          wallMs: r.ms,
          exitStatus: r.status,
          outputTail: r.status === 0 ? undefined : outputTail(r),
        }))(run(testExec, armArgs(files), repoPath, timeoutMs));

  const comparator = { ...runArm(comparatorTests), selectedCount: comparatorTests.length };
  const diffciSelected = { ...runArm(selectedTests), selectedCount: selectedTests.length };

  const problems: string[] = [];
  if (comparatorTests.length === 0 && candidate.baselineSelected !== 0) {
    // Agent A produced no identities. Counted, but not executable - so not costable.
    problems.push("comparator selection unavailable (observed by an agent generation that did not expose pathBaseline.selectedTests)");
  }
  for (const [name, arm] of [
    ["full", full],
    ["comparator", comparator],
    ["diffci-selected", diffciSelected],
  ] as const) {
    if (arm.exitStatus !== 0) problems.push(`${name} arm exited ${String(arm.exitStatus)}`);
    if (arm.cpuSeconds === undefined) problems.push(`${name} arm CPU could not be measured`);
  }

  // The incremental figure cannot be formed without it, so its absence makes a candidate
  // compute-unmeasurable just as surely as a failed execution arm does.
  if (candidate.jointAnalysisCpuSeconds === undefined) {
    problems.push("joint analysis CPU was not recorded by the observation pass");
  }

  return {
    treeState: "unmutated-baseline",
    measurable: problems.length === 0,
    unmeasurableReason: problems.length > 0 ? problems.join("; ") : undefined,
    full,
    comparator,
    diffciSelected,
  };
}

/**
 * Is this argument a FILE pattern that would widen a subset run back out to everything?
 *
 * The reason the filter exists: a glob like `src/**\/*.test.ts` sitting beside explicit file paths makes
 * the run match everything again, so it costs the full suite while claiming to cost a selection.
 *
 * The reason it is not simply `includes("*")` (2026-08-30): plenty of legitimate FLAG VALUES contain a
 * star. `vitest --project unit*` is vuejs/core's own documented unit-test invocation, and stripping
 * `unit*` would leave `--project` to swallow the next argument - a test file path - mangling the command
 * rather than narrowing it. The FULL arm does not strip, so the arms would stop being comparable while
 * still producing numbers.
 *
 * A file pattern is distinguished by looking like a path: it contains a separator or a test-file
 * extension. A bare token like `unit*` is a value, not a path.
 */
function isFileGlob(arg: string): boolean {
  if (!arg.includes("*")) return false;
  // A path pattern either recurses (`**`) or ends in a file extension. A scoped package filter such as
  // `@vitest/test-*` contains a slash but is neither, which is why a bare slash check is not enough.
  // Erring toward NOT stripping is the safe direction: an unstripped file glob widens the selected arm
  // and overstates DiffCI's cost, whereas stripping a flag value mangles the command outright.
  return arg.includes("**") || /\.\w+$/.test(arg);
}

/** One measured execution arm. CPU is the unit that matters; wall time is kept beside it, never instead. */
interface ArmCost {
  /** undefined where CPU could not be measured. Never 0 - see compute-usage.ts. */
  cpuSeconds?: number;
  wallMs: number;
  exitStatus: number | null;
  /**
   * What the arm printed, recorded ONLY when it failed.
   *
   * An exit status says an arm failed; it does not say why. Diagnosing the 2026-08-30 armArgs defect
   * required reasoning backwards from a bare exit code across 22 identical rows, which is the same gap
   * that cost four container runs on the ANSI defect. A failing arm now carries its own explanation.
   */
  outputTail?: string;
}

/** One arm's outcome against a mutation: did this test set see the defect, and what did it cost. */
interface ComparatorArm {
  detected: boolean | undefined;
  failures: number | undefined;
  cpuSeconds?: number;
  wallMs: number;
  selectedCount: number;
}

interface MutationResult {
  repository: string;
  headSha: string;
  baseSha: string;
  classification: Classification;
  /**
   * The comparator run against the SAME mutation. Added 2026-08-31, closing amendment M3's gap.
   *
   * `detected: true` alongside a caught DiffCI arm means the path rule would have caught it too — so
   * DiffCI demonstrated safety but no unique mechanism advantage on that candidate. Undefined when the
   * observation exposed no comparator list: unmeasurable, never scored as a miss.
   */
  comparatorMutated?: ComparatorArm;
  /** Scored only when the safety question was answerable; undefined otherwise. */
  efficiency?: Efficiency;
  /** The evidence behind `efficiency`, so the verdict can be re-derived rather than trusted. */
  selection?: {
    selected: number;
    total: number;
    baselineSelected: number | undefined;
    /** Positive means DiffCI ran MORE than the comparator. */
    versusBaseline: number | undefined;
    /** Selected tests that actually failed. Everything else selected was unnecessary for THIS mutation. */
    detecting: number;
  };
  reason: string;
  mutatedFile?: string;
  selectedCount?: number;
  totalCount?: number;
  baselineFailures?: number;
  fullMutatedFailures?: number;
  selectedMutatedFailures?: number;
  /** Failures the full mutated run saw that the selected run did not - the evidence behind FALSE_GREEN. */
  missedBySelection?: string[];
  /** Every file this pass reverted, in order. Records how hard it had to look for a measurable one. */
  attemptedFiles?: string[];
  durations?: { install: number; baseline: number; fullMutated: number; selectedMutated: number };
  /**
   * Raw compute components for the economics question (2026-08-29). No derived percentages here - the
   * headline is computed after freezing, from these.
   *
   * ALL THREE EXECUTION ARMS RUN ON THE UNMUTATED TREE, immediately after the green baseline. That is
   * the state a customer's CI is actually in day to day, and running the arms in one tree state is what
   * makes their costs comparable at all. The mutated runs that follow are for SAFETY classification and
   * are deliberately not reused here.
   *
   * `jointAnalysisCpuSeconds` is joint on purpose: the comparator's selection is computed from
   * `profile`, which is produced BY the dependency-graph build, so it cannot be obtained without the
   * expensive step DiffCI needs. There is no defensible split, so the whole cost is charged to DiffCI -
   * which hands the comparator its selection logic free and makes any DiffCI win the stronger claim.
   *
   * Any arm that failed, timed out, or could not be measured sets `measurable: false`. A missing arm is
   * never recorded as zero cost, which is the direction that would flatter DiffCI.
   */
  economics?: {
    treeState: "unmutated-baseline";
    measurable: boolean;
    unmeasurableReason?: string;
    full: ArmCost;
    comparator: ArmCost & { selectedCount: number };
    diffciSelected: ArmCost & { selectedCount: number };
    jointAnalysisCpuSeconds?: number;
  };
  /**
   * What the runner actually printed when its output could not be parsed (2026-08-29).
   *
   * Added after a canonical-environment run returned INVALID_RUN for all 22 candidates with the single
   * reason "could not parse the baseline run's failure count" and NOTHING ELSE - no exit status, no
   * output, no way to tell a crashed runner from a missing module from a timeout without re-running the
   * whole experiment. The refusal to parse was correct; discarding the evidence of WHY was not. This is
   * diagnostic only and is recorded on the failure path, so it cannot influence any classification.
   */
  diagnostics?: {
    stage: "baseline" | "full-mutated" | "selected-mutated";
    exitStatus: number | null;
    /** Tail, not the whole log - enough to identify the failure, bounded so a run stays readable. */
    outputTail: string;
  };
  observedAt: string;
}

/**
 * How to install and test one repository.
 *
 * Two commands, not one, and deliberately shaped differently. INSTALL may go through a shell because
 * its arguments are fixed literals - corepack and pnpm are .cmd shims on Windows and cannot be spawned
 * any other way. TEST may NOT, because the selected run appends repository-derived test paths, so it
 * invokes the runner's own JS entry point under `node` instead. That split is the shell invariant in
 * practice rather than in prose.
 */
interface RepoCommands {
  /** e.g. ["corepack", "pnpm", "install", "--frozen-lockfile"]. Fixed literals only. */
  install: string[];
  /** Path, relative to the repository, of the test runner's JS entry. e.g. node_modules/vitest/vitest.mjs */
  testModule: string;
  /** Arguments before any file list. e.g. ["run"] for vitest. */
  testArgs: string[];
  /**
   * Optional build, run after install and before any test run.
   *
   * Needed more often than it looks. Every zod candidate came back ENVIRONMENT_DIRTY because its
   * treeshaking tests fail with "Run `pnpm build` first" unless the workspace packages are built -
   * the harness correctly refusing to measure, for a reason that was configuration rather than code.
   */
  build?: string[];
}

const DEFAULT_COMMANDS: RepoCommands = {
  // args[0] is the executable, so the package manager has to be named here. Omitting it made the
  // harness try to run a command called "install" and report INVALID_RUN for every candidate.
  install: ["npm", "install", "--no-audit", "--no-fund", "--silent"],
  testModule: "node_modules/tsx/dist/cli.mjs",
  testArgs: ["--test", "tests/**/*.test.ts"],
};

interface Candidate {
  repository: string;
  repoPath: string;
  baseSha: string;
  headSha: string;
  selectedTests: string[];
  totalCount: number;
  changedFiles: string[];
  commands: RepoCommands;
  /** What the path-rule comparator selected for this same commit, carried from the observation row. */
  baselineSelected: number | undefined;
  /**
   * The comparator's actual test files, so its arm can be EXECUTED rather than only counted.
   *
   * Requires agent generation B, which exposes `pathBaseline.selectedTests`. Empty when observed by
   * generation A, in which case the candidate is economically unmeasurable - never silently costed as
   * zero.
   */
  comparatorTests: string[];
  /** Joint analysis CPU from the observation row - see the economics block on MutationResult. */
  jointAnalysisCpuSeconds: number | undefined;
}

/**
 * Runs a real executable with NO shell. Every test invocation goes through here, because those
 * arguments are repository-derived test file paths and must reach the process verbatim.
 */
function run(command: string, args: string[], cwd: string, timeoutMs: number): BoundedExecResult {
  // Through execBounded, the same primitive qualification uses and the calibration suite measures. It
  // also fixes a divergence that lived here unnoticed: this path - the one that executes TEST SUITES,
  // and therefore the one that produced every mutation classification so far - set only CI and
  // FORCE_COLOR, while the install path beside it set the full non-interactive environment. Two
  // definitions of "how this harness runs a process" inside one script is exactly the gap a shared
  // primitive exists to close. The two additional variables (corepack's download prompt, npm's
  // auto-yes) have no effect on a test runner, so this does not disturb evidence already collected.
  return execBounded(command, args, { cwd, timeoutMs });
}

/**
 * Runs npm, which on Windows is a .cmd shim and therefore REQUIRES a shell - Node refuses to spawn
 * batch files directly since CVE-2024-27980. Permitted here only because every argument is a fixed
 * literal, and asserted rather than assumed. This is exactly the split the invariant describes: a
 * shell is acceptable when nothing repository-derived is concatenated into the command line.
 */
/** Extra directory prepended to PATH for child processes - where package-manager shims are placed. */
let shimDir: string | undefined;

function runShellCommand(args: string[], cwd: string, timeoutMs: number): BoundedExecResult {
  assertShellSafeArgs(args, "dogfood-mutate: install");
  const [exec, ...rest] = args;
  // npm, npx, pnpm and corepack are all .cmd shims on Windows. Resolving the suffix here keeps the
  // corpus configuration platform-neutral.
  const resolved = process.platform === "win32" && !exec!.endsWith(".cmd") ? `${exec}.cmd` : exec!;
  return execBounded(resolved, rest, { cwd, timeoutMs, shell: process.platform === "win32" });
}

/**
 * Delegates to the per-runner adapters in ./test-output-parsers.ts, which understand node:test,
 * vitest, jest and mocha. The contract that matters is preserved there and relied on here:
 * unrecognised output yields `undefined`, never `0`, so a run that proved nothing can never be
 * classified as a run that proved something.
 */
function parseFailures(output: string): { failures: number | undefined; failedNames: string[] } {
  const parsed = parseTestOutput(output);
  return { failures: parsed.failures, failedNames: parsed.failedNames };
}

/**
 * The tail of what a runner printed, for the record rows that could not parse it.
 *
 * stderr first: when a runner dies rather than reports (a missing module, a config error, a killed
 * process), the reason is on stderr, and stdout is usually empty or a banner. An empty tail is itself
 * informative - it distinguishes "printed something we do not understand" from "printed nothing at
 * all", which are different failures with different fixes.
 */
function outputTail(result: { stdout: string; stderr: string }, limit = 800): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const combined = [stderr && `[stderr] ${stderr}`, stdout && `[stdout] ${stdout}`].filter(Boolean).join("\n");
  if (combined.length === 0) return "(no output on either stream)";

  // A plain tail is not enough. hono's suite ends with a coverage table hundreds of lines long, so the
  // last 800 characters showed the coverage report and nothing about whether a summary line existed at
  // all (2026-08-29). Summary-shaped lines are extracted by content, wherever they appear, because
  // "printed a summary we could not parse" and "printed no summary" are different failures.
  const summary = combined
    .split(/\r?\n/)
    .filter((l) => /Test Files|^\s*Tests\s|No test files|\d+ (passed|failed|skipped)|FAIL|Error:/i.test(l))
    .slice(-20)
    .join("\n");

  return [
    `--- summary-shaped lines (${summary ? summary.split("\n").length : 0}) ---`,
    summary || "(none found - the runner printed no line resembling a test summary)",
    `--- last ${limit} chars ---`,
    combined.slice(-limit),
  ].join("\n");
}

function loadCandidates(corpusPath: string, repoPath: string, reportsDir: string, commands: RepoCommands, onlyRepository?: string): Candidate[] {
  const rows = readFileSync(corpusPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map(
      (line) =>
        JSON.parse(line) as {
          identity: { repository: string; baseSha: string; headSha: string };
          decision: { mode: string; selected: number | "unknown"; total: number | "unknown" };
          counterfactual?: { baselineSelected: number | "unknown" };
          economics?: { jointAnalysisCpuSeconds?: number };
        },
    );

  const candidates: Candidate[] = [];
  for (const row of rows) {
    // Only SELECTIVE decisions that actually selected something. A SELECTIVE-with-zero decision on a
    // docs or asset commit is excluded on purpose: mutating a file that commit did not touch would
    // test an artificial relationship the real commit does not contain.
    // A corpus may hold several repositories; this pass has exactly one checkout. Without this filter
    // every other repository’s candidates are attempted against the wrong tree and come back
    // INVALID_RUN - noise that buries the real classifications.
    if (onlyRepository !== undefined && row.identity.repository !== onlyRepository) continue;
    if (row.decision.mode !== "SELECTIVE") continue;
    if (typeof row.decision.selected !== "number" || row.decision.selected === 0) continue;

    const reportPath = join(reportsDir, `${row.identity.headSha.slice(0, 12)}.json`);
    if (!existsSync(reportPath)) continue;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
      result: { selectedTests?: string[]; changedFiles?: string[]; pathBaseline?: { selectedTests?: string[] } };
    };

    candidates.push({
      repository: row.identity.repository,
      repoPath,
      baseSha: row.identity.baseSha,
      headSha: row.identity.headSha,
      selectedTests: report.result.selectedTests ?? [],
      totalCount: typeof row.decision.total === "number" ? row.decision.total : 0,
      changedFiles: report.result.changedFiles ?? [],
      commands,
      baselineSelected: typeof row.counterfactual?.baselineSelected === "number" ? row.counterfactual.baselineSelected : undefined,
      comparatorTests: report.result.pathBaseline?.selectedTests ?? [],
      jointAnalysisCpuSeconds: typeof row.economics?.jointAnalysisCpuSeconds === "number" ? row.economics.jointAnalysisCpuSeconds : undefined,
    });
  }
  return candidates;
}

/** Non-test, non-asset source files this merge changed - the only legitimate mutation targets. */
function mutationTargets(changedFiles: string[]): string[] {
  return changedFiles.filter((path) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) && !/\.(test|spec)\./.test(path) && !path.startsWith("tests/"));
}

function classify(candidate: Candidate, timeoutMs: number, maxAttempts: number, qualifyOnly: boolean): MutationResult {
  const { commands } = candidate;
  const testExec = process.execPath;
  const testModulePath = join(candidate.repoPath, commands.testModule);
  const fullArgs = [testModulePath, ...commands.testArgs];
  // The selected run is the SAME runner with file paths appended - never a different runner, which
  // would measure the runner rather than the selection.
  const selectedArgs = [testModulePath, ...commands.testArgs.filter((a) => !isFileGlob(a)), ...candidate.selectedTests];
  const base: MutationResult = {
    repository: candidate.repository,
    headSha: candidate.headSha,
    baseSha: candidate.baseSha,
    classification: "INVALID_RUN",
    reason: "",
    selectedCount: candidate.selectedTests.length,
    totalCount: candidate.totalCount,
    observedAt: new Date().toISOString(),
  };

  const checkout = run("git", ["checkout", "--quiet", "--force", candidate.headSha], candidate.repoPath, 60_000);
  if (checkout.status !== 0) return { ...base, reason: `could not check out ${candidate.headSha.slice(0, 9)}` };

  const install = runShellCommand(commands.install, candidate.repoPath, 20 * 60_000);
  if (install.status !== 0) {
    const detail = (install.stderr.trim() || install.stdout.trim()).split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${install.status}`;
    return { ...base, reason: `dependency install failed: ${detail.slice(0, 200)}` };
  }

  if (commands.build) {
    const built = runShellCommand(commands.build, candidate.repoPath, 20 * 60_000);
    if (built.status !== 0) {
      const detail = (built.stderr.trim() || built.stdout.trim()).split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${built.status}`;
      return { ...base, reason: `build failed: ${detail.slice(0, 200)}` };
    }
  }

  // 1. BASELINE. The suite must be green before mutation, or nothing after it can be attributed.
  const baseline = run(testExec, fullArgs, candidate.repoPath, timeoutMs);
  const baselineParsed = parseFailures(baseline.stdout + baseline.stderr);
  if (baselineParsed.failures === undefined) {
    return {
      ...base,
      reason: "could not parse the baseline run's failure count",
      diagnostics: { stage: "baseline", exitStatus: baseline.status, outputTail: outputTail(baseline) },
    };
  }
  if (baselineParsed.failures > 0) {
    return { ...base, classification: "ENVIRONMENT_DIRTY", reason: `${baselineParsed.failures} test(s) already failing before mutation`, baselineFailures: baselineParsed.failures };
  }

  // 1b. THE ECONOMICS ARMS, measured here and nowhere else.
  //
  // On the UNMUTATED tree, immediately after a green baseline. That is the state a customer's CI is in
  // day to day, and running all three arms in one tree state is what makes their costs comparable. The
  // mutated runs below exist to answer the SAFETY question and are deliberately not reused for cost:
  // a failing suite formats errors and stacks that a passing one does not.
  //
  // FULL is the baseline run just completed - no need to pay for it twice.
  // Attached to `base`, so every classification returned below carries its cost measurement - including
  // the ones that go on to be RECALL_UNMEASURABLE. Safety and economics are independent questions and a
  // candidate can answer one without the other.
  base.economics = { ...measureEconomicArms(candidate, testExec, fullArgs, baseline, timeoutMs), jointAnalysisCpuSeconds: candidate.jointAnalysisCpuSeconds };

  // The qualification gate. A candidate reaches mutation only from here, and a --qualify-only run
  // stops at exactly this point - the whole purpose being to reject a repository cheaply rather than
  // after a mutation loop has already spent the time.
  if (qualifyOnly) {
    return { ...base, classification: "BASELINE_QUALIFIED", reason: "baseline is green; this commit may be mutated", baselineFailures: 0 };
  }

  // 2. MUTATE. Each changed source file is tried in turn until one produces a full-suite failure.
  //
  // WHAT THIS CHANGES ABOUT THE SAMPLE, said plainly. An earlier version stopped at the merge's FIRST
  // changed source file. When that file happened to be untested - a build script, say - the case died
  // as RECALL_UNMEASURABLE even though the same merge changed other files whose behaviour the suite
  // does cover. That depressed the measurable rate for a reason that has nothing to do with DiffCI.
  //
  // Iterating is NOT cherry-picking: the population is still only files this merge actually changed,
  // and the full-suite gate is untouched, so no mutation can be counted that the suite cannot see.
  // But it does move what is being sampled, from "a merge's first changed file" to "any measurable
  // file in a merge". The second is the more useful question and the one worth reporting - which is
  // why `attemptedFiles` is recorded on every row rather than left implicit.
  const targets = mutationTargets(candidate.changedFiles);
  if (targets.length === 0) return { ...base, reason: "the merge changed no non-test source file" };

  const attemptedFiles: string[] = [];
  let capped = false;

  for (const target of targets) {
    if (attemptedFiles.length >= maxAttempts) {
      capped = true;
      break;
    }

    const mutation = selectFileToMutate(candidate.repoPath, candidate.baseSha, [target]);
    // Newly added by this merge, so there is no earlier version to revert to. Not an attempt.
    if (!mutation) continue;

    attemptedFiles.push(mutation.path);
    const mutatedPath = join(candidate.repoPath, mutation.path);
    const headContent = readFileSync(mutatedPath, "utf8");
    writeFileSync(mutatedPath, mutation.baseContent);

    try {
      // 3. FULL MUTATED. The gate: if the whole suite cannot see this, recall was never at stake.
      const fullMutated = run(testExec, fullArgs, candidate.repoPath, timeoutMs);
      const fullParsed = parseFailures(fullMutated.stdout + fullMutated.stderr);
      if (fullParsed.failures === undefined) {
        return { ...base, reason: `could not parse the full mutated run's failure count for ${mutation.path}`, mutatedFile: mutation.path, attemptedFiles };
      }
      // Not measurable through this file. Restore it and try the next one rather than giving up.
      if (fullParsed.failures === 0) continue;

      // 4. SELECTED MUTATED. Only DiffCI's chosen tests. This is the measurement.
      const selectedMutated = run(testExec, selectedArgs, candidate.repoPath, timeoutMs);
      const selectedParsed = parseFailures(selectedMutated.stdout + selectedMutated.stderr);
      if (selectedParsed.failures === undefined) {
        return { ...base, reason: `could not parse the selected mutated run's failure count for ${mutation.path}`, mutatedFile: mutation.path, attemptedFiles };
      }

      // 5. COMPARATOR MUTATED. Added 2026-08-31, BEFORE any GENERATION_C_01 mutation result existed.
      //
      // Amendment M3 recorded that this arm did not exist: the comparator was measured for COST on the
      // clean tree and never for RECALL on the mutated one, so "did DiffCI catch something a path rule
      // would have missed?" was unanswerable. Without it, a caught mutation reads as a DiffCI win even
      // when the trivial comparator catches it too.
      //
      // Same runner, comparator file list, exactly as the DiffCI arm is run. Left undefined when the
      // observation exposed no comparator list - unmeasurable, and never scored as a miss.
      let comparatorMutated: ComparatorArm | undefined;
      if (candidate.comparatorTests.length > 0) {
        const comparatorArgs = [testModulePath, ...commands.testArgs.filter((a) => !isFileGlob(a)), ...candidate.comparatorTests];
        const comparatorRun = run(testExec, comparatorArgs, candidate.repoPath, timeoutMs);
        const comparatorParsed = parseFailures(comparatorRun.stdout + comparatorRun.stderr);
        comparatorMutated = {
          detected: comparatorParsed.failures === undefined ? undefined : comparatorParsed.failures > 0,
          failures: comparatorParsed.failures,
          cpuSeconds: comparatorRun.cpuSeconds,
          wallMs: comparatorRun.ms,
          selectedCount: candidate.comparatorTests.length,
        };
      }

      const missed = fullParsed.failedNames.filter((name) => !selectedParsed.failedNames.includes(name));
      const detected = selectedParsed.failures > 0;

      // Efficiency is judged against the comparator DiffCI carries in its own report, never against
      // the full suite - "fewer than everything" is trivially true and tells nobody anything. The
      // +/-2 band exists because a one-test difference is noise, not a verdict.
      const selectedCount = candidate.selectedTests.length;
      const comparatorSelected = candidate.baselineSelected;
      const versusBaseline = comparatorSelected === undefined ? undefined : selectedCount - comparatorSelected;
      const efficiency: Efficiency =
        versusBaseline === undefined || Math.abs(versusBaseline) <= 2 ? "COMPARABLE" : versusBaseline > 0 ? "SELECTION_OVERBROAD" : "EFFICIENT";

      return {
        ...base,
        classification: detected ? "RECALL_CONFIRMED" : "FALSE_GREEN",
        efficiency,
        selection: { selected: selectedCount, total: candidate.totalCount, baselineSelected: comparatorSelected, versusBaseline, detecting: selectedParsed.failures },
        comparatorMutated,
        reason: detected
          ? `reverting ${mutation.path} failed the full suite and DiffCI's selection caught it`
          : `reverting ${mutation.path} failed the full suite but NOT DiffCI's ${candidate.selectedTests.length}-test selection`,
        mutatedFile: mutation.path,
        attemptedFiles,
        baselineFailures: 0,
        fullMutatedFailures: fullParsed.failures,
        selectedMutatedFailures: selectedParsed.failures,
        missedBySelection: missed.slice(0, 20),
        durations: { install: install.ms, baseline: baseline.ms, fullMutated: fullMutated.ms, selectedMutated: selectedMutated.ms },
      };
    } finally {
      // Always restored, on every path: the next attempt must start from real history.
      writeFileSync(mutatedPath, headContent);
    }
  }

  if (attemptedFiles.length === 0) {
    return { ...base, reason: "every changed source file was newly added, so none can be reverted", attemptedFiles };
  }

  return {
    ...base,
    classification: "RECALL_UNMEASURABLE",
    reason: capped
      ? `none of the first ${attemptedFiles.length} changed source files produced a full-suite failure (capped at ${maxAttempts}; ${targets.length} were available)`
      : `none of this merge's ${attemptedFiles.length} revertible source files produced a full-suite failure, so its own tests do not cover them`,
    attemptedFiles,
    baselineFailures: 0,
    fullMutatedFailures: 0,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const corpusPath = resolve(flag("corpus") ?? join(repoRoot, ".dogfood", "corpus.jsonl"));
  const reportsDir = resolve(flag("reports") ?? "");
  const repoPath = resolve(flag("repo") ?? "");
  const qualifyOnly = args.includes("--qualify-only");

  /**
   * Every invocation gets its own immutable run directory, and refuses to reuse one.
   *
   * The predecessor took a `--out` path, truncated it and appended. A run killed at a foreground time
   * limit outlived the kill and kept appending while a backgrounded rerun had already truncated the
   * same file: two processes, one file, thirteen rows for nine candidates, and a corpus whose
   * provenance could not be established. `mkdirSync` without `recursive` is an atomic exclusive
   * create, so a second process asking for the same identity fails immediately rather than silently
   * co-authoring a fictional experiment.
   */
  const runsDir = resolve(flag("runs-dir") ?? join(repoRoot, ".dogfood", "runs"));
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}-${(flag("repository") ?? "adhoc").replace(/[^A-Za-z0-9]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const runDir = join(runsDir, runId);
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(runDir); // deliberately not recursive: fails if this identity already exists
  const outPath = join(runDir, "results.jsonl");
  const timeoutMs = Number(flag("timeout") ?? 20 * 60_000);
  // Each attempt costs one full-suite run, so the search is bounded. A capped case says so in its
  // reason rather than silently looking like a merge with no measurable files.
  const maxAttempts = Number(flag("max-attempts") ?? 5);
  // The repository's own test command. Full runs use it as-is; selected runs replace its final
  // argument (the glob) with the selected files, so both sides use the SAME runner - comparing a
  // vitest full run against a node --test selected run would measure the runner, not the selection.
  // Per-repository, because every project installs and tests differently. Pipe-separated rather than
  // space-separated so a value may itself contain a space.
  //
  //   --install "corepack|pnpm|install|--frozen-lockfile"
  //   --test-module "node_modules/vitest/vitest.mjs"  --test-args "run"
  //
  // The install command may reach a .cmd shim through a shell (fixed literals, asserted). The test
  // module is invoked through `node` so the selected run can append repository-derived paths without
  // one. That asymmetry is the shell invariant, applied.
  // PRESENT-BUT-EMPTY IS NOT ABSENT (2026-09-01).
  //
  // These read `flag(x) ? ... : DEFAULT`, so a caller passing an EMPTY value silently got the default
  // instead. `genc-mutate-01` is what that costs: eslint-plugin-jest legitimately needs no extra test
  // arguments, so `--test-args ""` was passed, the empty string was falsy, and the vitest-shaped
  // default `["--test", "tests/**/*.test.ts"]` was substituted. Jest rejected `--test`, the baseline
  // could not be parsed, and the run died INVALID_RUN having measured nothing.
  //
  // The repository was fine and DiffCI was never exercised. Same family as `unknown != negative`: an
  // empty declaration is a declaration, and only an ABSENT flag may fall back to a default.
  const present = (key: string): boolean => args.includes(`--${key}`);
  const commands: RepoCommands = {
    install: present("install") ? flag("install")!.split("|").filter(Boolean) : DEFAULT_COMMANDS.install,
    testModule: flag("test-module") ?? DEFAULT_COMMANDS.testModule,
    testArgs: present("test-args") ? flag("test-args")!.split("|").filter(Boolean) : DEFAULT_COMMANDS.testArgs,
    // This was omitted once, and the run manifest is the only reason anyone noticed: a qualification
    // run passed --build, the flag was never read, and the result was byte-identical to the run it was
    // supposed to differ from. Identical failure counts are what gave it away.
    build: present("build") ? flag("build")!.split("|").filter(Boolean) : undefined,
  };

  if (!existsSync(corpusPath)) throw new Error(`no corpus at ${corpusPath} - run: npm run dogfood`);
  if (!existsSync(reportsDir)) throw new Error("--reports <dir> is required (the dogfood run prints where it kept them)");
  if (!existsSync(repoPath)) throw new Error("--repo <path> is required (the scratch clone the dogfood run used)");

  const candidates = loadCandidates(corpusPath, repoPath, reportsDir, commands, flag("repository"));
  writeFileSync(outPath, "");

  // The manifest is written BEFORE any work, so an interrupted run still says what it was attempting.
  // A `COMPLETE` sentinel is written only at the end; a directory without one is a partial run and any
  // aggregation should skip it rather than quietly include half an experiment.
  const agentVersions = [...new Set(candidates.map((c) => c.repository))];
  const manifest = {
    runId,
    startedAt,
    mode: qualifyOnly ? "qualify-only" : "mutate",
    repository: flag("repository") ?? "(unfiltered)",
    repoPath,
    corpusPath,
    reportsDir,
    commands,
    maxAttempts,
    timeoutMs,
    candidates: candidates.length,
    candidateShas: candidates.map((c) => c.headSha),
    repositoriesInScope: agentVersions,
    node: process.version,
    platform: process.platform,
    /**
     * The environment the evidence was produced in.
     *
     * "Node 22 on Linux" stops being a reproducible description the moment the image is rebuilt with
     * different transitive system packages. Safety evidence has to identify the whole chain -
     * repository SHA, agent digest, validation-image digest, commands, mutation, results - or a
     * reviewer six weeks later cannot tell whether a result would still reproduce.
     *
     * null means the run was NOT executed inside the canonical validation image, which is itself worth
     * recording: results from a developer host and results from the image are not interchangeable.
     */
    validationImage: process.env.DIFFCI_VALIDATION_IMAGE ?? null,
    insideValidationImage: Boolean(process.env.DIFFCI_VALIDATION_IMAGE),
  };
  writeFileSync(join(runDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`\nMutation-recall pass over ${candidates.length} recall-measurable candidate(s)`);
  console.log(`  install: ${commands.install.join(" ")}`);
  console.log(`  runner:  node ${commands.testModule} ${commands.testArgs.join(" ")}\n`);

  const counts = new Map<Classification, number>();
  for (const candidate of candidates) {
    process.stdout.write(`  ${candidate.headSha.slice(0, 9)}  selected ${candidate.selectedTests.length}/${candidate.totalCount} ... `);
    const result = classify(candidate, timeoutMs, maxAttempts, qualifyOnly);
    counts.set(result.classification, (counts.get(result.classification) ?? 0) + 1);
    appendFileSync(outPath, `${JSON.stringify(result)}\n`);
    console.log(`${result.classification}${result.mutatedFile ? `  (reverted ${result.mutatedFile})` : ""}`);
    if (result.reason && result.classification !== "RECALL_CONFIRMED") console.log(`      ${result.reason}`);
  }

  const confirmed = counts.get("RECALL_CONFIRMED") ?? 0;
  const falseGreen = counts.get("FALSE_GREEN") ?? 0;
  const measurable = confirmed + falseGreen;

  console.log("\nCLASSIFICATION");
  for (const key of ["BASELINE_QUALIFIED", "RECALL_CONFIRMED", "FALSE_GREEN", "RECALL_UNMEASURABLE", "ENVIRONMENT_DIRTY", "INVALID_RUN"] as Classification[]) {
    console.log(`  ${key.padEnd(22)} ${counts.get(key) ?? 0}`);
  }

  // Printed BEFORE the safety metric and never merged into it. A RECALL_CONFIRMED that also ran 124
  // of 192 tests is two facts, and collapsing them into one verdict is how "we caught it" comes to
  // stand in for "this was worth running".
  const scored = readFileSync(outPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as MutationResult)
    .filter((row) => row.efficiency !== undefined);

  if (scored.length > 0) {
    console.log("\nEFFICIENCY - scored independently of recall");
    for (const key of ["EFFICIENT", "COMPARABLE", "SELECTION_OVERBROAD"] as Efficiency[]) {
      console.log(`  ${key.padEnd(20)} ${scored.filter((row) => row.efficiency === key).length}`);
    }
    for (const row of scored.filter((r) => r.efficiency === "SELECTION_OVERBROAD")) {
      const s = row.selection!;
      console.log(`    ${row.headSha.slice(0, 9)}  ran ${s.selected}/${s.total} against a comparator's ${s.baselineSelected} (+${s.versusBaseline}); ${s.detecting} test(s) actually detected the mutation`);
    }
  }

  console.log("\nPRIMARY SAFETY METRIC");
  if (measurable === 0) {
    console.log("  false greens / recall-measurable selective decisions = UNDEFINED (0 measurable cases)");
    console.log("  No safety claim can be made from this run. That is a result, not a failure.");
  } else {
    console.log(`  false greens / recall-measurable selective decisions = ${falseGreen}/${measurable} = ${((falseGreen / measurable) * 100).toFixed(1)}%`);
  }
  // Written last, and only on a clean finish. A run directory without this sentinel is a partial run;
  // any aggregation must skip it rather than quietly include half an experiment.
  writeFileSync(join(runDir, "COMPLETE"), `${new Date().toISOString()}\n`);
  console.log(`\n  run ${runId}`);
  console.log(`  ${outPath}\n`);
}

main();
