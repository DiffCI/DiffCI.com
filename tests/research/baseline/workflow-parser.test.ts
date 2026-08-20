import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { parseRepositoryWorkflows } from "../../../src/research/baseline/workflow-parser.js";
import type { RepositoryProfile } from "../../../src/repo/types.js";

// Regression guard: src/research/baseline/workflow-parser.ts imports the "yaml" package, but it was
// missing from diffci/package.json entirely - it only "worked" in local dev because Node's module
// resolution walked up to the parent DentalPresence.in repo's node_modules/yaml. A Cloudflare
// Container built from diffci/ alone (no parent repo) would have thrown ERR_MODULE_NOT_FOUND on every
// real repository with GitHub Actions workflows. Fixed 2026-08-20 by declaring "yaml" as a real
// dependency; this test exercises the actual parse path so a future removal of the dependency (without
// removing the import) fails loudly here instead of silently in a deployed container.

function repoProfile(workflowPath: string): RepositoryProfile {
  return {
    packageManager: "npm",
    packageJson: { scripts: {}, dependencies: [], devDependencies: [] },
    sourceRoots: [],
    tests: [],
    testFilePaths: [],
    workflows: [{ path: workflowPath }],
    configFiles: [],
    pathAliases: [],
    entryPoints: [],
    stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 1, configFiles: 0 },
  } as unknown as RepositoryProfile;
}

describe("parseRepositoryWorkflows (yaml dependency regression)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "diffci-workflow-parser-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("parses a real GitHub Actions workflow YAML file into tasks without throwing", () => {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(
      join(dir, ".github/workflows/ci.yml"),
      [
        "name: CI",
        "on: [push]",
        "jobs:",
        "  typecheck:",
        "    runs-on: ubuntu-latest",
        "    steps:",
        "      - run: npm run typecheck",
        "  test:",
        "    runs-on: ubuntu-latest",
        "    needs: [typecheck]",
        "    steps:",
        "      - name: Run unit tests",
        "        run: npm test",
      ].join("\n"),
    );

    const parsed = parseRepositoryWorkflows(repoProfile(".github/workflows/ci.yml"), dir);

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.name, "CI");
    const taskIds = parsed[0]!.tasks.map((t) => t.id);
    assert.ok(taskIds.some((id) => id.endsWith("::typecheck")));
    assert.ok(taskIds.some((id) => id.endsWith("::test")));
    const testTask = parsed[0]!.tasks.find((t) => t.id.endsWith("::test"))!;
    assert.equal(testTask.category, "test");
    assert.deepEqual(testTask.dependsOn, ["typecheck"]);
  });

  it("returns an empty task list (not a throw) for a malformed workflow file", () => {
    mkdirSync(join(dir, ".github/workflows"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/broken.yml"), "not: valid: yaml: [[[");

    const parsed = parseRepositoryWorkflows(repoProfile(".github/workflows/broken.yml"), dir);
    assert.equal(parsed.length, 1);
    assert.deepEqual(parsed[0]!.tasks, []);
  });
});
