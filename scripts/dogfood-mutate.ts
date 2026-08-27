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
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { selectFileToMutate } from "../src/analysis-fanout/mutation.js";
import { assertShellSafeArgs } from "./shell-safety.js";

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
  | "INVALID_RUN";

interface MutationResult {
  repository: string;
  headSha: string;
  baseSha: string;
  classification: Classification;
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
  observedAt: string;
}

interface Candidate {
  repository: string;
  repoPath: string;
  baseSha: string;
  headSha: string;
  selectedTests: string[];
  totalCount: number;
  changedFiles: string[];
}

/**
 * Runs a real executable with NO shell. Every test invocation goes through here, because those
 * arguments are repository-derived test file paths and must reach the process verbatim.
 */
function run(command: string, args: string[], cwd: string, timeoutMs: number): { status: number | null; stdout: string; stderr: string; ms: number } {
  const started = Date.now();
  const result = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - started };
}

/**
 * Runs npm, which on Windows is a .cmd shim and therefore REQUIRES a shell - Node refuses to spawn
 * batch files directly since CVE-2024-27980. Permitted here only because every argument is a fixed
 * literal, and asserted rather than assumed. This is exactly the split the invariant describes: a
 * shell is acceptable when nothing repository-derived is concatenated into the command line.
 */
function runNpm(args: string[], cwd: string, timeoutMs: number): { status: number | null; stdout: string; stderr: string; ms: number } {
  assertShellSafeArgs(args, "dogfood-mutate: npm");
  const started = Date.now();
  const result = spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
    env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "", ms: Date.now() - started };
}

/**
 * Counts failures from a `node:test` TAP-ish summary. Deliberately conservative: if the count cannot
 * be parsed the caller treats the run as INVALID_RUN rather than assuming zero, because "no failures
 * found" and "could not tell" must never be the same answer in a safety measurement.
 */
function parseFailures(output: string): { failures: number | undefined; failedNames: string[] } {
  const match = /^# fail (\d+)$/m.exec(output) ?? /^ℹ fail (\d+)$/m.exec(output);
  const failedNames = [...output.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1]!.trim());
  return { failures: match ? Number(match[1]) : undefined, failedNames };
}

function loadCandidates(corpusPath: string, repoPath: string, reportsDir: string): Candidate[] {
  const rows = readFileSync(corpusPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { identity: { repository: string; baseSha: string; headSha: string }; decision: { mode: string; selected: number | "unknown"; total: number | "unknown" } });

  const candidates: Candidate[] = [];
  for (const row of rows) {
    // Only SELECTIVE decisions that actually selected something. A SELECTIVE-with-zero decision on a
    // docs or asset commit is excluded on purpose: mutating a file that commit did not touch would
    // test an artificial relationship the real commit does not contain.
    if (row.decision.mode !== "SELECTIVE") continue;
    if (typeof row.decision.selected !== "number" || row.decision.selected === 0) continue;

    const reportPath = join(reportsDir, `${row.identity.headSha.slice(0, 12)}.json`);
    if (!existsSync(reportPath)) continue;
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as { result: { selectedTests?: string[]; changedFiles?: string[] } };

    candidates.push({
      repository: row.identity.repository,
      repoPath,
      baseSha: row.identity.baseSha,
      headSha: row.identity.headSha,
      selectedTests: report.result.selectedTests ?? [],
      totalCount: typeof row.decision.total === "number" ? row.decision.total : 0,
      changedFiles: report.result.changedFiles ?? [],
    });
  }
  return candidates;
}

/** Non-test, non-asset source files this merge changed - the only legitimate mutation targets. */
function mutationTargets(changedFiles: string[]): string[] {
  return changedFiles.filter((path) => /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(path) && !/\.(test|spec)\./.test(path) && !path.startsWith("tests/"));
}

