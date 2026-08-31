/**
 * repository outcome ≠ execution infrastructure outcome.
 *
 * Every mistake this project made in the frame-continuation traversal was a version of collapsing those
 * two: an unregistered repository, an unreadable fact file, a wrong filename separator, and finally a
 * container platform that stopped mid-bootstrap three times running. Each, recorded as "this repository
 * failed", would have removed an eligible repository for a reason with no substance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildExecutionReceipt, outcomeLayer } from "../../src/validation-env/execution-receipt.js";

test("a failure before the repository executes is INFRASTRUCTURE", () => {
  for (const step of ["bootstrapping", "preparing", "verifyingUniverse", "registering"]) {
    assert.equal(outcomeLayer(step, true), "INFRASTRUCTURE", `${step} runs before any repository code`);
  }
});

test("a failure once the repository is executing is REPOSITORY", () => {
  for (const step of ["qualifying", "observing", "mutating"]) {
    assert.equal(outcomeLayer(step, true), "REPOSITORY");
  }
});

test("a successful run is never labelled INFRASTRUCTURE", () => {
  assert.equal(outcomeLayer("bootstrapping", false), "REPOSITORY");
});

test("the layer comes from the step, NOT from the error text", () => {
  // jest-dom failed three times with platform messages. Had the layer been guessed from the string,
  // a future platform whose wording changed would silently start producing REPOSITORY verdicts.
  const receipt = buildExecutionReceipt(
    {
      runId: "e2-11-jest-dom",
      jobId: "e2-jest-dom",
      mode: "qualify",
      shardIndex: 0,
      step: "failed",
      stepBeforeFailure: "bootstrapping",
      errorClass: "bootstrap-failed",
      error: "The sandbox container stopped while the operation was pending.",
    },
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal(receipt.outcome.layer, "INFRASTRUCTURE");
  assert.equal(receipt.outcome.failed, true);
});

test("a repository RED keeps its REPOSITORY layer", () => {
  const receipt = buildExecutionReceipt(
    { runId: "e2-02-lint-staged", jobId: "e2-lint-staged", mode: "qualify", shardIndex: 0, step: "done", stepBeforeFailure: undefined },
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal(receipt.outcome.layer, "REPOSITORY");
});

test("a DECLARED guard that never ran is recorded NOT_REACHED, not omitted", () => {
  // e2-12-jest-dom died in bootstrap before the apparatus guard and its receipt reported `guards: []`,
  // which reads identically to "this job declared no guard". That is the defect-19 blind spot wearing
  // a different hat: absence of evidence presented as evidence of absence.
  const receipt = buildExecutionReceipt(
    {
      runId: "e2-12-jest-dom",
      jobId: "e2-jest-dom",
      mode: "qualify",
      shardIndex: 0,
      step: "failed",
      stepBeforeFailure: "bootstrapping",
      guards: [
        { declared: true, executed: false, name: "requiresApparatus:gen-c", result: "NOT_REACHED", problems: ["the run failed before this control was reached"] },
      ],
    },
    "2026-08-31T00:00:00.000Z",
  );
  assert.equal(receipt.guards.length, 1);
  assert.equal(receipt.guards[0]!.executed, false);
  assert.equal(receipt.guards[0]!.result, "NOT_REACHED");
  assert.equal(receipt.outcome.layer, "INFRASTRUCTURE");
});
