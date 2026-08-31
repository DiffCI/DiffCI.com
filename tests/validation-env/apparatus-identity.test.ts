/**
 * The qualified apparatus must be the one that runs a sealed experiment.
 *
 * Defect 18 is the reason this is a runtime guard and not a comment: `pack` uploaded a stale agent and
 * reported the previous generation's digest, so a run could have measured generation B while every
 * artefact claimed C.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { apparatusMismatches, GENERATION_B_AGENT_INTEGRITY, GENERATION_C } from "../../src/validation-env/apparatus-identity.js";

test("the qualified apparatus passes", () => {
  assert.deepEqual(
    apparatusMismatches({ agentIntegrity: GENERATION_C.agentIntegrity, image: GENERATION_C.image, node: GENERATION_C.node }),
    [],
  );
});

test("generation B is refused, and named as the superseded analyser", () => {
  const problems = apparatusMismatches({ agentIntegrity: GENERATION_B_AGENT_INTEGRITY, image: GENERATION_C.image });
  assert.equal(problems.length, 1);
  assert.match(problems[0]!, /generation B/);
  assert.match(problems[0]!, /defect-18/);
});

test("an absent agent digest is a mismatch, never a pass", () => {
  assert.ok(apparatusMismatches({ image: GENERATION_C.image }).length > 0);
});

test("every mismatch is reported, not just the first", () => {
  const problems = apparatusMismatches({ agentIntegrity: "sha512-other", image: "docker.io/other:1", node: "v20.0.0" });
  assert.equal(problems.length, 3);
});

test("the committed identity file agrees with the code", () => {
  // Two copies of one fact drift. The test is what stops them.
  const file = JSON.parse(readFileSync("docs/evidence/apparatus-gen-c/APPARATUS_IDENTITY.json", "utf8")) as Record<string, any>;
  assert.equal(file.agentIntegrity, GENERATION_C.agentIntegrity);
  assert.equal(file.analyserCommit, GENERATION_C.analyserCommit);
  assert.equal(file.sourceTarballSha256, GENERATION_C.sourceTarballSha256);
  assert.equal(file.environment.image, GENERATION_C.image);
  assert.equal(file.supersededGeneration.agentIntegrity, GENERATION_B_AGENT_INTEGRITY);
});

test("the apparatus guard sits where EVERY mode reaches it", () => {
  // Defect 19. The guard first lived at the tail of prepare(), which calibrate, survey and density all
  // return from before reaching - so `requiresApparatus` silently never ran for them, and
  // survey-continuation-01 completed with the control reported as protection but never executed.
  // A structural test, because the failure was structural: the code was correct and unreachable.
  const src = readFileSync("src/validation-env/cloudflare/validation-shard-do.ts", "utf8");
  const guardAt = src.indexOf("job.requiresApparatus === \"gen-c\"");
  assert.ok(guardAt > 0, "the guard must exist");

  // Every early return that skips the rest of prepare() must come AFTER the guard.
  for (const mode of ["calibrate", "survey", "density"]) {
    const branchAt = src.indexOf(`job.mode === "${mode}"`);
    assert.ok(branchAt > 0, `the ${mode} branch must exist`);
    assert.ok(
      guardAt < branchAt,
      `the apparatus guard must precede the ${mode} early-return, or the control never runs for it`,
    );
  }
});
