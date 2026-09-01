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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { collectEvidence } from "../src/ci-inference/evidence.js";
import { inferPipeline } from "../src/ci-inference/infer.js";
import { planForPurpose } from "../src/ci-inference/jobs.js";
import { execBounded } from "./process-exec.js";
import { assertShellSafeArgs } from "./shell-safety.js";
import { parseTestOutput } from "./test-output-parsers.js";

type Outcome = "REPRODUCED" | "PARTIAL_REPRODUCTION" | "REFUSED" | "DIVERGED";

interface StepReceipt {
  command: string[];
  workingDirectory: string;
  environment: Record<string, string>;
  exitStatus: number | null;
  cpuSeconds?: number;
  wallMs: number;
  testFiles?: number;
  tests?: number;
  failures?: number;
  outputTail: string;
}

interface ArmReceipt {
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
 * Runs one arm's steps in order, stopping at the first non-zero exit.
 *
 * Stopping is deliberate: a pipeline whose install failed has not "partly run", and continuing would
 * produce test numbers from a tree that was never correctly prepared.
 */
function runArm(arm: "reference" | "inference", source: string, steps: Array<{ command: string[]; environment?: Record<string, string> }>, repoPath: string, timeoutMs: number): ArmReceipt {
  const receipts: StepReceipt[] = [];
  let reachedEnd = true;
  for (const step of steps) {
    const [bin, ...args] = step.command;
    if (!bin) continue;
    process.stdout.write(`    ${arm.padEnd(9)} ${step.command.join(" ").slice(0, 70).padEnd(72)}`);
    // The shell-invocation invariant, and it applies with unusual force here: the INFERENCE arm's argv
    // comes from workflow `run:` lines, which are repository-derived text — the exact input the guard
    // exists for. `npm` needs a shell to reach its shim, so the arguments are asserted safe first.
    // The engine's own `argvOf` already rejects metacharacters; this makes that guarantee enforced at
    // the spawn site rather than assumed from a caller two files away.
    assertShellSafeArgs(step.command, `ci-reproduction ${arm} arm`);
    const run = execBounded(bin, args, { cwd: repoPath, timeoutMs, shell: true, env: { ...process.env, ...(step.environment ?? {}) } as Record<string, string> });
    const combined = `${run.stdout}\n${run.stderr}`;
    const parsed = parseTestOutput(combined);
    receipts.push({
      command: step.command,
      workingDirectory: repoPath,
      environment: step.environment ?? {},
      exitStatus: run.status,
      cpuSeconds: run.cpuSeconds,
      wallMs: run.ms,
      ...countsOf(combined),
      failures: parsed.failures,
      outputTail: tail(combined),
    });
    console.log(` exit ${String(run.status).padStart(3)}  ${(run.ms / 1000).toFixed(1)}s`);
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
 * Materially equivalent means: both arms ran a suite, and both reported the same failure count. Two arms
 * that never ran a suite are not "equivalent" — they are equally uninformative, which is DIVERGED when
 * the engine claimed the pipeline was executable.
 */
function classify(reference: ArmReceipt, inference: ArmReceipt, optimisable: boolean): { outcome: Outcome; reason: string } {
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
  const timeoutMs = Number(flag("timeout") ?? 20 * 60_000);
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
  const plan = planForPurpose(pipeline.jobs, "TEST");
  // A refused plan executes NOTHING. Filtering out the blocking operation and running the remainder is
  // exactly the attempt-2 defect: it silently converts "we cannot account for this path" into "we ran a
  // slightly different path", which is the one substitution this experiment cannot tolerate.
  const inferenceSteps = plan.executable
    ? plan.operations.filter((o) => o.kind !== "checkout" && o.command.length > 0).map((o) => ({ command: o.command, environment: o.environment }))
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

  const reference = runArm("reference", referencePlan.source, referencePlan.steps, referenceRepo, timeoutMs);
  const inference: ArmReceipt = plan.executable
    ? runArm("inference", "inferred ExecutionGraph", inferenceSteps, inferenceRepo, timeoutMs)
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

main();
