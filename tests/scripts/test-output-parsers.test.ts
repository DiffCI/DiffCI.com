/**
 * The failure parser decides every mutation classification, so its failure mode matters more than its
 * success mode. The property that must hold: output it does not understand yields `undefined`, never
 * `0`. A parser that silently reported zero failures would turn an unmeasured run into a
 * RECALL_CONFIRMED, which is the exact false-confidence this whole corpus exists to avoid.
 *
 * Fixtures are real summary lines from each runner, not invented ones.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseTestOutput, SUPPORTED_RUNNERS } from "../../scripts/test-output-parsers.js";

describe("parseTestOutput", () => {
  it("reads node:test, in both TAP and spec-reporter form", () => {
    const tap = parseTestOutput("ok 1 - a\nnot ok 2 - b should work\n# tests 2\n# pass 1\n# fail 1\n");
    assert.equal(tap.framework, "node:test");
    assert.equal(tap.failures, 1);
    assert.deepEqual(tap.failedNames, ["b should work"]);

    const spec = parseTestOutput("ℹ tests 1622\nℹ suites 340\nℹ pass 1622\nℹ fail 0\n");
    assert.equal(spec.failures, 0);
    assert.equal(spec.framework, "node:test");
  });

  it("reads vitest, where the failed clause is absent when nothing failed", () => {
    const failing = parseTestOutput(" Test Files  1 failed | 2 passed (3)\n      Tests  1 failed | 4 passed (5)\n");
    assert.equal(failing.framework, "vitest");
    assert.equal(failing.failures, 1);

    const passing = parseTestOutput(" Test Files  3 passed (3)\n      Tests  5 passed (5)\n");
    assert.equal(passing.failures, 0, "a missing failed clause is zero, not unknown - the summary line was found");
  });

  it("reads jest", () => {
    const failing = parseTestOutput("Tests:       1 failed, 5 passed, 6 total\nSnapshots:   0 total\n");
    assert.equal(failing.framework, "jest");
    assert.equal(failing.failures, 1);

    const passing = parseTestOutput("Tests:       6 passed, 6 total\n");
    assert.equal(passing.failures, 0);
  });

  it("reads mocha", () => {
    const failing = parseTestOutput("\n  5 passing (32ms)\n  2 failing\n\n  1) thing should work:\n");
    assert.equal(failing.framework, "mocha");
    assert.equal(failing.failures, 2);

    const passing = parseTestOutput("\n  5 passing (32ms)\n");
    assert.equal(passing.failures, 0);
  });

  it("returns undefined - never zero - for output it does not understand", () => {
    // THE property. Each of these is a plausible real-world output that carries no summary line.
    for (const unknown of [
      "",
      "Error: Cannot find module 'vitest'\n",
      "npm ERR! code ELIFECYCLE\nnpm ERR! Test failed.\n",
      "Segmentation fault\n",
      "PASS src/a.test.ts\nPASS src/b.test.ts\n", // per-file lines, no summary
      "Killed\n",
    ]) {
      const parsed = parseTestOutput(unknown);
      assert.equal(parsed.failures, undefined, `"${unknown.slice(0, 30)}" must be unknown, not zero`);
      assert.equal(parsed.framework, undefined);
    }
  });

  it("does not mistake a crash for a clean run", () => {
    // A runner that dies before printing a summary has NOT proven the mutation is undetectable, and
    // must not be classified as if it had.
    const crashed = parseTestOutput("ℹ tests 400\nℹ pass 399\n\nFATAL ERROR: heap out of memory\n");
    assert.equal(crashed.failures, undefined, "no fail line means the run did not finish reporting");
  });

  it("covers the runners the engine claims to discover tests for", () => {
    // src/repo/test-framework.ts discovers vitest, jest and node:test. If the engine learns another,
    // the mutation pass cannot measure it until an adapter exists, and this is where that shows up.
    for (const runner of ["node:test", "vitest", "jest"]) {
      assert.ok(SUPPORTED_RUNNERS.includes(runner), `no failure-output adapter for ${runner}`);
    }
  });
});
