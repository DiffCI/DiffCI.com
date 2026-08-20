import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { DefaultCIPlanner } from "../../src/planner/planner.js";
import { buildDentalPresenceTaskRegistry } from "../../src/planner/task-registry.js";
import type { ChangedFile, GitDelta } from "../../src/git/types.js";
import type { ImpactResult } from "../../src/repo/impact-types.js";
import type { RepositoryProfile } from "../../src/repo/types.js";

function makeProfile(options: { tests?: string[] } = {}): RepositoryProfile {
  const testFilePaths = options.tests ?? ["src/example.test.ts"];
  return {
    packageManager: "npm",
    packageJson: { name: "test", version: "1.0.0", scripts: {}, dependencies: [], devDependencies: [] },
    sourceRoots: [],
    tests: testFilePaths.map((g) => ({ glob: g, count: 1 })),
    testFilePaths,
    workflows: [],
    configFiles: [],
    pathAliases: [],
    entryPoints: [],
    nextConfig: { exists: false },
    stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
  };
}

function makeDelta(files: ChangedFile[]): GitDelta {
  return {
    baseSha: "base",
    headSha: "head",
    files,
    directories: [],
    summary: { added: 0, modified: files.length, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: files.length },
    analysis: {
      empty: files.length === 0,
      configChanged: files.some((f) => /^(tsconfig|next\.config|eslint\.config|package\.json)/.test(f.path)),
      dependencyManifestChanged: files.some((f) => f.path === "package.json"),
      lockfileChanged: files.some((f) => /lock/.test(f.path)),
      workflowChanged: files.some((f) => f.path.startsWith(".github/workflows/")),
      infrastructureChanged: files.some((f) => f.path.startsWith("ops/") || f.path.startsWith("terraform/") || /Dockerfile/.test(f.path)),
      databaseChanged: files.some((f) => f.path.startsWith("database/")),
    },
  };
}

function makeImpactResult(overrides: Partial<ImpactResult> = {}): ImpactResult {
  return {
    changedFiles: [],
    affectedSourceFiles: [],
    affectedAssets: [],
    affectedTests: [],
    affectedEntryPoints: [],
    affectedScripts: [],
    riskSignals: [],
    fallbackRequired: false,
    fallbackReasons: [],
    analysisStatus: "SAFE_TO_PROPOSE",
    effectiveGraphConfidence: "COMPLETE",
    evidence: [],
    performance: { durationMs: 0 },
    ...overrides,
  };
}

