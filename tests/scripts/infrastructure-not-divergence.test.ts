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
