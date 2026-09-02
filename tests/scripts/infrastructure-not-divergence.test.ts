/**
 * Defect 23: an execution bound this harness imposes must never be scored against the graph.
 *
 * CI_REPRODUCTION_03 attempt 3 ran both arms to identical command sequences, installed successfully in
 * both, started the suite in both — and then `classify` reported **DIVERGED**, "neither arm executed a
 * suite, so no reproduction can be claimed". Both test steps had been killed by this harness's own
 * 20-minute `timeoutMs`. Nothing about the engine's graph was shown to be wrong.
 *
 * That is `unknown ≠ negative` — the rule this project keeps re-learning — compiled into the scorer,
 * where it is worse than a human slip because it applies silently to every future run.
 *
 * These tests are behavioural: they call `classify` rather than pattern-matching the source, so the
 * guarantee survives a rewrite of the function.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { type ArmReceipt, type StepReceipt, classify } from "../../scripts/ci-reproduction.js";

const BOUND_MS = 20 * 60_000;

function step(partial: Partial<StepReceipt> & { arm: "reference" | "inference"; stepId: string }): StepReceipt {
  return {
    command: ["npm", "run", "test:coverage"],
    commandIdentity: "npm run test:coverage",
    workingDirectory: "/workspace",
    environment: {},
    startedAt: "2026-09-01T00:00:00.000Z",
    endedAt: "2026-09-01T00:20:00.000Z",
    exitStatus: null,
    wallMs: BOUND_MS + 13,
    outputTail: "",
    ...partial,
  };
}

function arm(name: "reference" | "inference", steps: StepReceipt[]): ArmReceipt {
  return { arm: name, source: "test", steps, reachedEnd: false, node: "v22.23.2", npm: "10" };
}

test("a step killed by the harness bound is INFRASTRUCTURE, never DIVERGED", () => {
  const killed = (a: "reference" | "inference"): StepReceipt[] => [
    step({ arm: a, stepId: `${a}#0`, command: ["npm", "ci"], commandIdentity: "npm ci", exitStatus: 0, wallMs: 15_238, terminatedByBound: false, outcomeLayer: "repository" }),
    step({ arm: a, stepId: `${a}#1`, terminatedByBound: true, outcomeLayer: "harness" }),
  ];

  const result = classify(arm("reference", killed("reference")), arm("inference", killed("inference")), true);

  assert.equal(result.outcome, "INFRASTRUCTURE", "a harness timeout must not be reported as divergence");
  assert.notEqual(result.outcome, "DIVERGED");
  assert.match(result.reason, /not by the repository/i, "the reason must say where the failure belongs");
});

test("the INFRASTRUCTURE verdict names which step was killed, and for how long", () => {
  const steps = [step({ arm: "reference", stepId: "reference#1", terminatedByBound: true, outcomeLayer: "harness" })];
  const result = classify(arm("reference", steps), arm("inference", []), true);

  assert.match(result.reason, /reference#1/, "the killed step must be identified");
  assert.match(result.reason, /20\.0min/, "the duration reached before the kill must be stated");
});

test("DIVERGED survives when no bound fired — the fix must not swallow real divergence", () => {
  const reference = arm("reference", [
    step({ arm: "reference", stepId: "reference#0", exitStatus: 0, wallMs: 5_000, tests: 400, failures: 0, outcomeLayer: "repository" }),
  ]);
  const inference = arm("inference", [
    step({ arm: "inference", stepId: "inference#0", command: ["npm", "run", "lint"], commandIdentity: "npm run lint", exitStatus: 0, wallMs: 5_000, outcomeLayer: "repository" }),
  ]);

  const result = classify(reference, inference, true);
  assert.equal(result.outcome, "DIVERGED", "a graph that genuinely never runs a suite is still DIVERGED");
});

test("a refused plan is still REFUSED, and is not reclassified as infrastructure", () => {
  const result = classify(arm("reference", []), arm("inference", []), false);
  assert.equal(result.outcome, "REFUSED");
});

/**
 * Defects 25 and 26, from CI_REPRODUCTION_03 attempt 4.
 *
 * The scorer returned **REPRODUCED — both arms ran 161 tests with 113 failures**. Two things were wrong
 * with that, and the scorer could question neither:
 *
 *   26. Essentially every failure was jest's own "Exceeded timeout of 30000 ms for a test". 113 × 30s is
 *       ~56 minutes against a 51.8-minute run: the suite did not fail, it sat at its per-test ceiling.
 *       Each step was nonetheless labelled `outcomeLayer: "repository"`, blaming html-webpack-plugin for
 *       the container's throughput.
 *   25. REPRODUCED was decided from arm-to-arm agreement ALONE. At the pinned commit a lint failure at
 *       29s cancelled all 27 test cells within 51s, so real CI produced no completed test result for any
 *       cell — there was no ground truth to reproduce. Two arms agreeing with each other and with
 *       nothing external is precisely the near-tautological agreement the attempt-3 protocol warned of.
 */
