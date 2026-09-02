/**
 * Defect 27, as the invariant rather than as a patch for its symptom.
 *
 *   Executable(P, OUTCOME) ⇒ ∃ o ∈ P : Purpose(o) = OUTCOME ∧ Executable(o) ∧ CausallyProvides(o, OUTCOME)
 *
 * jest's plan was one operation with `command: []`, `executable: false`, `willExecute: false`. Because
 * `willExecute === false` excluded it from `blocked`, `blocked` was empty and `path.length > 0` made the
 * plan **executable** — so DiffCI reported a plan for an issue-closing workflow and executed nothing.
 *
 * The five conditions are tested separately, because a fix that satisfies only the headline formula
 * would still admit several of the sample's shapes.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { planForPurpose, type InferredJob } from "../../src/ci-inference/jobs.js";
import type { InferredOperation } from "../../src/ci-inference/schema.js";

function op(partial: Partial<InferredOperation> & { id: string; kind: InferredOperation["kind"] }): InferredOperation {
  return {
    command: ["cmd"],
    workingDirectory: ".",
    environment: {},
    dependsOn: [],
    evidence: [],
    confidence: "high",
    unresolved: [],
    executable: true,
    missingRequirements: [],
    blockedBy: [],
    willExecute: true,
    executionRepresentation: "RESOLVED",
    ...partial,
  } as InferredOperation;
}

function job(operations: InferredOperation[]): InferredJob[] {
  return [{ id: "wf#job", workflow: "wf", job: "job", provides: ["TEST"], operations, blockedBy: [] }];
}

test("jest's exact shape: a path of entirely non-running steps is NOT executable", () => {
  const plan = planForPurpose(job([op({ id: "test-0", kind: "test", command: [], executable: false, willExecute: false })]), "TEST");

  assert.equal(plan.executable, false, "this was reported EXECUTABLE and then executed nothing");
  assert.match(plan.refusal!, /every operation in the TEST path is skipped/);
});

test("(1) an operation merely CLASSIFIED as TEST does not make the plan executable", () => {
  const plan = planForPurpose(
    job([op({ id: "install-0", kind: "install" }), op({ id: "test-1", kind: "test", executable: false, missingRequirements: ["a resolved command"] })]),
    "TEST",
  );

  assert.equal(plan.executable, false);
  assert.match(plan.refusal!, /causally provides TEST/);
});

test("(2,3) an UNRESOLVED condition on a predecessor blocks the plan", () => {
  const plan = planForPurpose(
    job([op({ id: "install-0", kind: "install", willExecute: undefined, executable: false }), op({ id: "test-1", kind: "test" })]),
    "TEST",
  );

  assert.equal(plan.executable, false, "UNRESOLVED is not FALSE and must not be treated as a skip");
  assert.match(plan.refusal!, /not executable/);
});

test("(4) a FALSE condition leaves the operation in the receipt but out of the active path", () => {
  const skipped = op({ id: "skip-0", kind: "build", willExecute: false, executable: false });
  const plan = planForPurpose(job([op({ id: "install-0", kind: "install" }), skipped, op({ id: "test-2", kind: "test" })]), "TEST");

  assert.equal(plan.executable, true, "a skipped step must not block a path it does not run in");
  assert.ok(plan.operations.some((o) => o.id === "skip-0"), "and must remain in the receipt — skipped is not never-existed");
});

test("(5) an execution-unrepresentable TEST cannot provide the outcome — webpack's shape", () => {
  const plan = planForPurpose(
    job([op({ id: "install-0", kind: "install" }), op({ id: "test-1", kind: "test", executionRepresentation: "UNRESOLVED", command: [], executable: false })]),
    "TEST",
  );

  assert.equal(plan.executable, false);
  assert.match(plan.refusal!, /causally provides TEST/);
});

test("a genuinely complete path is still executable — the fix must not refuse everything", () => {
  const plan = planForPurpose(job([op({ id: "install-0", kind: "install" }), op({ id: "test-1", kind: "test" })]), "TEST");

  assert.equal(plan.executable, true);
  assert.equal(plan.refusal, undefined);
});
