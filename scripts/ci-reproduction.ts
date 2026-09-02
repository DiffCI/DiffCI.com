/**
 * CI_REPRODUCTION_01 — executing two independently constructed arms and comparing their receipts.
 *
 * The shift this script marks: DiffCI is no longer rewarded for DESCRIBING a pipeline correctly. It has
 * to REPRODUCE one.
 *
 *   reference arm   transcribed from the repository's own workflow, without consulting the engine
 *   inference arm   generated ONLY from the frozen ExecutionGraph
 *
 * Both run in the same container, in separate clones of the same pinned tree, through the same bounded
 * executor, so their CPU and exit status are comparable within the run.
 *
 * Nothing is optimised. See docs/ci-reproduction-01-protocol.md, frozen before this executed.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { collectEvidence } from "../src/ci-inference/evidence.js";
import { inferPipeline } from "../src/ci-inference/infer.js";
import { planForPurpose } from "../src/ci-inference/jobs.js";
import { execBounded } from "./process-exec.js";
import { assertShellSafeArgs, findShellUnsafeArgument } from "./shell-safety.js";
import { parseTestOutput, stripAnsi } from "./test-output-parsers.js";

/**
 * `INFRASTRUCTURE` is the fifth outcome, added after attempt 3.
 *
 * Attempt 3's test step was killed by THIS HARNESS's own 20-minute bound in both arms, and `classify`
 * labelled the pair `DIVERGED` - scoring my own execution ceiling against the engine's graph. That is
 * the unknown-as-negative error this project has recorded repeatedly, this time compiled into the
 * scorer rather than committed by a person.
 *
 * A run that never produced a verdict has not produced a NEGATIVE verdict. `INFRASTRUCTURE` is checked
 * FIRST, before any substantive outcome can be reached.
 *
 * `ENVIRONMENT_INADEQUATE` and `UNVERIFIABLE` followed after attempt 4, which the scorer called
 * REPRODUCED on two counts it had no way to question:
 *
 *   1. Both arms reported 161 tests / 113 failures - and essentially every failure was jest's own
 *      "Exceeded timeout of 30000 ms for a test". 113 x 30s is ~56 minutes against a 51.8 minute run,
 *      so the suite did not fail, it sat at its per-test ceiling. The container could not execute the
 *      suite; that is the ENVIRONMENT, not the repository and not the graph.
 *   2. REPRODUCED was decided from arm-to-arm agreement ALONE. Real CI at the pinned commit produced
 *      no completed test result for ANY cell - a lint failure at 29s cancelled all 27 test cells
 *      within 51s - so there was never a ground truth to reproduce. Two arms agreeing with each other
 *      and with nothing external is the near-tautological agreement the attempt-3 protocol explicitly
 *      warned about, reintroduced by the scorer in a different form.
 */
export type Outcome =
  | "REPRODUCED"
  | "PARTIAL_REPRODUCTION"
  | "REFUSED"
  | "DIVERGED"
  | "INFRASTRUCTURE"
  | "ENVIRONMENT_INADEQUATE"
  | "UNVERIFIABLE";

export interface StepReceipt {
  /** Stable identity: `<arm>#<index>` - what a live receipt names before any exit status exists. */
  stepId: string;
  arm: "reference" | "inference";
  command: string[];
  /** The command as one string, so receipts can be matched across arms without re-joining argv. */
  commandIdentity: string;
  workingDirectory: string;
  environment: Record<string, string>;
  startedAt: string;
  endedAt?: string;
  exitStatus: number | null;
  /**
   * True when the step was killed by THIS HARNESS's bound rather than by the repository.
   *
   * Recorded structurally instead of inferred later from `exitStatus === null`, because null also
   * means "signalled for some other reason" and the two must not be scored the same.
   */
  terminatedByBound?: boolean;
  /** Which layer the outcome belongs to - never the repository when the bound or the ENVIRONMENT fired. */
  outcomeLayer?: "repository" | "harness" | "environment";
  /** The workflow wrote `cmd || true`: this step is permitted to fail without stopping the arm. */
  allowFailure?: boolean;
  /** True when argv carried a metacharacter and was therefore spawned with NO shell - amendment 5. */
  spawnedWithoutShell?: boolean;
  /** Tokens the reference plan asked the harness to resolve, and what they became. */
  substitutions?: Record<string, string>;
  /** Names of failing tests, which the parser already computes. Evidence, never used to derive counts. */
  failedNames?: string[];
  /** Environment-caused failure signatures found in the output, e.g. per-test timeouts. */
  environmentSignals?: string[];
  cpuSeconds?: number;
  wallMs: number;
  testFiles?: number;
  tests?: number;
  failures?: number;
  outputTail: string;
}