function classify(candidate: Candidate, fullCommand: string[], timeoutMs: number, maxAttempts: number): MutationResult {
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

  const install = runNpm(["install", "--no-audit", "--no-fund", "--silent"], candidate.repoPath, 15 * 60_000);
  if (install.status !== 0) {
    const detail = (install.stderr.trim() || install.stdout.trim()).split("\n").filter(Boolean).slice(-1)[0] ?? `exit ${install.status}`;
    return { ...base, reason: `dependency install failed: ${detail.slice(0, 200)}` };
  }

  // 1. BASELINE. The suite must be green before mutation, or nothing after it can be attributed.
  const baseline = run(fullCommand[0]!, fullCommand.slice(1), candidate.repoPath, timeoutMs);
  const baselineParsed = parseFailures(baseline.stdout + baseline.stderr);
  if (baselineParsed.failures === undefined) return { ...base, reason: "could not parse the baseline run's failure count" };
  if (baselineParsed.failures > 0) {
    return { ...base, classification: "ENVIRONMENT_DIRTY", reason: `${baselineParsed.failures} test(s) already failing before mutation`, baselineFailures: baselineParsed.failures };
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
      const fullMutated = run(fullCommand[0]!, fullCommand.slice(1), candidate.repoPath, timeoutMs);
      const fullParsed = parseFailures(fullMutated.stdout + fullMutated.stderr);
      if (fullParsed.failures === undefined) {
        return { ...base, reason: `could not parse the full mutated run's failure count for ${mutation.path}`, mutatedFile: mutation.path, attemptedFiles };
      }
      // Not measurable through this file. Restore it and try the next one rather than giving up.
      if (fullParsed.failures === 0) continue;

      // 4. SELECTED MUTATED. Only DiffCI's chosen tests. This is the measurement.
      const selectedMutated = run(fullCommand[0]!, [...fullCommand.slice(1, fullCommand.length - 1), ...candidate.selectedTests], candidate.repoPath, timeoutMs);
      const selectedParsed = parseFailures(selectedMutated.stdout + selectedMutated.stderr);
      if (selectedParsed.failures === undefined) {
        return { ...base, reason: `could not parse the selected mutated run's failure count for ${mutation.path}`, mutatedFile: mutation.path, attemptedFiles };
      }

      const missed = fullParsed.failedNames.filter((name) => !selectedParsed.failedNames.includes(name));
      const detected = selectedParsed.failures > 0;

      return {
        ...base,
        classification: detected ? "RECALL_CONFIRMED" : "FALSE_GREEN",
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
  const outPath = resolve(flag("out") ?? join(repoRoot, ".dogfood", "mutation.jsonl"));
  const timeoutMs = Number(flag("timeout") ?? 20 * 60_000);
  // Each attempt costs one full-suite run, so the search is bounded. A capped case says so in its
  // reason rather than silently looking like a merge with no measurable files.
  const maxAttempts = Number(flag("max-attempts") ?? 5);
  // The repository's own test command. Full runs use it as-is; selected runs replace its final
  // argument (the glob) with the selected files, so both sides use the SAME runner - comparing a
  // vitest full run against a node --test selected run would measure the runner, not the selection.
  // Deliberately not "npx tsx ...": npx is a .cmd shim on Windows, which would drag a shell into the
  // one spawn whose arguments are repository-derived. Invoking the runner's real JS entry through
  // `node` keeps execve semantics for the test paths. Pipe-separated so a path may contain a space.
  const defaultCommand = [process.execPath, join(repoPath, "node_modules", "tsx", "dist", "cli.mjs"), "--test", "tests/**/*.test.ts"];
  const fullCommand = flag("test-command") ? flag("test-command")!.split("|") : defaultCommand;

  if (!existsSync(corpusPath)) throw new Error(`no corpus at ${corpusPath} - run: npm run dogfood`);
  if (!existsSync(reportsDir)) throw new Error("--reports <dir> is required (the dogfood run prints where it kept them)");
  if (!existsSync(repoPath)) throw new Error("--repo <path> is required (the scratch clone the dogfood run used)");

  const candidates = loadCandidates(corpusPath, repoPath, reportsDir);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, "");

  console.log(`\nMutation-recall pass over ${candidates.length} recall-measurable candidate(s)`);
  console.log(`  runner: ${fullCommand.join(" ")}\n`);

  const counts = new Map<Classification, number>();
  for (const candidate of candidates) {
    process.stdout.write(`  ${candidate.headSha.slice(0, 9)}  selected ${candidate.selectedTests.length}/${candidate.totalCount} ... `);
    const result = classify(candidate, fullCommand, timeoutMs, maxAttempts);
    counts.set(result.classification, (counts.get(result.classification) ?? 0) + 1);
    appendFileSync(outPath, `${JSON.stringify(result)}\n`);
    console.log(`${result.classification}${result.mutatedFile ? `  (reverted ${result.mutatedFile})` : ""}`);
    if (result.reason && result.classification !== "RECALL_CONFIRMED") console.log(`      ${result.reason}`);
  }

  const confirmed = counts.get("RECALL_CONFIRMED") ?? 0;
  const falseGreen = counts.get("FALSE_GREEN") ?? 0;
  const measurable = confirmed + falseGreen;

  console.log("\nCLASSIFICATION");
  for (const key of ["RECALL_CONFIRMED", "FALSE_GREEN", "RECALL_UNMEASURABLE", "ENVIRONMENT_DIRTY", "INVALID_RUN"] as Classification[]) {
    console.log(`  ${key.padEnd(22)} ${counts.get(key) ?? 0}`);
  }

  console.log("\nPRIMARY SAFETY METRIC");
  if (measurable === 0) {
    console.log("  false greens / recall-measurable selective decisions = UNDEFINED (0 measurable cases)");
    console.log("  No safety claim can be made from this run. That is a result, not a failure.");
  } else {
    console.log(`  false greens / recall-measurable selective decisions = ${falseGreen}/${measurable} = ${((falseGreen / measurable) * 100).toFixed(1)}%`);
  }
  console.log(`\n  written to ${outPath}\n`);
}

main();