describe("DefaultCIPlanner", () => {
  const registry = buildDentalPresenceTaskRegistry();
  const planner = new DefaultCIPlanner(registry);

  it("proposes SELECTIVE plan and skips unrelated tasks", () => {
    const profile = makeProfile({ tests: ["src/example.test.ts", "src/other.test.ts"] });
    const delta = makeDelta([{ path: "src/example.ts", changeType: "modified" }]);
    const impact = makeImpactResult({
      affectedTests: [{ path: "src/example.test.ts", reasons: ["DIRECT_CHANGE"], evidence: [] }],
      changedFiles: [{ file: delta.files[0]!, category: "source", reasons: ["DIRECT_CHANGE"] }],
    });
    const plan = planner.plan({ delta, impact, profile });

    assert.equal(plan.mode, "SELECTIVE");
    assert.deepEqual(plan.selectedTests, ["src/example.test.ts"]);
    assert.ok(plan.skippedTests.includes("src/other.test.ts"));
    assert.ok(!plan.safety.fallbackRequired);
    const typecheck = plan.tasks.find((t) => t.id === "typecheck");
    assert.equal(typecheck?.status, "RUN");
    const scripts = plan.tasks.find((t) => t.id === "test:scripts");
    assert.equal(scripts?.status, "SKIP_CANDIDATE");
  });

  it("switches to FULL fallback when impact requires fallback", () => {
    const profile = makeProfile({ tests: ["src/a.test.ts"] });
    const delta = makeDelta([{ path: "package.json", changeType: "modified" }]);
    const impact = makeImpactResult({
      fallbackRequired: true,
      fallbackReasons: ["Dependency manifest changed"],
      riskSignals: [{ level: "critical", reason: "DEPENDENCY_MANIFEST", message: "package.json changed" }],
      changedFiles: [{ file: delta.files[0]!, category: "config", reasons: ["DEPENDENCY_MANIFEST"] }],
    });
    const plan = planner.plan({ delta, impact, profile });

    assert.equal(plan.mode, "FULL");
    assert.ok(plan.safety.fallbackRequired);
    assert.deepEqual(plan.selectedTests, ["src/a.test.ts"]);
    assert.equal(plan.skippedTests.length, 0);
    const build = plan.tasks.find((t) => t.id === "build:next");
    assert.equal(build?.status, "FULL_FALLBACK");
  });

  it("triggers a task for a source file nested two or more directories deep under a `**` input pattern (regression: globstar matcher used to mis-match multi-segment paths)", () => {
    const profile = makeProfile({ tests: ["src/a.test.ts"] });
    // typecheck's inputPatterns include "src/**/*.{ts,tsx}" - this file is two directories
    // below src/, which is exactly the shape the old buggy regexFrom() unpredictably
    // failed to match (its "**/" -> "(?:.*/)?" substitution got corrupted by the
    // following global "*" -> "[^/]*" replace).
    const delta = makeDelta([{ path: "src/lib/security/scanner.ts", changeType: "modified" }]);
    const impact = makeImpactResult({
      changedFiles: [{ file: delta.files[0]!, category: "source", reasons: ["DIRECT_CHANGE"] }],
    });
    const plan = planner.plan({ delta, impact, profile });

    assert.equal(plan.mode, "SELECTIVE");
    const typecheck = plan.tasks.find((t) => t.id === "typecheck");
    assert.equal(typecheck?.status, "RUN", "typecheck should trigger for a nested src/**/*.ts change");
    const lint = plan.tasks.find((t) => t.id === "lint");
    assert.equal(lint?.status, "RUN", "lint should trigger for a nested src/**/*.ts change");
  });

  it("always marks always-run tasks as ALWAYS_RUN even in fallback", () => {
    const profile = makeProfile();
    const delta = makeDelta([{ path: "package.json", changeType: "modified" }]);
    const impact = makeImpactResult({
      fallbackRequired: true,
      fallbackReasons: ["Lockfile changed"],
      changedFiles: [{ file: delta.files[0]!, category: "config", reasons: ["LOCKFILE_GLOBAL"] }],
    });
    const plan = planner.plan({ delta, impact, profile });

    const alwaysRunIds = registry.alwaysRunTasks().map((t) => t.id);
    for (const id of alwaysRunIds) {
      const task = plan.tasks.find((t) => t.id === id);
      assert.equal(task?.status, "ALWAYS_RUN", `expected ${id} to be ALWAYS_RUN`);
    }
    assert.deepEqual(plan.alwaysRunTasks.sort(), alwaysRunIds.sort());
  });

  it("returns no selected tests for empty delta", () => {
    const profile = makeProfile({ tests: ["src/a.test.ts"] });
    const delta = makeDelta([]);
    const impact = makeImpactResult({
      fallbackRequired: false,
      changedFiles: [],
      affectedTests: [],
    });
    const plan = planner.plan({ delta, impact, profile });

    assert.equal(plan.mode, "SELECTIVE");
    assert.deepEqual(plan.selectedTests, []);
    assert.deepEqual(plan.skippedTests, ["src/a.test.ts"]);
  });

  it("triggers infrastructure and database-related tasks on matching changes", () => {
    const profile = makeProfile();
    const delta = makeDelta([
      { path: "ops/aws/vpc.tf", changeType: "modified" },
      { path: "database/migrations/001.sql", changeType: "added" },
    ]);
    const impact = makeImpactResult({
      fallbackRequired: true,
      fallbackReasons: ["Infrastructure", "Database"],
      changedFiles: [
        { file: delta.files[0]!, category: "infrastructure", reasons: ["INFRASTRUCTURE_GLOBAL"] },
        { file: delta.files[1]!, category: "database", reasons: ["DATABASE_GLOBAL"] },
      ],
    });
    const plan = planner.plan({ delta, impact, profile });

    const ops = plan.tasks.find((t) => t.id === "test:ops");
    const migration = plan.tasks.find((t) => t.id === "check:migrations");
    assert.equal(ops?.status, "FULL_FALLBACK");
    assert.equal(migration?.status, "ALWAYS_RUN");
  });

  it("emits deterministic task ordering and serialization", () => {
    const profile = makeProfile();
    const delta = makeDelta([{ path: "src/lib/auth.ts", changeType: "modified" }]);
    const impact = makeImpactResult({
      affectedTests: [{ path: "src/lib/auth.test.ts", reasons: ["DEPENDENCY"], evidence: [] }],
      changedFiles: [{ file: delta.files[0]!, category: "source", reasons: ["DIRECT_CHANGE"] }],
    });

    const plan1 = planner.plan({ delta, impact, profile });
    const plan2 = planner.plan({ delta, impact, profile });
    assert.equal(JSON.stringify(plan1), JSON.stringify(plan2));
    assert.deepEqual(
      plan1.tasks.map((t) => t.id),
      plan2.tasks.map((t) => t.id),
    );
  });

});