export interface ArmReceipt {
  arm: "reference" | "inference";
  source: string;
  steps: StepReceipt[];
  reachedEnd: boolean;
  node: string;
  npm: string;
  /** Set when the arm executed NOTHING because the plan was refused. */
  refused?: { reason: string; blockedBy: string[]; missingRequirements: string[] };
}

/**
 * THE EXECUTION BOUNDARY, enforced rather than described.
 *
 *   No DiffCI decision without an executable plan, and no execution of a refused plan.
 *
 * Attempt 2 violated this: plan.executable was false, and the harness filtered out the blocking
 * operation and ran the rest anyway - then reported "no inference arm was run" while its own receipt
 * showed three executed steps. The engine held the line; the harness walked through it and produced a
 * false receipt, which is worse than a failed run because it reads as evidence.
 *
 * Fails CLOSED: a refused plan that somehow carries execution receipts throws rather than being
 * reported, because at that point nothing downstream can be trusted to describe what happened.
 */
function assertBoundaryHonoured(executable: boolean, arm: ArmReceipt): void {
  if (!executable && arm.steps.length > 0) {
    throw new Error(
      `APPARATUS PROTOCOL VIOLATION: the ${arm.arm} plan was refused, yet ${arm.steps.length} repository ` +
        `operation(s) were executed. A refused plan must execute ZERO operations.`,
    );
  }
}

