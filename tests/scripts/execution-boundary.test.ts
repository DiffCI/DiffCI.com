/**
 * The execution boundary, as a test rather than a comment.
 *
 *   No DiffCI decision without an executable plan, and no execution of a refused plan.
 *
 * CI_REPRODUCTION_02 attempt 2 violated it: `plan.executable` was false, the harness filtered out the
 * blocking operation and ran the remainder, and then reported "no inference arm was run" while its own
 * receipt listed three executed steps. The engine was right and the harness was not.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const SOURCE = readFileSync("scripts/ci-reproduction.ts", "utf8");

test("a refused plan produces an EMPTY step list, not a filtered one", () => {
  assert.match(
    SOURCE,
    /plan\.executable\s*\?[\s\S]{0,400}?:\s*\[\]/,
    "the inference steps must be [] when the plan is not executable, never a filtered subset",
  );
});

test("the harness fails CLOSED if a refused plan carries execution receipts", () => {
  assert.match(SOURCE, /APPARATUS PROTOCOL VIOLATION/, "a refused plan with executed steps must throw");
  assert.match(SOURCE, /assertBoundaryHonoured\(plan\.executable, inference\)/, "the assertion must actually be called");
});

test("the refusal receipt carries the blocking nodes and the reason", () => {
  for (const field of ["blockedBy", "missingRequirements", "reason"]) {
    assert.ok(SOURCE.includes(`${field}:`), `a refusal receipt must record ${field}`);
  }
});

test("the REFUSED reason no longer claims nothing ran without checking", () => {
  // The false sentence from attempt 2, which must not survive.
  assert.ok(
    !SOURCE.includes("so no inference arm was run"),
    "the reason must be derived from the recorded refusal, not asserted",
  );
});