import { type CiGroundTruth, environmentSignalsIn } from "../../scripts/ci-reproduction.js";

const JEST_TIMEOUT = 'thrown: "Exceeded timeout of 30000 ms for a test.';

function suite(a: "reference" | "inference", extra: Partial<StepReceipt> = {}): StepReceipt {
  return step({ arm: a, stepId: `${a}#2`, exitStatus: 1, wallMs: 3_106_000, tests: 161, testFiles: 4, failures: 113, outcomeLayer: "repository", ...extra });
}

test("a per-test timeout is an ENVIRONMENT signal, not a repository failure", () => {
  assert.deepEqual(environmentSignalsIn(JEST_TIMEOUT), ["jest per-test timeout"]);
  assert.deepEqual(environmentSignalsIn("expect(received).toEqual(expected)"), [], "a real assertion failure is not an environment signal");
});

test("agreeing arms whose failures are environment signals are ENVIRONMENT_INADEQUATE, not REPRODUCED", () => {
  const env = { environmentSignals: ["jest per-test timeout"] };
  const result = classify(arm("reference", [suite("reference", env)]), arm("inference", [suite("inference", env)]), true);

  assert.equal(result.outcome, "ENVIRONMENT_INADEQUATE");
  assert.notEqual(result.outcome, "REPRODUCED", "113 jest timeouts must never read as a successful reproduction");
  assert.match(result.reason, /could not execute/i);
});

test("without CI ground truth, agreeing arms are UNVERIFIABLE — agreement is not reproduction", () => {
  const result = classify(arm("reference", [suite("reference")]), arm("inference", [suite("inference")]), true);

  assert.equal(result.outcome, "UNVERIFIABLE");
  assert.match(result.reason, /ground truth/i);
});

test("a cancelled CI run is not usable ground truth", () => {
  const cancelled: CiGroundTruth = { cell: "test Node 22.x ubuntu-latest", conclusion: "cancelled", source: "github check-runs" };
  const result = classify(arm("reference", [suite("reference")]), arm("inference", [suite("inference")]), true, cancelled);

  assert.equal(result.outcome, "UNVERIFIABLE", "cancelled is not a result");
  assert.match(result.reason, /cancelled/);
});

test("REPRODUCED is still reachable when ground truth exists and the environment behaved", () => {
  const truth: CiGroundTruth = { cell: "test Node 22.x ubuntu-latest", conclusion: "success", source: "github check-runs" };
  const clean = (a: "reference" | "inference"): StepReceipt =>
    step({ arm: a, stepId: `${a}#2`, exitStatus: 0, wallMs: 120_000, tests: 161, testFiles: 4, failures: 0, outcomeLayer: "repository" });

  const result = classify(arm("reference", [clean("reference")]), arm("inference", [clean("inference")]), true, truth);
  assert.equal(result.outcome, "REPRODUCED", "the fixes must not make a genuine reproduction unreachable");
  assert.match(result.reason, /ground truth/i);
});

/**
 * GROUND_TRUTH_CONSISTENCY_01. Arm agreement is necessary for REPRODUCED, not sufficient - babel-loader's
 * real case: both arms ran 66 tests with 2 failures, identically, while CI ground truth for the cell
 * recorded "success". Two things agreeing with each other while both disagreeing with reality is
 * repeatability of the wrong result, not reproduction.
 */
test("babel-loader's real contradiction: success ground truth, 2/2 failures in both arms — GROUND_TRUTH_CONTRADICTED, not REPRODUCED", () => {
  const truth: CiGroundTruth = { cell: "Test - ubuntu-latest - Node 22, Babel 7, Webpack 5", conclusion: "success", source: "github actions job 92034086500" };
  const contradicted = (a: "reference" | "inference"): StepReceipt =>
    step({ arm: a, stepId: `${a}#2`, exitStatus: 1, wallMs: 4_490_000, tests: 66, testFiles: undefined, failures: 2, outcomeLayer: "repository" });

  const result = classify(arm("reference", [contradicted("reference")]), arm("inference", [contradicted("inference")]), true, truth);

  assert.equal(result.outcome, "GROUND_TRUTH_CONTRADICTED");
  assert.notEqual(result.outcome, "REPRODUCED", "repeatability of the wrong result must never read as reproduction");
  assert.match(result.reason, /success/);
  assert.match(result.reason, /66 tests, 2 failures/);
});

