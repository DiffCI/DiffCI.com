/**
 * The two false TEST classifications from CI_REPRODUCTION_SAMPLE_01, as regression tests, plus the
 * true positives that must survive the fix.
 *
 * Both false positives came from `/\b(jest|vitest|mocha|ava)\b/` applied to a whole command line. They
 * are the reason purpose is now derived from the executable position and from script bodies the
 * repository declares — never from a substring.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { establishesPurpose, firstCommandTokens, purposeOfLine } from "../../src/ci-inference/purpose.js";

const NO_SCRIPTS = () => undefined;

test("jest's issue-closing command is NOT a test operation", () => {
  const line = `gh issue close $ISSUE --comment "As noted in the [Bug Report template](https://github.com/jestjs/jest/blob/main/.github/ISSUE_TEMPLATE/bug.yml), all bug reports requires a minimal reproduction."`;
  const verdict = purposeOfLine(line, NO_SCRIPTS);
  assert.notEqual(verdict.purpose, "test", "a URL containing `jest` must not make this a TEST operation");
  assert.equal(verdict.basis, "NONE");
  assert.equal(establishesPurpose(verdict), false, "and it must not license a plan");
});

test("webpack's patch-applying command is NOT a test operation", () => {
  for (const line of ["git apply test/patches/jest-worker+30.4.1.patch", "git apply test/patches/jest-runner+30.4.2.patch"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.notEqual(verdict.purpose, "test", `a patch filename must not make \`${line}\` a TEST operation`);
    assert.equal(establishesPurpose(verdict), false);
  }
});

test("a test runner in EXECUTABLE position is a test operation", () => {
  for (const line of ["jest --ci", "vitest run", "mocha spec/", "node ./node_modules/.bin/jest --ci", "npx vitest"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.equal(verdict.purpose, "test", line);
    assert.equal(verdict.basis, "EXECUTABLE_POSITION", line);
  }
});

test("a script resolves through its BODY, which is how webpack's integration suite becomes visible", () => {
  // webpack declares `cover:integration:a`; its name says nothing, its body runs jest.
  const scripts: Record<string, string> = { "cover:integration:a": "nyc --reporter=json jest --ci --testPathPattern=integration" };
  const verdict = purposeOfLine("yarn cover:integration:a --ci --cacheDirectory .jest-cache", (n) => scripts[n]);

  assert.equal(verdict.purpose, "test");
  assert.equal(verdict.basis, "SCRIPT_BODY");
  assert.match(verdict.evidence, /cover:integration:a/);
});

test("a COMPOUND line still yields its purpose — argv failure must not erase semantics", () => {
  // The exact shape that cost webpack its TEST purpose across all 31 job instances.
  const scripts: Record<string, string> = { "cover:integration:a": "jest --ci" };
  const line = "yarn cover:integration:a --ci --cacheDirectory .jest-cache || yarn cover:integration:a --ci --cacheDirectory .jest-cache -f";

  assert.deepEqual(firstCommandTokens(line).slice(0, 2), ["yarn", "cover:integration:a"], "only the first command is read");
  assert.equal(purposeOfLine(line, (n) => scripts[n]).purpose, "test", "the `||` must not delete the purpose");
});

test("a conventional script NAME counts only when the repository declares that script", () => {
  const declared = purposeOfLine("npm run test:coverage -- --ci", (n) => (n === "test:coverage" ? "some-opaque-wrapper --run" : undefined));
  assert.equal(declared.purpose, "test");
  assert.equal(declared.basis, "SCRIPT_NAME", "the body was unrecognised, so the declared name carries it");

  const undeclared = purposeOfLine("npm run test:coverage", NO_SCRIPTS);
  assert.equal(undeclared.basis, "NONE", "a name proves nothing about a script the repository does not declare");
});

test("install operations are recognised from the package manager, including yarn's mutating forms", () => {
  for (const line of ["npm ci --legacy-peer-deps", "yarn", "yarn --immutable", "yarn add -D webpack@5", "yarn up @babel/*@^7", "pnpm install"]) {
    assert.equal(purposeOfLine(line, NO_SCRIPTS).purpose, "install", line);
  }
});

test("script recursion terminates rather than hanging on a cycle", () => {
  const scripts: Record<string, string> = { a: "npm run b", b: "npm run a" };
  const verdict = purposeOfLine("npm run a", (n) => scripts[n]);
  assert.equal(verdict.purpose, "unknown", "a cycle resolves to unknown, not to a stack overflow");
});

test("no basis exists for `the text mentioned a framework somewhere`", () => {
  const verdict = purposeOfLine("echo 'we use jest here'", NO_SCRIPTS);
  assert.equal(verdict.basis, "NONE");
  assert.equal(establishesPurpose(verdict), false);
});

test("a coverage wrapper delegates to the runner it wraps", () => {
  for (const line of ["nyc --reporter=json jest --ci", "c8 vitest run", "cross-env NODE_ENV=test jest", "istanbul cover mocha"]) {
    const verdict = purposeOfLine(line, NO_SCRIPTS);
    assert.equal(verdict.purpose, "test", line);
    assert.equal(verdict.basis, "EXECUTABLE_POSITION", line);
  }
});

test("a wrapper with nothing recognisable inside it stays unknown", () => {
  assert.equal(purposeOfLine("nyc --reporter=json ./scripts/custom.sh", NO_SCRIPTS).basis, "NONE");
});

test("babel's real test command is recognised through the interpreter", () => {
  const verdict = purposeOfLine("node ./node_modules/.bin/jest --ci", NO_SCRIPTS);
  assert.equal(verdict.purpose, "test");
  assert.equal(verdict.basis, "EXECUTABLE_POSITION");
});

/**
 * LAYER 2 guards: inference must CONSUME the structural verdict, never rediscover purpose from text.
 *
 * Removing substring authority from one module while a consumer re-derives it downstream would recreate
 * defect 28 exactly where it is hardest to see. These assert the old authority is gone from the source,
 * not merely bypassed.
 */
import { readFileSync as read } from "node:fs";

test("infer.ts contains no substring-based purpose rule", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.doesNotMatch(source, /\/\b\(jest\|vitest\|mocha\|ava\)\b\/\.test/, "the deleted rule must not return");
  assert.doesNotMatch(source, /function kindOfRunLine/, "dead code encoding the old authority is one call from reinstating it");
  assert.doesNotMatch(source, /function kindOfScript/);
  assert.match(source, /purposeOfLine\(line, lookupScript\)/, "purpose must be consumed from the structural module");
});

test("willExecute is three-valued: UNRESOLVED yields undefined, never false", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.doesNotMatch(source, /const willExecute = condition \? condition\.result === "TRUE" : true/, "defect 29 must not return");
  assert.match(source, /condition\.result === "FALSE" \? false : undefined/, "UNRESOLVED must fall through to undefined");
});

test("operations carry executionRepresentation and purposeBasis", () => {
  const source = read("src/ci-inference/infer.ts", "utf8");
  assert.match(source, /executionRepresentation,/);
  assert.match(source, /purposeBasis: verdict\.basis,/, "PurposeBasis must reach the receipt for the eventual learning layer");
});
