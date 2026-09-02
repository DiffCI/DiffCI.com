/**
 * TAP_PARSING_01. `countsOf()` (ci-reproduction.ts) supplies `classify()`'s `suiteOf()` check with a
 * test count; before this, it had a Jest-shaped branch and a Mocha-shaped branch and no TAP branch at
 * all, so babel-loader's real `node --test` output — genuine TAP, `# fail 2` correctly parsed by the
 * UNRELATED `parseTestOutput()` — never produced a `tests` count, and `classify()` reported `DIVERGED`,
 * "neither arm executed a suite", for a step that plainly ran one.
 *
 * The primary criterion, per `docs/tap-parsing-01-plan.md`: does `countsOf()` now truthfully read
 * `tests: 66` out of the exact frozen output. Whether a FRESH run's `classify()` outcome subsequently
 * changes is separate, downstream evidence, not asserted here.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { countsOf } from "../../scripts/ci-reproduction.js";

const BABEL_LOADER_TAP = readFileSync("tests/scripts/fixtures/babel-loader-tap-tail.txt", "utf8");
const ESLINT_MOCHA = readFileSync("tests/scripts/fixtures/eslint-mocha-tail.txt", "utf8");

test("countsOf reads the real, frozen babel-loader TAP footer", () => {
  const counts = countsOf(BABEL_LOADER_TAP);
  assert.equal(counts.tests, 66, "the exact frozen output must now yield the count its own summary states");
  assert.equal(counts.testFiles, undefined, "TAP's `# suites N` is not a flat file count and must not be reported as testFiles");
});

test("a structural (non-babel-loader) TAP footer parses identically — genuinely structural, not a string match", () => {
  // Invented test names, an invented repository shape, the SAME footer convention. If this test needed
  // babel-loader's own test names to pass, the recognition would not be structural.
  const invented = `TAP version 13
# Subtest: some-completely-different-suite
    ok 1 - a thing that is true
    ok 2 - another thing that is true
    not ok 3 - something that is false
      ---
      duration_ms: 1.2
      type: 'test'
      ...
1..1
# tests 3
# suites 1
# pass 2
# fail 1
# cancelled 0
# skipped 0
# todo 0
# duration_ms 12.3
`;
  assert.deepEqual(countsOf(invented), { tests: 3 });
});

test("a bare `# tests N` line, without the rest of the footer, does NOT count as a completed suite", () => {
  // Exactly the ambiguity TAP's free-form `# comment` syntax permits: a single line matching the summary
  // SHAPE is not proof it IS the summary. Requiring `# pass`/`# fail` alongside it, the same way the
  // mocha branch requires `passing` OR `failing` rather than trusting either alone, is what tells the two
  // apart.
  const strayComment = `TAP version 13
# Subtest: something
    ok 1 - fine
# tests 3 of them were about widgets, for what it's worth
1..1
`;
  assert.deepEqual(countsOf(strayComment), {});
});

test("output truncated before the summary footer prints yields no count, never a partial guess", () => {
  // The exact failure mode this plan exists to avoid: a killed or truncated run must not have its
  // in-progress `ok`/`not ok` lines counted into a fabricated "completed successfully" total.
  const truncated = BABEL_LOADER_TAP.slice(0, BABEL_LOADER_TAP.indexOf("# tests"));
  assert.ok(truncated.length > 0 && !truncated.includes("# tests"), "the fixture must genuinely have no summary line left");
  assert.deepEqual(countsOf(truncated), {});
});

test("a footer with `# tests` and `# pass` but no `# fail` (a differently-truncated run) still yields no count", () => {
  const partial = `TAP version 13
ok 1 - something
1..1
# tests 1
# suites 1
# pass 1
`;
  assert.deepEqual(countsOf(partial), {}, "all three anchors are required, not merely the first two");
});

test("existing Jest and Mocha behaviour is unchanged", () => {
  assert.deepEqual(countsOf("Test Suites: 3 total\nTests:       1 failed, 5 passed, 6 total\n"), { testFiles: 3, tests: 6 });
  const mocha = countsOf(ESLINT_MOCHA);
  assert.equal(mocha.tests, 38627 + 11, "38627 passing + 11 pending, no failing line — unchanged from before this phase");
});
