/**
 * The comparison taxonomy, and the two ways it could quietly mislead.
 *
 * The properties under test: a false green is never absorbed into a friendlier category, and two
 * confirmations of DIFFERENT mutations are never reported as one reproduced finding.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { verdictFor } from "../../scripts/dogfood-compare.js";

const row = (classification: string, mutatedFile?: string) => ({
  repository: "honojs/hono",
  headSha: "e2740d5a1bd0b4254e517e3af8b60789284bc7bd",
  baseSha: "499c35ebda35777fd35a7dd1906dd4f2687da61e",
  classification,
  mutatedFile,
});

describe("verdictFor", () => {
  it("flags a host confirmation that became a false green as the critical result", () => {
    assert.equal(verdictFor(row("RECALL_CONFIRMED", "src/a.ts"), row("FALSE_GREEN", "src/a.ts")), "CRITICAL_REGRESSION");
  });

  it("still flags a false green that the host never measured", () => {
    // Not a regression against a prior confirmation, but it is a false green and must not be filed
    // under "coverage gained" just because the host had nothing to say.
    assert.equal(verdictFor(row("ENVIRONMENT_DIRTY"), row("FALSE_GREEN", "src/a.ts")), "NEW_FALSE_GREEN");
    assert.equal(verdictFor(row("RECALL_UNMEASURABLE"), row("FALSE_GREEN", "src/a.ts")), "NEW_FALSE_GREEN");
  });

  it("counts a confirmation of the same mutated file as reproduction", () => {
    assert.equal(verdictFor(row("RECALL_CONFIRMED", "src/utils/static.ts"), row("RECALL_CONFIRMED", "src/utils/static.ts")), "REPRODUCED");
  });

  it("refuses to call a confirmation of a DIFFERENT file the same finding reproduced", () => {
    // The harness walks a commit's changed files until one is measurable, so the environments can
    // legitimately land on different files. Agreement, but not the same evidence.
    assert.equal(
      verdictFor(row("RECALL_CONFIRMED", "src/utils/static.ts"), row("RECALL_CONFIRMED", "src/router/index.ts")),
      "REPRODUCED_OTHER_MUTATION",
    );
  });

  it("does not claim reproduction when either side never recorded which file it mutated", () => {
    assert.equal(verdictFor(row("RECALL_CONFIRMED"), row("RECALL_CONFIRMED", "src/a.ts")), "REPRODUCED_OTHER_MUTATION");
    assert.equal(verdictFor(row("RECALL_CONFIRMED", "src/a.ts"), row("RECALL_CONFIRMED")), "REPRODUCED_OTHER_MUTATION");
  });

  it("separates coverage gained from evidence lost", () => {
    assert.equal(verdictFor(row("ENVIRONMENT_DIRTY"), row("RECALL_CONFIRMED", "src/a.ts")), "COVERAGE_GAINED");
    assert.equal(verdictFor(row("INVALID_RUN"), row("RECALL_CONFIRMED", "src/a.ts")), "COVERAGE_GAINED");
    assert.equal(verdictFor(row("RECALL_CONFIRMED", "src/a.ts"), row("ENVIRONMENT_DIRTY")), "PORTABILITY_LOSS");
    assert.equal(verdictFor(row("RECALL_CONFIRMED", "src/a.ts"), row("RECALL_UNMEASURABLE")), "PORTABILITY_LOSS");
  });

  it("reports candidates that only one environment produced at all", () => {
    assert.equal(verdictFor(undefined, row("RECALL_CONFIRMED", "src/a.ts")), "MISSING_ON_HOST");
    assert.equal(verdictFor(row("RECALL_CONFIRMED", "src/a.ts"), undefined), "MISSING_IN_CANONICAL");
  });

  it("leaves both-unmeasurable alone rather than inventing a signal", () => {
    assert.equal(verdictFor(row("ENVIRONMENT_DIRTY"), row("ENVIRONMENT_DIRTY")), "BOTH_UNMEASURABLE");
    assert.equal(verdictFor(row("INVALID_RUN"), row("RECALL_UNMEASURABLE")), "BOTH_UNMEASURABLE");
  });
});