test("a success ground truth with a clean run in both arms is still REPRODUCED — the fix must not overcorrect", () => {
  const truth: CiGroundTruth = { cell: "test Node 22.x ubuntu-latest", conclusion: "success", source: "github check-runs" };
  const clean = (a: "reference" | "inference"): StepReceipt => step({ arm: a, stepId: `${a}#2`, exitStatus: 0, wallMs: 120_000, tests: 40, failures: 0, outcomeLayer: "repository" });

  const result = classify(arm("reference", [clean("reference")]), arm("inference", [clean("inference")]), true, truth);
  assert.equal(result.outcome, "REPRODUCED");
});

test("a failure ground truth with matching failures in both arms is REPRODUCED — the previously untested direction", () => {
  const truth: CiGroundTruth = { cell: "test Node 22.x ubuntu-latest", conclusion: "failure", source: "github check-runs" };
  const failing = (a: "reference" | "inference"): StepReceipt => step({ arm: a, stepId: `${a}#2`, exitStatus: 1, wallMs: 120_000, tests: 40, failures: 3, outcomeLayer: "repository" });

  const result = classify(arm("reference", [failing("reference")]), arm("inference", [failing("inference")]), true, truth);
  assert.equal(result.outcome, "REPRODUCED", "a failure ground truth matched by real failures in both arms is genuine reproduction");
});

test("a failure ground truth contradicted by a clean run in both arms is GROUND_TRUTH_CONTRADICTED — the asymmetric case", () => {
  // Deliberately NOT assumed symmetric with the success direction: a clean run against a recorded
  // failure is equally consistent with benign non-determinism AND with the reproduced path silently
  // never exercising whatever failed historically. The reason string, not just the outcome, must reflect
  // that this is a DIFFERENT caveat from the success-contradicted-by-failures case.
  const truth: CiGroundTruth = { cell: "test Node 22.x ubuntu-latest", conclusion: "failure", source: "github check-runs" };
  const clean = (a: "reference" | "inference"): StepReceipt => step({ arm: a, stepId: `${a}#2`, exitStatus: 0, wallMs: 120_000, tests: 40, failures: 0, outcomeLayer: "repository" });

  const result = classify(arm("reference", [clean("reference")]), arm("inference", [clean("inference")]), true, truth);
  assert.equal(result.outcome, "GROUND_TRUTH_CONTRADICTED");
  assert.match(result.reason, /does not by itself prove/i, "the failure-direction reason must carry its own, different caveat, not reuse the success-direction wording");
});

test("agreeing arms with no usable failure count are UNVERIFIABLE, never a manufactured GROUND_TRUTH_CONTRADICTED or REPRODUCED", () => {
  // countsOf() and parseTestOutput() are independent parsers over the same output; `tests` being defined
  // is not a guarantee `failures` is. The classifier must not treat an absent count as zero.
  const truth: CiGroundTruth = { cell: "test Node 22.x ubuntu-latest", conclusion: "success", source: "github check-runs" };
  const noFailureCount = (a: "reference" | "inference"): StepReceipt =>
    step({ arm: a, stepId: `${a}#2`, exitStatus: 0, wallMs: 120_000, tests: 40, failures: undefined, outcomeLayer: "repository" });

  const result = classify(arm("reference", [noFailureCount("reference")]), arm("inference", [noFailureCount("inference")]), true, truth);
  assert.equal(result.outcome, "UNVERIFIABLE");
  assert.doesNotMatch(result.reason, /GROUND_TRUTH_CONTRADICTED/);
});

/**
 * The runner-shape gap, caught before the CI_REPRODUCTION_05 run rather than after it.
 *
 * `countsOf` recognised only jest's "Tests: N total". eslint runs mocha. Both arms would have reported
 * `tests: undefined`, `suiteOf` would have found no suite in either, and `classify` would have returned
 * DIVERGED — "neither arm executed a suite" — for two runs that each executed thousands.
 */
import { countsOf } from "../../scripts/ci-reproduction.js";

test("jest and mocha epilogues both yield a test count", () => {
  assert.equal(countsOf("Test Suites: 2 failed, 2 passed, 4 total\nTests: 113 failed, 48 passed, 161 total").tests, 161);
  assert.equal(countsOf("  4212 passing (2m)\n  3 pending\n  5 failing").tests, 4220);
  assert.equal(countsOf("  4212 passing (2m)").tests, 4212);
});

