/**
 * ACTION_INPUT_MODELING_01, prerequisite fix. `declaredPrerequisites`'s `carriesCommand` regex
 * (`infer.ts`) contained two literal U+0008 backspace BYTES where `\b` word-boundary escapes belonged —
 * a raw control character in a regex literal is a character to match, never satisfiable against an
 * identifier list, so the check was unconditionally false since it was written. Every unmodelled action
 * was reported `ARTIFACT`, never `ACTION_EXECUTION`, regardless of its declared `with:` keys.
 *
 * This is a standalone fix, not part of ACTION_INPUT_MODELING_01's own evidence: it does not touch how
 * any command gets extracted or executed, only how an unmodelled action's declared prerequisite is
 * LABELLED.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { inferPipeline } from "../../src/ci-inference/infer.js";
import type { ObservedFact } from "../../src/ci-inference/schema.js";

const NOW = "2026-09-02T00:00:00.000Z";
const NONEXISTENT_REPO = "C:/__diffci-infer-test-fixture-does-not-exist__";

function fact(partial: Partial<ObservedFact> & Pick<ObservedFact, "kind" | "value">): ObservedFact {
  return { evidence: { file: ".github/workflows/ci.yml", text: partial.value }, ...partial };
}

test("infer.ts's carriesCommand regex contains no raw control bytes", () => {
  // The bug was invisible to every text-rendering path tried first; only a raw byte scan caught it.
  // Guard against it recurring the same way: assert directly on the source bytes, not on rendered text.
  const source = readFileSync("src/ci-inference/infer.ts", "utf8");
  const controlBytes = [...source].filter((c) => {
    const cp = c.codePointAt(0)!;
    return cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d; // allow tab/LF/CR only
  });
  assert.deepEqual(controlBytes, [], "no stray control bytes (e.g. a literal backspace mistaken for \\b) anywhere in infer.ts");
});

test("declaredPrerequisites: an unmodelled action with a command-carrying input is ACTION_EXECUTION", () => {
  const facts: ObservedFact[] = [
    fact({ kind: "workflow.step.run", value: "yarn test", attributes: { workflow: "ci.yml", job: "test", step: "0" } }),
    fact({
      kind: "workflow.step.uses",
      value: "some-org/some-retry-action@abc123",
      attributes: { workflow: "ci.yml", job: "test", step: "1", withKeys: "timeout_minutes,command" },
    }),
  ];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW);
  const job = pipeline.jobs.find((j) => j.id === "ci.yml#test");
  const prereq = job?.prerequisites?.find((p) => p.identifier.startsWith("some-org/some-retry-action"));
  assert.equal(prereq?.kind, "ACTION_EXECUTION", "a declared `command` input must be recognised, not silently downgraded to ARTIFACT");
});

test("declaredPrerequisites: an unmodelled action with only artifact-shaped inputs stays ARTIFACT", () => {
  const facts: ObservedFact[] = [
    fact({ kind: "workflow.step.run", value: "yarn test", attributes: { workflow: "ci.yml", job: "test", step: "0" } }),
    fact({
      kind: "workflow.step.uses",
      value: "some-org/some-artifact-action@def456",
      attributes: { workflow: "ci.yml", job: "test", step: "1", withKeys: "name,path" },
    }),
  ];
  const pipeline = inferPipeline(NONEXISTENT_REPO, "test/repo", "abc123", facts, NOW);
  const job = pipeline.jobs.find((j) => j.id === "ci.yml#test");
  const prereq = job?.prerequisites?.find((p) => p.identifier.startsWith("some-org/some-artifact-action"));
  assert.equal(prereq?.kind, "ARTIFACT", "no command-shaped key means ARTIFACT, unchanged");
});
