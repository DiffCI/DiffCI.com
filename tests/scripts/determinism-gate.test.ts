/**
 * SOURCE_PINNED ≠ EXECUTION_ENVIRONMENT_PINNED, tested against the five reference plans themselves.
 *
 * Member 5 is the case this exists for: `babel/babel-loader` at a commit dated 2026-08-04 installs
 * `webpack@5`, which today resolves to a version published 2026-09-01. Its CI passed; its suite now
 * fails; nothing about the repository, the container or the engine changed.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { assessDeterminism } from "../../scripts/determinism-gate.js";

const plan = (name: string): string[][] =>
  (JSON.parse(readFileSync(`docs/evidence/ci-reproduction-05-${name}-reference-plan.json`, "utf8")) as { steps: Array<{ command: string[] }> }).steps.map(
    (s) => s.command,
  );

test("babel-loader is FLOATING — the member this gate was written for", () => {
  const report = assessDeterminism(plan("babel-loader"));
  assert.equal(report.verdict, "FLOATING_DEPENDENCIES");
  assert.equal(report.historicalReproductionAvailable, false);
  assert.ok(report.floating.some((f) => f.includes("yarn add -D webpack@5")));
  assert.ok(report.floating.some((f) => f.includes("yarn up @babel/*@^7")));
});

test("webpack mutates at run time but with an EXACT spec — not the same as a range", () => {
  const report = assessDeterminism(plan("webpack"));
  assert.equal(report.verdict, "EXACT_SPEC_MUTATION", "pkg-pr-new@0.0.66 cannot silently become a different version");
  assert.equal(report.historicalReproductionAvailable, true);
  assert.ok(report.floating.some((f) => f.includes("pkg-pr-new@0.0.66")));
});

test("an exact spec and a range are not reported as the same situation", () => {
  assert.equal(assessDeterminism([["yarn", "add", "-D", "webpack@5"]]).verdict, "FLOATING_DEPENDENCIES");
  assert.equal(assessDeterminism([["yarn", "add", "-D", "webpack@5.110.3"]]).verdict, "EXACT_SPEC_MUTATION");
  assert.equal(assessDeterminism([["yarn", "add", "lodash"]]).verdict, "FLOATING_DEPENDENCIES", "a bare name is whatever latest means today");
});

test("jest is PINNED — `yarn --immutable` resolves strictly from the lockfile", () => {
  const report = assessDeterminism(plan("jest"));
  assert.equal(report.verdict, "EXECUTION_ENVIRONMENT_PINNED");
  assert.equal(report.historicalReproductionAvailable, true);
});

test("eslint is LOCKFILE_DEPENDENT, and the gate does not pretend to know more than the commands show", () => {
  const report = assessDeterminism(plan("eslint"));
  assert.equal(report.verdict, "LOCKFILE_DEPENDENT");
  assert.match(report.reason, /not visible from the commands alone/);
});

test("a bare install is not conflated with a mutating one", () => {
  assert.equal(assessDeterminism([["yarn"]]).verdict, "LOCKFILE_DEPENDENT");
  assert.equal(assessDeterminism([["yarn", "add", "-D", "webpack@5"]]).verdict, "FLOATING_DEPENDENCIES");
  assert.equal(assessDeterminism([["npm", "install"]]).verdict, "LOCKFILE_DEPENDENT");
  assert.equal(assessDeterminism([["npm", "install", "webpack@5"]]).verdict, "FLOATING_DEPENDENCIES", "naming a spec resolves live");
});

test("a plan with no install observes nothing rather than assuming determinism", () => {
  const report = assessDeterminism([["node", "Makefile", "mocha"]]);
  assert.equal(report.verdict, "NO_INSTALL_OBSERVED");
});
