import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { runPathBaseline } from "../../src/planner/path-baseline.js";
import type { ChangedFile } from "../../src/git/types.js";

describe("runPathBaseline", () => {
  const ALL = ["src/a.test.ts", "src/b.test.ts", "scripts/do.test.ts", "ops/infra.test.ts"];

  function changed(...paths: string[]): ChangedFile[] {
    return paths.map((p) => ({ path: p, changeType: "modified" }));
  }

  it("selects no tests for docs-only changes", () => {
    const result = runPathBaseline(ALL, changed("README.md", "docs/guide.md"));
    assert.deepEqual(result.selectedTests, []);
    assert.ok(!result.fallbackRequired);
    assert.deepEqual(result.matchedRules, ["docs-only -> skip tests"]);
  });

  it("falls back to all tests on config/dependency changes", () => {
    const result = runPathBaseline(ALL, changed("package.json", "package-lock.json"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
  });

  it("falls back on workflow changes", () => {
    const result = runPathBaseline(ALL, changed(".github/workflows/ci.yml"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
  });

  it("falls back on database or infrastructure changes", () => {
    const db = runPathBaseline(ALL, changed("database/migrations/001.sql"));
    const infra = runPathBaseline(ALL, changed("docker/Dockerfile", "ops/aws/main.tf"));
    assert.ok(db.fallbackRequired);
    assert.ok(infra.fallbackRequired);
    assert.deepEqual(db.selectedTests, ALL);
  });

  it("selects src tests for src changes", () => {
    const result = runPathBaseline(ALL, changed("src/pages/index.tsx"));
    assert.deepEqual(result.selectedTests, ["src/a.test.ts", "src/b.test.ts"]);
    assert.ok(!result.fallbackRequired);
    assert.ok(result.matchedRules.includes("src/** -> all source tests"));
  });

  it("falls back when changed paths do not match any rule", () => {
    const result = runPathBaseline(ALL, changed("config/nested.conf", "random.txt"));
    assert.deepEqual(result.selectedTests, ALL);
    assert.ok(result.fallbackRequired);
    assert.ok(result.matchedRules.includes("no matching path rule -> run all tests"));
  });
});