test("unparseable output yields NO count, never zero", () => {
  assert.equal(countsOf("some unrelated output").tests, undefined, "zero would make 'ran nothing' look like 'ran and passed'");
});

test("a mocha run is recognised as a suite, so agreeing arms are not called DIVERGED", () => {
  const mocha = (a: "reference" | "inference"): StepReceipt =>
    step({ arm: a, stepId: `${a}#1`, command: ["node", "Makefile", "mocha"], commandIdentity: "node Makefile mocha", exitStatus: 0, wallMs: 124_700, failures: 0, outcomeLayer: "repository", ...countsOf("  4212 passing (2m)") });

  const truth: CiGroundTruth = { cell: "Test (ubuntu-latest, 22.x)", conclusion: "success", source: "github check-runs" };
  const result = classify(arm("reference", [mocha("reference")]), arm("inference", [mocha("inference")]), true, truth);
  assert.equal(result.outcome, "REPRODUCED");
});

/**
 * The same parser, against output the container actually produced.
 *
 * The mocha branch above was written against a hand-typed `"  38627 passing"` and its test passed on
 * that invented fixture. The real output is `"\x1b[32m 38627 passing\x1b[0m"`, where a `^\s*` anchor
 * cannot match — so the regex had been validated against my assumption, not against reality, and would
 * have reported no count on the very run it was written for.
 *
 * This fixture is the byte-for-byte tail captured from `ci-repro-05-eslint`.
 */
test("countsOf parses the REAL eslint mocha output, ANSI and all", () => {
  const real = readFileSync("tests/scripts/fixtures/eslint-mocha-tail.txt", "utf8");
  assert.equal(countsOf(real).tests, 38638, "38627 passing + 11 pending, read through the ANSI codes");
});

/**
 * Amendment 1's substitution, and the reason it is a one-entry whitelist.
 *
 * jest's CI runs `--max-workers ${{ steps.cpu-cores.outputs.count }}`. Transcribing that faithfully
 * needs the runner's core count; inventing a number would be command repair. The plan writes a token,
 * the harness resolves it, and the receipt records what it became — so the privilege the reference arm
 * enjoys is visible rather than buried in a command string.
 */
import { resolveTokens } from "../../scripts/ci-reproduction.js";

test("CPU_CORES resolves to a number and is recorded", () => {
  const { resolved, substitutions } = resolveTokens(["yarn", "test", "--max-workers", "${CPU_CORES}"]);
  assert.match(resolved[3]!, /^\d+$/, "the token must become a concrete count");
  assert.equal(substitutions["${CPU_CORES}"], resolved[3], "what it became must be recorded");
});

test("no other token is interpolated — the whitelist is the point", () => {
  const smuggle = ["npm", "install", "${HOME}", "$(whoami)", "${{ secrets.TOKEN }}"];
  const { resolved, substitutions } = resolveTokens(smuggle);
  assert.deepEqual(resolved, smuggle, "nothing but CPU_CORES may expand");
  assert.deepEqual(substitutions, {}, "and nothing else may be recorded as substituted");
});

test("a command with no token is returned untouched, with no substitutions", () => {
  const { resolved, substitutions } = resolveTokens(["npm", "ci"]);
  assert.deepEqual(resolved, ["npm", "ci"]);
  assert.deepEqual(substitutions, {});
});

/**
 * Amendment 3: `cmd || true` represented as data, not handed to a shell.
 *
 * webpack's cell contains `yarn link --frozen-lockfile || true`. A reference plan is an argv array and
 * repository-derived strings must never cross an implicit shell boundary, so the operator's meaning is
 * carried as `allowFailure` instead. The receipt still records the real exit status: the step is
 * permitted to fail, not pretended to have succeeded.
 */