function flag(key: string): string | undefined {
  const i = process.argv.indexOf(`--${key}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

/**
 * Failures that are the ENVIRONMENT giving up, not the code being wrong.
 *
 * A per-test timeout says the runner ran out of wall clock, which on a throughput-starved container
 * says nothing about the repository. Counting these as ordinary failures is how attempt 4 charged 113
 * jest timeouts to html-webpack-plugin.
 */
const ENVIRONMENT_FAILURE_SIGNALS: Array<{ pattern: RegExp; signal: string }> = [
  { pattern: /Exceeded timeout of \d+\s*ms for a (test|hook)/i, signal: "jest per-test timeout" },
  { pattern: /Test timed out in \d+\s*ms/i, signal: "vitest per-test timeout" },
  { pattern: /ENOSPC|no space left on device/i, signal: "disk exhausted" },
  { pattern: /JavaScript heap out of memory/i, signal: "heap exhausted" },
  // DEFECT 33. babel's build needs `make`, which GitHub's ubuntu runner ships and this container does
  // not. The arm exited 127 and the step was recorded outcomeLayer "repository" - charging a missing
  // toolchain to babel. "command not found" is the environment failing to provide, never the
  // repository failing to work.
  //
  // Anchored on `<name>: [command ]not found` at END OF LINE, because sh and bash phrase it
  // differently - `/bin/sh: 1: make: not found` versus `bash: make: command not found` - and a bare
  // /not found/ would match any test whose NAME contains those words.
  { pattern: /:\s*(?:command\s+)?not found\s*$/im, signal: "toolchain missing" },
  { pattern: /No such file or directory/i, signal: "toolchain missing" },
];

/**
 * The ONLY substitution a reference plan may request, as a function so it can be tested.
 *
 * A one-entry whitelist rather than general interpolation: a plan able to expand arbitrary tokens would
 * be a way to smuggle command repair past the no-repair rule.
 */
export function resolveTokens(command: string[]): { resolved: string[]; substitutions: Record<string, string> } {
  const substitutions: Record<string, string> = {};
  const resolved = command.map((token) => {
    if (!token.includes("${CPU_CORES}")) return token;
    const cores = String(cpus().length);
    substitutions["${CPU_CORES}"] = cores;
    return token.replaceAll("${CPU_CORES}", cores);
  });
  return { resolved, substitutions };
}

export function environmentSignalsIn(output: string): string[] {
  return ENVIRONMENT_FAILURE_SIGNALS.filter((s) => s.pattern.test(output)).map((s) => s.signal);
}

/**
 * What real CI actually produced for the cell being reproduced.
 *
 * Required before REPRODUCED can be claimed. Without it the comparison has only two arms in it, and
 * "reproduction" degenerates into "the two things I built agree with each other".
 */
export interface CiGroundTruth {
  cell: string;
  /** GitHub check-run conclusion. Only success/failure are usable; cancelled/skipped are not results. */
  conclusion: string;
  source: string;
}

/**
 * Suite and test counts from the runner's own summary.
 *
 * Regex over the runner output rather than an inference: if the summary is absent the counts are
 * undefined, never zero. A zero here would make "ran nothing" indistinguishable from "ran and passed",
 * and that is the exact comparison this experiment turns on.
 */
export function countsOf(raw: string): { testFiles?: number; tests?: number } {
  // ANSI first, and the reason is a mistake worth keeping visible. The mocha branch below was written
  // against a hand-typed "  38627 passing" and its test passed on that invented fixture — while the
  // real eslint output is "\x1b[32m 38627 passing\x1b[0m", where a `^\s*` anchor cannot match. The
  // regex was checked against my assumption rather than against reality. `parseTestOutput` had been
  // stripping ANSI since it was written, which is why FAILURES parsed and COUNTS did not.
  const output = stripAnsi(raw);
  const suites = /Test Suites:.*?(\d+) total/.exec(output);
  const tests = /Tests:.*?(\d+) total/.exec(output);
  if (tests?.[1]) {
    return { ...(suites?.[1] ? { testFiles: Number(suites[1]) } : {}), tests: Number(tests[1]) };
  }

  // MOCHA. Caught before the CI_REPRODUCTION_05 run, not after: eslint runs mocha, whose epilogue is
  // "N passing / N failing / N pending" and matches nothing above. Left alone, BOTH arms would have
  // reported `tests: undefined`, `suiteOf` would have found no suite in either, and `classify` would
  // have returned DIVERGED - "neither arm executed a suite" - for a pair of runs that each executed
  // thousands of them. A jest-shaped parser silently reporting nothing is indistinguishable from a
  // graph that runs nothing, which is the same unknown-as-negative confusion as defects 23 and 25.
  const passing = /^\s*(\d+) passing/m.exec(output);
  const failing = /^\s*(\d+) failing/m.exec(output);
  const pending = /^\s*(\d+) pending/m.exec(output);
  if (passing?.[1] || failing?.[1]) {
    const total = Number(passing?.[1] ?? 0) + Number(failing?.[1] ?? 0) + Number(pending?.[1] ?? 0);
    return { tests: total };
  }

  return {};
}

/**
 * 1200 characters was too small to diagnose with.
 *
 * babel-loader's R3 failed 2 of 66 tests where CI's ground truth for the same cell was `success`, and
 * the tail held only the tail of a passing suite — not one failure line. Classifying that without
 * seeing the failures would have meant guessing which layer they belonged to, which is the error this
 * whole apparatus exists to avoid. Raised so a failing step can actually be read.
 */
function tail(out: string): string {
  return out.slice(-20_000);
}

/**
 * Durable per-operation receipts, appended AS execution happens.
 *
 * `appendFileSync` on every line, deliberately: a buffered writer would hold exactly the records that
 * matter when a run has to be killed, which is the failure mode this exists to remove. One JSONL line
 * per operation boundary, so the file is readable while it is still being written.
 */
interface ProgressEvent {
  event: "start" | "end" | "arm" | "run";
  [key: string]: unknown;
}

class ProgressLog {
  constructor(private readonly file: string) {}

  emit(event: ProgressEvent): void {
    try {
      appendFileSync(this.file, `${JSON.stringify({ at: new Date().toISOString(), ...event })}
`);
    } catch {
      /* observability must never take down the run it observes */
    }
  }
}

/**
 * Runs one arm's steps in order, stopping at the first non-zero exit.
 *
 * Stopping is deliberate: a pipeline whose install failed has not "partly run", and continuing would
 * produce test numbers from a tree that was never correctly prepared.
 */
function runArm(
  arm: "reference" | "inference",
  source: string,
  steps: Array<{ command: string[]; environment?: Record<string, string>; allowFailure?: boolean }>,
  repoPath: string,
  timeoutMs: number,
  progress: ProgressLog,
): ArmReceipt {
  const receipts: StepReceipt[] = [];
  let reachedEnd = true;
  for (const [index, step] of steps.entries()) {
    if (step.command.length === 0) continue;
    const stepId = `${arm}#${index}`;
    // The shell-invocation invariant, and it applies with unusual force here: the INFERENCE arm's argv
    // comes from workflow `run:` lines, which are repository-derived text - the exact input the guard
    // exists for. `npm` needs a shell to reach its shim, so the arguments are asserted safe first.
    // The engine's own `argvOf` already rejects metacharacters; this makes that guarantee enforced at
    // the spawn site rather than assumed from a caller two files away.
    // Amendment 1: the ONLY substitution a reference plan may request, and it is visible in the receipt.
    //
    // jest's CI runs `--max-workers ${{ steps.cpu-cores.outputs.count }}`, the output of a third-party
    // action whose sole documented function is to report the runner's core count. Transcribing that
    // faithfully needs the number; inventing one would be command repair. So the plan writes the token
    // and the harness resolves it here, recording what it substituted.
    //
    // Deliberately a one-entry whitelist rather than general interpolation: a reference plan that could
    // expand arbitrary tokens would be a way to smuggle repair past the no-repair rule.
    const { resolved, substitutions } = resolveTokens(step.command);

    // AMENDMENT 5. The invariant is unchanged and absolute: repository-derived strings must never cross
    // an implicit shell boundary. Until now the harness satisfied it by REJECTING metacharacters while
    // still spawning through a shell. There is a stricter way.
    //
    // babel-loader's cell runs `yarn up @babel/*@^7`. That is one well-formed command; the glob is not
    // shell syntax at all - bash finds no match, passes the string through untouched, and YARN expands
    // it. Rejecting it would have failed the repository for something the harness chose to do.
    //
    // So: metacharacter-free argv keeps the `shell: true` path members 1-4 ran. Argv containing a
    // metacharacter is spawned with NO SHELL, which honours the invariant more strictly than rejection
    // did, because no shell ever sees the string. SHELL_METACHARACTERS is untouched - loosening it
    // would have been the wrong fix.
    const unsafeArgument = findShellUnsafeArgument(resolved);
    const useShell = unsafeArgument === undefined;
    if (useShell) {
      // Substituted BEFORE the check, never after: the guard must see exactly what will be spawned.
      assertShellSafeArgs(resolved, `ci-reproduction ${arm} arm`);
    }

    // Derived from `resolved`, NOT from `step.command`. Deriving them earlier is how a substitution
    // becomes correct code in an unreachable position - the defect class this laboratory keeps finding.
    const [bin, ...args] = resolved;
    if (!bin) continue;
    const commandIdentity = resolved.join(" ");
    process.stdout.write(`    ${arm.padEnd(9)} ${commandIdentity.slice(0, 70).padEnd(72)}`);

    // START is written BEFORE the child is spawned. Attempt 3 ran 41 minutes with no way to tell which
    // of six operations was live, because every receipt was assembled after the child exited - so the
    // one situation where progress mattered was the one with no record. A receipt that only exists
    // once the step is over cannot answer "where are we now".
    const startedAt = new Date().toISOString();
    progress.emit({ event: "start", stepId, arm, commandIdentity, workingDirectory: repoPath, startedAt, timeoutMs });

    const run = execBounded(bin, args, { cwd: repoPath, timeoutMs, shell: useShell, env: { ...process.env, ...(step.environment ?? {}) } as Record<string, string> });
    const combined = `${run.stdout}
${run.stderr}`;
    const parsed = parseTestOutput(combined);

    // A null exit at (or beyond) the bound is THIS HARNESS killing the child, not the repository
    // failing. The 1% margin absorbs measurement slack; attempt 3 recorded 1_200_013ms against a
    // 1_200_000ms bound.
    const terminatedByBound = run.status === null && run.ms >= timeoutMs * 0.99;
    // DEFECT 26. The layer was previously binary - bound means harness, everything else means
    // repository - even though the type has always had an `environment` case. Attempt 4 therefore
    // recorded 113 jest per-test timeouts as a REPOSITORY outcome, blaming html-webpack-plugin for
    // this container's throughput. A failing step is only the repository's when the environment was
    // able to run it.
    const environmentSignals = run.status === 0 ? [] : environmentSignalsIn(combined);
    const outcomeLayer: StepReceipt["outcomeLayer"] = terminatedByBound
      ? "harness"
      : environmentSignals.length > 0
        ? "environment"
        : "repository";
    const endedAt = new Date().toISOString();

    receipts.push({
      stepId,
      arm,
      command: resolved,
      commandIdentity,
      ...(Object.keys(substitutions).length > 0 ? { substitutions } : {}),
      ...(step.allowFailure ? { allowFailure: true } : {}),
      ...(useShell ? {} : { spawnedWithoutShell: true }),
      workingDirectory: repoPath,
      environment: step.environment ?? {},
      startedAt,
      endedAt,
      exitStatus: run.status,
      ...(terminatedByBound ? { terminatedByBound } : {}),
      outcomeLayer,
      ...(environmentSignals.length > 0 ? { environmentSignals } : {}),
      cpuSeconds: run.cpuSeconds,
      wallMs: run.ms,
      ...countsOf(combined),
      failures: parsed.failures,
      ...(parsed.failedNames.length > 0 ? { failedNames: parsed.failedNames.slice(0, 20) } : {}),
      outputTail: tail(combined),
    });
    progress.emit({
      event: "end",
      stepId,
      arm,
      commandIdentity,
      startedAt,
      endedAt,
      exitStatus: run.status,
      terminatedByBound,
      outcomeLayer,
      environmentSignals,
      cpuSeconds: run.cpuSeconds,
      wallMs: run.ms,
      ...countsOf(combined),
      failures: parsed.failures,
    });
    console.log(` exit ${String(run.status).padStart(3)}  ${(run.ms / 1000).toFixed(1)}s${terminatedByBound ? "  KILLED BY BOUND" : ""}`);
    // Amendment 3: `cmd || true` in the workflow, represented as data rather than handed to a shell.
    // The arm continues, and the receipt still records the real exit status - the step is permitted to
    // fail, not pretended to have succeeded.
    if (run.status !== 0 && step.allowFailure) continue;

    if (run.status !== 0) {
      reachedEnd = false;
      break;
    }
  }
  const node = execFileSync(process.execPath, ["--version"], { encoding: "utf8" }).trim();
  let npm = "unknown";
  try {
    npm = execFileSync("npm", ["--version"], { encoding: "utf8", shell: true }).trim();
  } catch {
    /* recorded as unknown rather than guessed */
  }
  return { arm, source, steps: receipts, reachedEnd, node, npm };
}

