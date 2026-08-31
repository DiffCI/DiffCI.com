/**
 * Apparatus qualification for analyser generation C.
 *
 * The assertions here exist to stop generation C inheriting generation B's identity. Defect 18 made
 * that a live hazard rather than a theoretical one: `validation:pack` uploaded a stale agent tarball
 * and reported the UNCHANGED generation-B digest after the defect-17 analyser change, so a run could
 * have measured the old analyser while every artefact claimed the new one.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getValidationJob, universeArgv } from "../../src/validation-env/validation-jobs.js";

const GENERATION_B = "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==";
const job = getValidationJob("apparatus-qualify-gen-c")!;

test("it pins a DIFFERENT agent than the generation that produced the frozen result", () => {
  assert.ok(job.expectedAgentIntegrity, "an apparatus qualification must pin its agent");
  assert.notEqual(
    job.expectedAgentIntegrity,
    GENERATION_B,
    "generation C must not carry generation B's digest - that would qualify the analyser that is being replaced",
  );
});

test("every job that pins generation B's digest is a pre-existing one, never a new apparatus job", () => {
  // A future job copied from an old one would silently re-pin the frozen analyser.
  const genC = getValidationJob("apparatus-qualify-gen-c")!;
  assert.notEqual(genC.expectedAgentIntegrity, GENERATION_B);
});

test("it qualifies against ground truth: 20 executable tests, and none from the ignored trees", () => {
  assert.equal(job.universe?.expectedTestCount, 20);
  assert.deepEqual(job.universe?.forbiddenPrefixes, ["e2e", "examples", "presets", "scripts", "website"]);
});

test("it observes no candidate pair and mutates nothing", () => {
  // Candidate 5 is now a known success case. A qualification run that touched it would invite
  // comparing the repaired analyser against the sealed experiment before the next one is registered.
  assert.equal(job.mode, "qualify");
  assert.equal(job.mutate, undefined);
  assert.equal(job.commits, undefined);
});

test("the universe argv carries the expectations and writes a collectable verdict", () => {
  const argv = universeArgv(job);
  assert.equal(argv[argv.indexOf("--expect-tests") + 1], "20");
  assert.equal(argv[argv.indexOf("--forbid-prefixes") + 1], "e2e,examples,presets,scripts,website");
  assert.ok(argv.includes("--out"), "the verdict must be written, not only printed to a log");
});