test("allowFailure is structured data, never a shell operator in argv", () => {
  const plan = JSON.parse(readFileSync("docs/evidence/ci-reproduction-05-webpack-reference-plan.json", "utf8"));
  const linkStep = plan.steps.find((s: { command: string[] }) => s.command.includes("link") && !s.command.includes("webpack"));

  assert.equal(linkStep.allowFailure, true, "the `|| true` must survive as a flag");
  for (const step of plan.steps) {
    for (const token of step.command as string[]) {
      assert.doesNotMatch(token, /[|&;<>$`]/, `no shell metacharacter may reach argv: ${token}`);
    }
  }
});

test("the retry branch of a `A || A -f` line is not transcribed", () => {
  const plan = JSON.parse(readFileSync("docs/evidence/ci-reproduction-05-webpack-reference-plan.json", "utf8"));
  const suites = plan.steps.filter((s: { command: string[] }) => s.command.includes("cover:integration:a"));
  assert.equal(suites.length, 1, "running the retry too would let a suite that failed once be recorded as passing");
  assert.ok(!suites[0].command.includes("-f"), "the --onlyFailures retry must not be the command that runs");
});

/**
 * Defects 32 and 33, from sample member 4.
 *
 * babel's R3 reported **R3_QUALIFIED** for an arm that exited 127 on `make: not found` at step 3 of 9,
 * and its own reason string read "the reference arm completed (exit 127) with no environment signals".
 * `completed` meant only "exit status is not null", so a command-not-found counted as completion — and
 * the arm never reached the suite at all. Qualification asked whether the process ENDED, not whether it
 * WORKED.
 *
 * Separately, that step was recorded `outcomeLayer: "repository"`, charging babel for a toolchain
 * GitHub's ubuntu runner ships and this container does not.
 */
test("a missing toolchain is an ENVIRONMENT signal, not a repository failure", () => {
  assert.deepEqual(environmentSignalsIn("/bin/sh: 1: make: not found"), ["toolchain missing"], "sh phrasing - the ACTUAL babel output");
  assert.deepEqual(environmentSignalsIn("  it returns 404 when not found"), [], "a test NAME containing the words must not match");
  assert.deepEqual(environmentSignalsIn("bash: make: command not found"), ["toolchain missing"]);
  assert.deepEqual(environmentSignalsIn("node: No such file or directory"), ["toolchain missing"]);
  assert.deepEqual(environmentSignalsIn("AssertionError: expected 1 to equal 2"), [], "a real test failure is not a toolchain signal");
});

test("R3 must not qualify an arm that failed before reaching a suite", () => {
  const SOURCE = readFileSync("scripts/ci-reproduction.ts", "utf8");
  assert.match(SOURCE, /const allSucceeded = reference\.steps\.every/, "every step must have succeeded");
  assert.match(SOURCE, /const ranSuite = reference\.steps\.some\(\(s\) => typeof s\.tests === "number" && s\.tests > 0\)/, "a suite must actually have run");
  assert.match(SOURCE, /qualified = allSucceeded && reference\.reachedEnd && ranSuite && signals\.length === 0/, "all four conditions, not just a non-null exit");
});

/**
 * Amendment 5: metacharacter-bearing argv is spawned with NO shell, never rejected and never shelled.
 *
 * babel-loader runs `yarn up @babel/*@^7`. That is one well-formed command — the glob is not shell
 * syntax; bash finds no match, passes the string through, and yarn expands it. Rejecting it would fail
 * the repository for something the harness chose to do; shelling it would breach the invariant. Spawning
 * without a shell honours the invariant *more* strictly, because no shell ever sees the string.
 */
import { findShellUnsafeArgument } from "../../scripts/shell-safety.js";

test("the metacharacter set is NOT loosened — that would be the wrong fix", () => {
  assert.equal(findShellUnsafeArgument(["yarn", "up", "@babel/*@^7"]), "@babel/*@^7", "still flagged as unsafe for a shell");
  assert.equal(findShellUnsafeArgument(["yarn", "install"]), undefined);
  // `-c` itself is metacharacter-free; the payload is what gets flagged, which is the point.
  assert.equal(findShellUnsafeArgument(["sh", "-c", "rm -rf / ; echo pwned"]), "rm -rf / ; echo pwned", "injection payloads stay flagged");
});

test("the harness chooses no-shell exactly when argv is unsafe for a shell", () => {
  const SOURCE = readFileSync("scripts/ci-reproduction.ts", "utf8");
  assert.match(SOURCE, /const unsafeArgument = findShellUnsafeArgument\(resolved\)/);
  assert.match(SOURCE, /const useShell = unsafeArgument === undefined/, "shell only when nothing is unsafe");
  assert.match(SOURCE, /shell: useShell/, "the decision must reach the spawn");
  assert.match(SOURCE, /spawnedWithoutShell: true/, "and be recorded in the receipt");
});

test("members 1-4 are unaffected: their commands are all metacharacter-free", () => {
  for (const plan of ["eslint", "jest", "webpack", "babel"]) {
    const doc = JSON.parse(readFileSync(`docs/evidence/ci-reproduction-05-${plan}-reference-plan.json`, "utf8"));
    for (const step of doc.steps as Array<{ command: string[] }>) {
      const resolved = step.command.map((t) => t.replace("${CPU_CORES}", "4"));
      assert.equal(findShellUnsafeArgument(resolved), undefined, `${plan}: ${resolved.join(" ")} must keep the shell path`);
    }
  }
});