/**
 * Classifies the pair of receipts under the frozen outcomes.
 *
 * Materially equivalent means: both arms ran a suite, and both reported the same failure count.
 *
 * Two arms that never ran a suite are equally uninformative - but WHY they are uninformative decides
 * the label. If this harness killed them, that is INFRASTRUCTURE and is checked first. Only when the
 * steps ran to their own conclusion can the absence of a suite be charged to the graph as DIVERGED.
 */
export function classify(
  reference: ArmReceipt,
  inference: ArmReceipt,
  optimisable: boolean,
  groundTruth?: CiGroundTruth,
): { outcome: Outcome; reason: string } {
  // DEFECT 23, CHECKED FIRST. Attempt 3 reached "neither arm executed a suite, so no reproduction can
  // be claimed" and returned DIVERGED - while both arms' test steps had been killed by this harness's
  // own 20-minute bound. The graph was never shown wrong; the ceiling was never raised. Asking WHY no
  // suite ran has to happen before any outcome that blames the engine or the repository.
  const bounded = [...reference.steps, ...inference.steps].filter((s) => s.terminatedByBound);
  if (bounded.length > 0) {
    const which = bounded
      .map((s) => `${s.stepId} ${s.commandIdentity} after ${(s.wallMs / 1000 / 60).toFixed(1)}min`)
      .join("; ");
    return {
      outcome: "INFRASTRUCTURE",
      reason:
        `${bounded.length} step(s) were killed by this harness execution bound, not by the repository ` +
        `or the graph: ${which}. No reproduction verdict exists - this is NOT divergence, refusal, ` +
        `or a repository failure.`,
    };
  }

  const suiteOf = (a: ArmReceipt): StepReceipt | undefined => a.steps.find((s) => typeof s.tests === "number" && s.tests > 0);
  const refSuite = suiteOf(reference);
  const infSuite = suiteOf(inference);
  const installOf = (a: ArmReceipt): StepReceipt | undefined => a.steps.find((s) => s.command.includes("ci") || s.command.includes("install"));

  if (!optimisable) {
    return {
      outcome: "REFUSED",
      reason: `the engine did not mark the path executable, so the inference arm executed nothing: ${inference.refused?.reason ?? "no reason recorded"}`,
    };
  }

  const refInstall = installOf(reference);
  const infInstall = installOf(inference);
  const installOk = refInstall?.exitStatus === 0 && infInstall?.exitStatus === 0;

  if (!infSuite && refSuite) {
    return {
      outcome: "DIVERGED",
      reason:
        `the engine claimed executability but its graph never runs the suite: reference executed a suite ` +
        `(${refSuite.tests} tests in ${refSuite.testFiles ?? "?"} files) and the inference arm executed none` +
        (installOk ? ". Install succeeded in both arms." : ""),
    };
  }
  if (!refSuite && !infSuite) {
    return { outcome: "DIVERGED", reason: "neither arm executed a suite, so no reproduction can be claimed" };
  }
  // DEFECT 26. A suite whose failures are the ENVIRONMENT running out of wall clock has not told us
  // anything about the repository or the graph, however consistently both arms reproduce it.
  const envSignals = [...new Set([...(refSuite?.environmentSignals ?? []), ...(infSuite?.environmentSignals ?? [])])];
  if (envSignals.length > 0) {
    return {
      outcome: "ENVIRONMENT_INADEQUATE",
      reason:
        `the suite failed on environment signals rather than on the code under test (${envSignals.join(", ")}): ` +
        `reference ${refSuite?.failures}/${refSuite?.tests} failed, inference ${infSuite?.failures}/${infSuite?.tests}. ` +
        `The arms agree, but they agree on a run this environment could not execute.`,
    };
  }

  if (refSuite && infSuite && refSuite.failures === infSuite.failures && refSuite.tests === infSuite.tests) {
    // DEFECT 25. Arm-to-arm agreement is NOT reproduction. Without knowing what CI actually produced
    // for this cell, "REPRODUCED" only ever meant "the two things I built agree with each other" -
    // and at the attempt-4 commit real CI produced no completed test result at all, so there was
    // nothing to agree WITH. Absent ground truth the honest answer is UNVERIFIABLE, not a pass.
    const usable = groundTruth && (groundTruth.conclusion === "success" || groundTruth.conclusion === "failure");
    if (!usable) {
      return {
        outcome: "UNVERIFIABLE",
        reason:
          `both arms ran ${refSuite.tests} tests with ${refSuite.failures} failures, but there is no usable CI ` +
          `ground truth for this cell (` +
          (groundTruth ? `${groundTruth.cell} concluded "${groundTruth.conclusion}"` : "none recorded") +
          `). Arm-to-arm agreement alone cannot establish that CI was reproduced.`,
      };
    }
    return {
      outcome: "REPRODUCED",
      reason:
        `both arms ran ${refSuite.tests} tests with ${refSuite.failures} failures, matching CI ground truth ` +
        `${groundTruth.cell} = "${groundTruth.conclusion}" (${groundTruth.source})`,
    };
  }
  return {
    outcome: "PARTIAL_REPRODUCTION",
    reason: `both arms ran a suite but they are not equivalent: reference ${refSuite?.tests}/${refSuite?.failures} vs inference ${infSuite?.tests}/${infSuite?.failures}`,
  };
}

