/**
 * The survey's classification rule, tested on synthetic facts.
 *
 * Synthetic deliberately: these tests must not depend on what any real repository happens to look like
 * today, and the survey's frozen 1-40 corpus must not be touched by a test run.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { adjudicate, declaredRunners, measureRunnerCapabilities } from "../../scripts/survey-adjudicate.js";
import type { RepositoryFacts } from "../../scripts/survey-facts.js";

function facts(overrides: Partial<RepositoryFacts> = {}): RepositoryFacts {
  return {
    rank: 1,
    packageName: "example",
    collectedAt: "2026-08-30T00:00:00.000Z",
    registry: { resolved: true, repositoryUrl: "git+https://github.com/acme/example.git" },
    repository: "acme/example",
    github: { unknown: false, archived: false, fork: false, language: "TypeScript" },
    clone: { ok: true, headSha: "a".repeat(40) },
    packageJson: {
      present: true,
      scripts: { test: "vitest run" },
      devDependencyNames: ["vitest"],
      dependencyNames: [],
    },
    files: { lockfiles: ["package-lock.json"], workspaceConfigs: [], runnerConfigs: ["vitest.config.ts"], ciWorkflows: [] },
    testSurface: {
      rootDirectories: ["src", "test"],
      patternCounts: { "*.test.[jt]s(x)": 12 },
      extensionCounts: { ts: 200, json: 10 },
    },
    ...overrides,
  };
}

describe("runner capability is measured, not asserted", () => {
  const byRunner = new Map(measureRunnerCapabilities().map((c) => [c.runner, c]));

  it("supports vitest and jest — both a failure count and a file count", () => {
    assert.equal(byRunner.get("vitest")!.supported, true);
    assert.equal(byRunner.get("jest")!.supported, true);
  });

  it("does NOT support mocha or node:test, and the reason is the FILE count specifically", () => {
    // This is why the pre-registration split gate 2 from gate 6: the failure count is readable and the
    // file count is not, so calling these "unreadable runners" without qualification would be wrong.
    for (const runner of ["mocha", "node:test"]) {
      const c = byRunner.get(runner)!;
      assert.equal(c.failureCountReadable, true, `${runner}'s failure count IS readable`);
      assert.equal(c.fileCountReadable, false, `${runner}'s file count is not`);
      assert.equal(c.supported, false);
    }
  });

  it("does not support AVA on either half, matching what chalk demonstrated", () => {
    const c = byRunner.get("ava")!;
    assert.equal(c.failureCountReadable, false);
    assert.equal(c.fileCountReadable, false);
  });
});

describe("exclusions come before every gate", () => {
  it("excludes a repository this project already examined", () => {
    const v = adjudicate(facts({ repository: "axios/axios" }));
    assert.equal(v.outcome, "EXCLUDED_ALREADY_EXAMINED");
    assert.equal(v.gate, 0);
  });

  it("excludes an archived repository", () => {
    const v = adjudicate(facts({ github: { unknown: false, archived: true } }));
    assert.equal(v.outcome, "EXCLUDED_ARCHIVED");
  });

  it("excludes a package naming no GitHub repository", () => {
    const v = adjudicate(facts({ repository: null }));
    assert.equal(v.outcome, "EXCLUDED_NO_REPOSITORY");
  });

  it("excludes a repository with neither a test script nor any test file", () => {
    const v = adjudicate(facts({
      packageJson: { present: true, scripts: { build: "tsc" }, devDependencyNames: [], dependencyNames: [] },
      testSurface: { rootDirectories: [], patternCounts: { "*.test.[jt]s(x)": 0 }, extensionCounts: { ts: 5 } },
    }));
    assert.equal(v.outcome, "EXCLUDED_NO_TESTS");
  });

  it("records a registry or clone failure as SURVEY_ERROR rather than a substantive category", () => {
    // A survey-machinery failure must never be laundered into a finding about the repository.
    assert.equal(adjudicate(facts({ registry: { resolved: false, error: "HTTP 500" } })).outcome, "SURVEY_ERROR");
    assert.equal(adjudicate(facts({ clone: { ok: false, error: "timeout" } })).outcome, "SURVEY_ERROR");
  });
});

describe("gates are evaluated in order and the first failure wins", () => {
  it("gate 1: a monorepo stops at scope, even when its runner is supported", () => {
    const v = adjudicate(facts({ files: { lockfiles: [], workspaceConfigs: ["pnpm-workspace.yaml"], runnerConfigs: ["vitest.config.ts"], ciWorkflows: [] } }));
    assert.equal(v.outcome, "MONOREPO_SCOPE_UNSUPPORTED");
    assert.equal(v.gate, 1);
  });

  it("gate 1 also fires on a package.json workspaces field", () => {
    const v = adjudicate(facts({
      packageJson: { present: true, workspaces: ["packages/*"], scripts: { test: "vitest run" }, devDependencyNames: ["vitest"], dependencyNames: [] },
    }));
    assert.equal(v.outcome, "MONOREPO_SCOPE_UNSUPPORTED");
  });

  it("gate 2: mocha fails on the file count, and the reason says so", () => {
    const v = adjudicate(facts({
      packageJson: { present: true, scripts: { test: "mocha" }, devDependencyNames: ["mocha"], dependencyNames: [] },
      files: { lockfiles: [], workspaceConfigs: [], runnerConfigs: [".mocharc.yml"], ciWorkflows: [] },
    }));
    assert.equal(v.outcome, "RUNNER_UNSUPPORTED");
    assert.equal(v.gate, 2);
    assert.match(v.reason, /file count unreadable/);
    assert.match(v.reason, /failure count readable/);
  });

  it("gate 3: a supported runner reachable only through a browser is not a root command", () => {
    const v = adjudicate(facts({
      packageJson: { present: true, scripts: { test: "vitest run --browser" }, devDependencyNames: ["vitest"], dependencyNames: [] },
    }));
    assert.equal(v.outcome, "NO_ROOT_COMMAND");
    assert.equal(v.gate, 3);
  });

  it("gate 4: a supported runner and script but no test files anywhere", () => {
    const v = adjudicate(facts({
      testSurface: { rootDirectories: [], patternCounts: { "*.test.[jt]s(x)": 0 }, extensionCounts: { ts: 50 } },
    }));
    assert.equal(v.outcome, "SELECTION_SURFACE_UNADDRESSABLE");
    assert.equal(v.gate, 4);
  });

  it("passes a single-package vitest repository through to qualification", () => {
    const v = adjudicate(facts());
    assert.equal(v.outcome, "REACHED_QUALIFICATION");
    assert.equal(v.gate, 5);
  });
});

describe("runner detection reads dependencies, configs and scripts", () => {
  it("finds a runner declared only in the test script", () => {
    const found = declaredRunners(facts({
      packageJson: { present: true, scripts: { test: "jest --ci" }, devDependencyNames: [], dependencyNames: [] },
      files: { lockfiles: [], workspaceConfigs: [], runnerConfigs: [], ciWorkflows: [] },
    }));
    assert.ok(found.includes("jest"), `expected jest in ${JSON.stringify(found)}`);
  });

  it("treats ts-jest and babel-jest as jest", () => {
    const found = declaredRunners(facts({
      packageJson: { present: true, scripts: { test: "echo hi" }, devDependencyNames: ["ts-jest"], dependencyNames: [] },
      files: { lockfiles: [], workspaceConfigs: [], runnerConfigs: [], ciWorkflows: [] },
    }));
    assert.ok(found.includes("jest"));
  });
});
