/**
 * MECHANISM_PROOF_01 mutation job registration.
 *
 * Registration defects have cost this project real container hours: a corpus labelled with a clone path
 * instead of "owner/name" made a mutation pass match zero candidates and complete looking successful,
 * and a missing build step turned a registration mistake into an apparent qualification failure. The
 * couplings asserted here are the ones that fail SILENTLY - producing an empty, green-looking result
 * rather than an error.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { getValidationJob, mutateArgv, observePairsArgv, PINNED_CLONE, WORKSPACE } from "../../src/validation-env/validation-jobs.js";

const job = getValidationJob("tsjest-mechanism-mutation")!;

test("the mutation job is registered against the sealed tree and agent", () => {
  assert.equal(job.mode, "observe-pairs");
  assert.equal(job.repository, "kulshekhar/ts-jest");
  assert.equal(job.pinnedHeadSha, "b1a97ac485711377e01e72bac8b115e41a1c17ba");
  assert.equal(
    job.expectedAgentIntegrity,
    "sha512-mlNTeKlrkt6TqWBGi9e5O/QM90t7vXpmwyBIly5Mm1glHzRotWmV1s9A1PK3zJIwfntHEgh8S/t3lRJOYucN8g==",
  );
});

test("the observation writes its reports where the mutation pass reads them", () => {
  // The failure this prevents is silent: a mismatch here means dogfood-mutate finds no reports, builds
  // no candidates, and reports a successful run with nothing in it.
  const observed = observePairsArgv();
  const reportsDir = observed[observed.indexOf("--reports") + 1];
  const mutation = mutateArgv(job, WORKSPACE, PINNED_CLONE);
  assert.equal(reportsDir, mutation[mutation.indexOf("--reports") + 1]);
});

test("the mutation pass reads the corpus the observation wrote, and filters on the same repository", () => {
  const observed = observePairsArgv();
  const mutation = mutateArgv(job, WORKSPACE, PINNED_CLONE);
  assert.equal(observed[observed.indexOf("--out") + 1], mutation[mutation.indexOf("--corpus") + 1]);
  assert.equal(mutation[mutation.indexOf("--repository") + 1], "kulshekhar/ts-jest");
});

test("the execution recipe is copied from the run that established the green baselines, not tuned", () => {
  const economics = getValidationJob("survey-economics-ts-jest")!;
  assert.deepEqual(job.mutate, economics.mutate);
});

test("it observes the sealed five, and cannot re-derive candidates from git log", () => {
  const observed = observePairsArgv();
  assert.equal(observed[observed.indexOf("--pairs") + 1], "docs/evidence/mechanism-proof-pairs.json");
  assert.equal(job.commits, undefined);
});