function main(): void {
  const repository = flag("repository") ?? "jantimon/html-webpack-plugin";
  const headSha = flag("head") ?? "cf9c7012003b8d71783d6c2d72f357616957b99c";
  const work = resolve(flag("work") ?? "ci-reproduction-work");
  const outDir = resolve(flag("out") ?? "docs/evidence/ci-reproduction-01");
  // Attempt 3 died on this default: html-webpack-plugin builds webpack repeatedly and its suite was
  // still running, still producing output, when the 20-minute bound killed it in BOTH arms. The bound
  // is harness infrastructure - not inference, commands, matrix scope, environment or protocol - so
  // raising it leaves the reproduction question itself untouched.
  const timeoutMs = Number(flag("timeout") ?? 90 * 60_000);
  const referencePlanPath = resolve(flag("reference") ?? "docs/evidence/ci-reproduction-01-reference-plan.json");
  const referenceOnly = process.argv.includes("--reference-only");
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`\n  CI_REPRODUCTION_01  ${repository} @ ${headSha.slice(0, 9)}`);
  console.log(`  Two independently constructed arms. Nothing is optimised.\n`);

  const clone = (into: string): void => {
    if (existsSync(join(into, ".git"))) return;
    execFileSync("git", ["clone", "--quiet", `https://github.com/${repository}.git`, into], { stdio: "pipe" });
    execFileSync("git", ["-C", into, "checkout", "--quiet", headSha], { stdio: "pipe" });
  };

  // --- R3 QUALIFICATION: the reference arm alone, engine never invoked ---
  //
  // docs/ci-reproduction-05-eligibility.md fixes this before any candidate was screened. If
  // qualification ran BOTH arms, a repository would become eligible partly because the engine happened
  // to handle it - selecting targets on which DiffCI already succeeds, and turning the eventual
  // reproduction result into a tautology. So the engine must not see the candidate until it is sealed.
  //
  // Returning here, before collectEvidence, is what makes that structural rather than a promise.
  if (referenceOnly) {
    // Self-contained on purpose. The reference arm is cloned and run HERE, above `collectEvidence`, so
    // that qualifying a candidate cannot reach the engine even by accident. Reusing the arm built lower
    // down would put the engine's work first and make this guard cosmetic.
    const qualifyPlan = JSON.parse(readFileSync(referencePlanPath, "utf8")) as {
      source: string;
      steps: Array<{ command: string[]; environment?: Record<string, string>; allowFailure?: boolean }>;
    };
    const qualifyRepo = join(work, "reference");
    clone(qualifyRepo);
    const qualifyProgress = new ProgressLog(join(outDir, "progress.jsonl"));
    qualifyProgress.emit({ event: "run", repository, headSha, timeoutMs, arms: ["reference"], mode: "R3" });
    console.log(`  R3 qualification: reference arm only, engine NOT invoked`);
    const reference = runArm("reference", qualifyPlan.source, qualifyPlan.steps, qualifyRepo, timeoutMs, qualifyProgress);

    // DEFECT 32. This predicate passed babel with `make: not found` and printed "the reference arm
    // completed (exit 127) with no environment signals". `completed` meant only "exit status is not
    // null", so a command-not-found on step 3 of 9 counted as completion - and the arm never reached
    // the suite at all. Qualification asked whether the process ENDED, not whether it WORKED.
    //
    // R3 now requires all three: every step exited 0, the arm reached its end, and a suite reported a
    // test count. "It stopped without crashing" is not qualification.
    const last = reference.steps[reference.steps.length - 1];
    const signals = [...new Set(reference.steps.flatMap((s) => s.environmentSignals ?? []))];
    const allSucceeded = reference.steps.every((s) => s.exitStatus === 0 || s.allowFailure);
    const ranSuite = reference.steps.some((s) => typeof s.tests === "number" && s.tests > 0);
    const failedStep = reference.steps.find((s) => s.exitStatus !== 0 && !s.allowFailure);
    const qualified = allSucceeded && reference.reachedEnd && ranSuite && signals.length === 0;
    const r3 = {
      schema: "diffci.ci.r3-qualification/v1",
      protocol: "docs/ci-reproduction-05-eligibility.md",
      repository,
      headSha,
      engineInvoked: false,
      verdict: qualified ? "R3_QUALIFIED" : "R3_FAILED",
      reason: qualified
        ? `the reference arm ran to completion and executed a suite, with no environment signals`
        : signals.length > 0
          ? `the reference arm hit environment signals: ${signals.join(", ")}`
          : failedStep
            ? `the reference arm failed at ${failedStep.stepId} (${failedStep.commandIdentity}) with exit ${failedStep.exitStatus}`
            : !ranSuite
              ? "the reference arm executed no suite, so there is nothing to reproduce"
              : "the reference arm did not reach its end inside the bound",
      referenceArm: reference,
      producedAt: new Date().toISOString(),
    };
    writeFileSync(join(outDir, "reproduction.json"), `${JSON.stringify(r3, null, 2)}
`);
    console.log(`
  R3: ${r3.verdict} - ${r3.reason}`);
    return;
  }

  // --- inference arm: from the frozen graph ONLY ---
  const inferenceRepo = join(work, "inference");
  clone(inferenceRepo);
  const facts = collectEvidence(inferenceRepo);
  const pipeline = inferPipeline(inferenceRepo, repository, headSha, facts, new Date().toISOString());
  // INFERENCE_03: ask the planner for the path to the outcome under reproduction, rather than taking
  // whatever operations a single collapsed job happened to contain. The reference question here is TEST
  // reproduction, so the plan is the TEST path - install included, later steps excluded.
  // MATRIX SCOPE, fixed by docs/ci-reproduction-03-protocol.md before any instance was computed:
  // in-environment means os is ubuntu-* and node is absent or matches the container major version.
  // Everything else is OUT_OF_ENVIRONMENT - recorded, never executed, never counted as a failure.
  const containerMajor = process.version.replace(/^v/, "").split(".")[0]!;
  const testJobs = pipeline.jobs.filter((j) => j.provides.includes("TEST"));
  const inEnvironment = testJobs.filter((j) => {
    const os = j.matrix?.os ?? "ubuntu-latest";
    const node = j.matrix?.node;
    return /^ubuntu/.test(os) && (node === undefined || node.replace(/.x$/, "") === containerMajor);
  });
  const outOfEnvironment = testJobs.filter((j) => !inEnvironment.includes(j));
  console.log(`  matrix scope   : ${inEnvironment.length} in-environment of ${testJobs.length} TEST instances (node ${containerMajor}, ubuntu)`);
  for (const j of outOfEnvironment.slice(0, 3)) console.log(`      OUT_OF_ENVIRONMENT ${JSON.stringify(j.matrix)}`);
  if (outOfEnvironment.length > 3) console.log(`      ... and ${outOfEnvironment.length - 3} more, recorded and not executed`);
  const plan = inEnvironment.length > 0 ? planForPurpose(inEnvironment, "TEST") : planForPurpose(pipeline.jobs, "TEST");
  // A refused plan executes NOTHING. Filtering out the blocking operation and running the remainder is
  // exactly the attempt-2 defect: it silently converts "we cannot account for this path" into "we ran a
  // slightly different path", which is the one substitution this experiment cannot tolerate.
  const inferenceSteps = plan.executable
    ? plan.operations
        .filter((o) => o.kind !== "checkout" && o.willExecute !== false && o.command.length > 0)
        .map((o) => ({ command: o.command, environment: o.environment }))
    : [];

  // --- reference arm: transcribed from the repository's workflow, engine not consulted ---
  const referencePlan = JSON.parse(readFileSync(referencePlanPath, "utf8")) as {
    /** What real CI produced for this cell. Absent means REPRODUCED cannot be claimed - see defect 25. */
    ciGroundTruth?: CiGroundTruth;
    source: string;
    steps: Array<{ command: string[]; environment?: Record<string, string>; allowFailure?: boolean }>;
  };
  const referenceRepo = join(work, "reference");
  clone(referenceRepo);

  console.log(`  reference plan : ${referencePlan.source}`);
  console.log(`  inferred plan  : ${inferenceSteps.length} executable operation(s), optimisable=${pipeline.optimisable}\n`);

  const progress = new ProgressLog(join(outDir, "progress.jsonl"));
  progress.emit({ event: "run", repository, headSha, timeoutMs, arms: ["reference", "inference"] });

  const reference = runArm("reference", referencePlan.source, referencePlan.steps, referenceRepo, timeoutMs, progress);
  const inference: ArmReceipt = plan.executable
    ? runArm("inference", "inferred ExecutionGraph", inferenceSteps, inferenceRepo, timeoutMs, progress)
    : {
        arm: "inference",
        source: "inferred ExecutionGraph",
        steps: [],
        reachedEnd: false,
        node: reference.node,
        npm: reference.npm,
        refused: {
          reason: plan.refusal ?? "the plan was not executable",
          blockedBy: [...new Set(plan.operations.flatMap((o) => o.blockedBy))],
          missingRequirements: [...new Set(plan.operations.flatMap((o) => o.missingRequirements))],
        },
      };
  if (!plan.executable) console.log(`    inference  REFUSED - executed nothing: ${plan.refusal}`);
  assertBoundaryHonoured(plan.executable, inference);
  const { outcome, reason } = classify(reference, inference, plan.executable, referencePlan.ciGroundTruth);

  writeFileSync(
    join(outDir, "reproduction.json"),
    `${JSON.stringify(
      {
        schema: "diffci.ci.reproduction/v1",
        attempt: 1,
        repository,
        headSha,
        protocol: "docs/ci-reproduction-01-protocol.md",
        optimisable: pipeline.optimisable,
        jobs: pipeline.jobs.map((j) => ({ id: j.id, provides: j.provides, operations: j.operations.map((o) => ({ id: o.id, kind: o.kind, command: o.command, executable: o.executable })) })),
        testPlan: plan,
        inferredOperations: pipeline.operations,
        referenceArm: reference,
        inferenceArm: inference,
        outcome,
        reason,
        producedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
  );

  console.log(`\n  OUTCOME  ${outcome}`);
  console.log(`  ${reason}\n`);
}

// Only run when invoked as a script. Exporting `classify` for a behavioural test must not execute a
// two-arm container run as a side effect of importing this module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
