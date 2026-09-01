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
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { collectEvidence } from "../src/ci-inference/evidence.js";
import { inferPipeline } from "../src/ci-inference/infer.js";
import { planForPurpose } from "../src/ci-inference/jobs.js";
import { execBounded } from "./process-exec.js";
import { assertShellSafeArgs } from "./shell-safety.js";
import { parseTestOutput } from "./test-output-parsers.js";

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
 */
export type Outcome = "REPRODUCED" | "PARTIAL_REPRODUCTION" | "REFUSED" | "DIVERGED" | "INFRASTRUCTURE";

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
  /** Which layer the outcome belongs to - never the repository when the bound fired. */
  outcomeLayer?: "repository" | "harness" | "environment";
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
 * Suite and test counts from the runner's own summary.
 *
 * Regex over the runner output rather than an inference: if the summary is absent the counts are
 * undefined, never zero. A zero here would make "ran nothing" indistinguishable from "ran and passed",
 * and that is the exact comparison this experiment turns on.
 */
function countsOf(output: string): { testFiles?: number; tests?: number } {
  const suites = /Test Suites:.*?(\d+) total/.exec(output);
  const tests = /Tests:.*?(\d+) total/.exec(output);
  return {
    ...(suites?.[1] ? { testFiles: Number(suites[1]) } : {}),
    ...(tests?.[1] ? { tests: Number(tests[1]) } : {}),
  };
}

function tail(out: string): string {
  return out.slice(-1200);
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
  steps: Array<{ command: string[]; environment?: Record<string, string> }>,
  repoPath: string,
  timeoutMs: number,
  progress: ProgressLog,
): ArmReceipt {
  const receipts: StepReceipt[] = [];
  let reachedEnd = true;
  for (const [index, step] of steps.entries()) {
    const [bin, ...args] = step.command;
    if (!bin) continue;
    const stepId = `${arm}#${index}`;
    const commandIdentity = step.command.join(" ");
    process.stdout.write(`    ${arm.padEnd(9)} ${commandIdentity.slice(0, 70).padEnd(72)}`);
    // The shell-invocation invariant, and it applies with unusual force here: the INFERENCE arm's argv
    // comes from workflow `run:` lines, which are repository-derived text - the exact input the guard
    // exists for. `npm` needs a shell to reach its shim, so the arguments are asserted safe first.
    // The engine's own `argvOf` already rejects metacharacters; this makes that guarantee enforced at
    // the spawn site rather than assumed from a caller two files away.
    assertShellSafeArgs(step.command, `ci-reproduction ${arm} arm`);

    // START is written BEFORE the child is spawned. Attempt 3 ran 41 minutes with no way to tell which
    // of six operations was live, because every receipt was assembled after the child exited - so the
    // one situation where progress mattered was the one with no record. A receipt that only exists
    // once the step is over cannot answer "where are we now".
    const startedAt = new Date().toISOString();
    progress.emit({ event: "start", stepId, arm, commandIdentity, workingDirectory: repoPath, startedAt, timeoutMs });

    const run = execBounded(bin, args, { cwd: repoPath, timeoutMs, shell: true, env: { ...process.env, ...(step.environment ?? {}) } as Record<string, string> });
    const combined = `${run.stdout}
${run.stderr}`;
    const parsed = parseTestOutput(combined);

    // A null exit at (or beyond) the bound is THIS HARNESS killing the child, not the repository
    // failing. The 1% margin absorbs measurement slack; attempt 3 recorded 1_200_013ms against a
    // 1_200_000ms bound.
    const terminatedByBound = run.status === null && run.ms >= timeoutMs * 0.99;
    const outcomeLayer: StepReceipt["outcomeLayer"] = terminatedByBound ? "harness" : "repository";
    const endedAt = new Date().toISOString();

    receipts.push({
      stepId,
      arm,
      command: step.command,
      commandIdentity,
      workingDirectory: repoPath,
      environment: step.environment ?? {},
      startedAt,
      endedAt,
      exitStatus: run.status,
      ...(terminatedByBound ? { terminatedByBound } : {}),
      outcomeLayer,
      cpuSeconds: run.cpuSeconds,
      wallMs: run.ms,
      ...countsOf(combined),
      failures: parsed.failures,
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
      cpuSeconds: run.cpuSeconds,
      wallMs: run.ms,
      ...countsOf(combined),
      failures: parsed.failures,
    });
    console.log(` exit ${String(run.status).padStart(3)}  ${(run.ms / 1000).toFixed(1)}s${terminatedByBound ? "  KILLED BY BOUND" : ""}`);
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
export function classify(reference: ArmReceipt, inference: ArmReceipt, optimisable: boolean): { outcome: Outcome; reason: string } {
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
  if (refSuite && infSuite && refSuite.failures === infSuite.failures && refSuite.tests === infSuite.tests) {
    return { outcome: "REPRODUCED", reason: `both arms ran ${refSuite.tests} tests with ${refSuite.failures} failures` };
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
  mkdirSync(work, { recursive: true });
  mkdirSync(outDir, { recursive: true });

  console.log(`\n  CI_REPRODUCTION_01  ${repository} @ ${headSha.slice(0, 9)}`);
  console.log(`  Two independently constructed arms. Nothing is optimised.\n`);

  const clone = (into: string): void => {
    if (existsSync(join(into, ".git"))) return;
    execFileSync("git", ["clone", "--quiet", `https://github.com/${repository}.git`, into], { stdio: "pipe" });
    execFileSync("git", ["-C", into, "checkout", "--quiet", headSha], { stdio: "pipe" });
  };

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
    source: string;
    steps: Array<{ command: string[]; environment?: Record<string, string> }>;
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
  const { outcome, reason } = classify(reference, inference, plan.executable);

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
