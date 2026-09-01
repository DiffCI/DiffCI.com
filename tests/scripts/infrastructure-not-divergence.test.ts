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
