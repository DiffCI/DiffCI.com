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

import { parseTestOutput, parseTestFileCount, stripAnsi, SUPPORTED_RUNNERS } from "../../scripts/test-output-parsers.js";

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

/**
 * Colour (2026-08-29).
 *
 * The regression these cover cost four container runs to find: honojs/hono returned INVALID_RUN for all
 * 22 mutation candidates in the canonical Linux environment while every suite was actually passing. The
 * summary line was present and correct - and began with an escape sequence, so `^\s*Tests` never
 * matched. It presented as a cross-environment disagreement and was a parser defect.
 */
describe("coloured runner output", () => {
  // Copied from a real container run: vitest under CI, where FORCE_COLOR=0 does not disable colour.
  const HONO_COLOURED =
    "\x1B[2m Test Files \x1B[22m \x1B[1m\x1B[32m147 passed\x1B[39m\x1B[22m\x1B[90m (147)\x1B[39m\n" +
    "\x1B[2m      Tests \x1B[22m \x1B[1m\x1B[32m4961 passed\x1B[39m\x1B[22m\x1B[2m | \x1B[22m\x1B[33m44 skipped\x1B[39m\x1B[90m (5005)\x1B[39m\n";

  it("reads a passing summary that is wrapped in colour codes", () => {
    const parsed = parseTestOutput(HONO_COLOURED);
    assert.equal(parsed.framework, "vitest");
    assert.equal(parsed.failures, 0, "4961 passed, 44 skipped, nothing failed");
  });

  it("reads a FAILING coloured summary, which is the case that must never be missed", () => {
    // If colour hid a failure count, a mutation the suite DID catch would look like it was not caught.
    const failing = "\x1B[2m      Tests \x1B[22m \x1B[1m\x1B[31m3 failed\x1B[39m\x1B[2m | \x1B[22m\x1B[32m4958 passed\x1B[39m\x1B[90m (5005)\x1B[39m\n";
    assert.equal(parseTestOutput(failing).failures, 3);
  });

  it("leaves uncoloured output byte-identical, so existing frozen evidence stays valid", () => {
    const plain = " Test Files  1 passed (1)\n      Tests  5 passed (5)\n";
    assert.equal(stripAnsi(plain), plain);
    assert.equal(parseTestOutput(plain).failures, 0);
  });

  it("strips OSC hyperlinks as well as colour", () => {
    const withLink = `\x1B]8;;https://example.test\x07link\x1B]8;;\x07\n      Tests  2 failed | 1 passed (3)\n`;
    assert.equal(parseTestOutput(withLink).failures, 2);
  });

  it("still refuses to guess when the output has no summary at all", () => {
    // The core contract survives the change: unrecognised output is undefined, never 0.
    assert.equal(parseTestOutput("\x1B[32mbuilding...\x1B[39m\nnothing to report\n").failures, undefined);
  });
});

/**
 * Test-FILE counts, which the economic eligibility gate divides a CPU measurement by.
 *
 * A wrong denominator silently rescales the entire prediction, so this refuses rather than guesses -
 * the same rule the failure-count parsers follow, for the same reason.
 */
describe("parseTestFileCount", () => {
  it("takes vitest's parenthesised TOTAL, not the passed count", () => {
    // The real vuejs/core line. 182 passed but 183 ran; dividing by 182 would misstate cost per file.
    assert.equal(parseTestFileCount("      Test Files  182 passed | 1 skipped (183)\n"), 183);
    assert.equal(parseTestFileCount(" Test Files  147 passed (147)\n"), 147);
    assert.equal(parseTestFileCount(" Test Files  573 passed (573)\n"), 573);
  });

  it("reads a coloured line, because CI colourises regardless of FORCE_COLOR", () => {
    assert.equal(parseTestFileCount("\x1B[2m Test Files \x1B[22m \x1B[32m182 passed\x1B[39m | 1 skipped \x1B[90m(183)\x1B[39m\n"), 183);
  });

  it("reads jest's total", () => {
    assert.equal(parseTestFileCount("Test Suites: 1 failed, 2 passed, 3 total\n"), 3);
  });

  it("returns undefined rather than a guess when no count is present", () => {
    // The gate must refuse to produce a verdict, not proceed on an assumed denominator.
    assert.equal(parseTestFileCount("      Tests  42 passed (42)\n"), undefined);
    assert.equal(parseTestFileCount("building...\n"), undefined);
    assert.equal(parseTestFileCount(""), undefined);
  });

  it("does not mistake the Tests line for the Test Files line", () => {
    const both = " Test Files  10 passed (12)\n      Tests  400 passed (405)\n";
    assert.equal(parseTestFileCount(both), 12, "12 files, not 405 tests");
  });
});
