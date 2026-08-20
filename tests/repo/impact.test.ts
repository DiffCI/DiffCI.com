import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { ImpactAnalyzer } from "../../src/repo/impact.js";
import type { DependencyGraph, DependencyGraphNode, DependencyGraphResult, RepositoryProfile } from "../../src/repo/types.js";
import type { ChangedFile, GitDelta, GitDeltaSummary } from "../../src/git/types.js";

function makeNodes(paths: string[]): DependencyGraphNode[] {
  return paths.map((p) => ({
    path: p,
    isSource: /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p),
    isAsset: !/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(p),
    isTest: /\.(test|spec)\./.test(p),
    isEntryPoint: /\/(page|layout|route|api)\.(tsx|ts|jsx|js)$/.test(p),
  }));
}

function makeGraph(paths: string[], edges: Array<[string, string]>): DependencyGraph {
  const nodes = makeNodes(paths);
  const forward: Record<string, string[]> = {};
  const reverse: Record<string, string[]> = {};
  for (const [from, to] of edges) {
    (forward[from] ??= []).push(to);
    (reverse[to] ??= []).push(from);
  }
  const adj = (map: Record<string, string[]>, p: string, visited: Set<string>, result: string[]) => {
    if (visited.has(p)) return;
    visited.add(p);
    for (const next of map[p] ?? []) {
      if (!result.includes(next)) result.push(next);
      adj(map, next, visited, result);
    }
  };
  const collect = (map: Record<string, string[]>, p: string) => {
    const result: string[] = [];
    adj(map, p, new Set(), result);
    return result;
  };
  return {
    nodes,
    edges: edges.map(([from, to]) => ({ from, to, kind: "import" as const })),
    forward,
    reverse,
    dependenciesOf: (p) => collect(forward, p),
    dependentsOf: (p) => collect(reverse, p),
    transitiveDependenciesOf: (p) => collect(forward, p),
    transitiveDependentsOf: (p) => collect(reverse, p),
  };
}

function makeDependencyGraphResult(graph: DependencyGraph, confidence: DependencyGraphResult["confidence"] = "COMPLETE"): DependencyGraphResult {
  return {
    graph,
    profile: makeProfile(),
    unresolved: [],
    references: [],
    counts: { internalSource: 0, internalAsset: 0, externalPackage: 0, platformBuiltin: 0, unresolved: 0 },
    externalReferences: 0,
    platformBuiltinReferences: 0,
    internalAssetEdges: 0,
    performance: { durationMs: 0, filesDiscovered: graph.nodes.length, filesParsed: graph.nodes.length },
    confidence,
    integrity: { findings: [], criticalCount: 0, warningCount: 0, stats: { nodeCount: graph.nodes.length, sourceNodeCount: 0, assetNodeCount: 0, edgeCount: graph.edges.length, assetEdgeCount: 0 } },
    resolvedViaProjectReferences: false,
  };
}

function makeProfile(options: { next?: boolean; entryPoints?: string[]; tests?: string[] } = {}): RepositoryProfile {
  const nextConfig = options.next ? { exists: true, file: "next.config.ts" } : { exists: false };
  const entryPoints = (options.entryPoints ?? []).map((p) => ({ path: p, kind: /layout\.(tsx|ts|jsx|js)$/.test(p) ? ("next-layout" as const) : /api\//.test(p) ? ("next-api" as const) : ("next-page" as const) }));
  const testGlobs = options.tests ?? ["src/**/*.test.ts"];
  const tests = testGlobs.map((g) => ({ glob: g, count: 1 }));
  return {
    packageManager: "npm",
    packageJson: { name: "test", version: "1.0.0", scripts: {}, dependencies: [], devDependencies: [] },
    sourceRoots: [],
    tests,
    testFilePaths: [],
    workflows: [],
    configFiles: [],
    pathAliases: [],
    entryPoints,
    nextConfig,
    stats: { sourceFiles: 0, testFiles: 0, workflowFiles: 0, configFiles: 0 },
  };
}

function makeDelta(base: string, head: string, files: ChangedFile[], analysis: Partial<GitDelta["analysis"]>, summary: Partial<GitDeltaSummary> = {}): GitDelta {
  const fullSummary = { added: 0, modified: 0, deleted: 0, renamed: 0, copied: 0, unmerged: 0, unknown: 0, total: files.length, ...summary };
  const fullAnalysis = {
    empty: files.length === 0,
    configChanged: false,
    dependencyManifestChanged: false,
    lockfileChanged: false,
    workflowChanged: false,
    infrastructureChanged: false,
    databaseChanged: false,
    ...analysis,
  };
  return { baseSha: base, headSha: head, files, directories: [], summary: fullSummary, analysis: fullAnalysis };
}

const analyzer = new ImpactAnalyzer([]);

describe("ImpactAnalyzer synthetic cases", () => {

  it("A: pure source change selects dependent test", () => {
    const graph = makeGraph(
      ["src/lib/util.ts", "src/app/page.tsx", "src/lib/util.test.ts"],
      [
        ["src/app/page.tsx", "src/lib/util.ts"],
        ["src/lib/util.test.ts", "src/lib/util.ts"],
      ],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/page.tsx"] });
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.ts", changeType: "modified" }], {});
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedSourceFiles.sort(), ["src/app/page.tsx", "src/lib/util.ts"]);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/lib/util.test.ts"]);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path), ["src/app/page.tsx"]);
  });

  it("B: asset change reaches source, entry point, and test", () => {
    const graph = makeGraph(
      ["src/styles.module.css", "src/app/page.tsx", "src/app/page.test.tsx"],
      [
        ["src/app/page.tsx", "src/styles.module.css"],
        ["src/app/page.test.tsx", "src/app/page.tsx"],
      ],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/page.tsx"] });
    const delta = makeDelta("base", "head", [{ path: "src/styles.module.css", changeType: "modified" }], {});
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedAssets, ["src/styles.module.css"]);
    assert.deepStrictEqual(result.affectedSourceFiles.sort(), ["src/app/page.tsx"]);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path), ["src/app/page.test.tsx"]);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path), ["src/app/page.tsx"]);
  });

  it("C: Next.js layout change impacts descendant entry points", () => {
    const graph = makeGraph(
      ["src/app/layout.tsx", "src/app/page.tsx", "src/app/blog/page.tsx", "src/app/blog/post/page.tsx"],
      [],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/layout.tsx", "src/app/page.tsx", "src/app/blog/page.tsx", "src/app/blog/post/page.tsx"] });
    const delta = makeDelta("base", "head", [{ path: "src/app/layout.tsx", changeType: "modified" }], {});
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path).sort(), [
      "src/app/blog/page.tsx",
      "src/app/blog/post/page.tsx",
      "src/app/layout.tsx",
      "src/app/page.tsx",
    ]);
    assert.ok(result.evidence.some((e) => e.reason === "NEXT_LAYOUT_ANCESTOR"));
  });

  it("D: added entry point is flagged", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile({ next: true, entryPoints: [] });
    const delta = makeDelta("base", "head", [{ path: "src/app/page.tsx", changeType: "added" }], {}, { added: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedEntryPoints.map((e) => e.path), ["src/app/page.tsx"]);
    assert.ok(result.evidence.some((e) => e.reason === "NEW_ENTRY_POINT"));
  });

  it("E: config change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "package.json", changeType: "modified" }], { configChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "CONFIG_GLOBAL"));
  });

  it("F: deleted source not in graph falls back", () => {
    const graph = makeGraph(["src/lib/other.ts"], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/deleted.ts", changeType: "deleted" }], {}, { deleted: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "DELETED_FILE_UNKNOWABLE_GRAPH"));
  });

  it("G: graph confidence UNSAFE falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.ts", changeType: "modified" }], {}, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph, "UNSAFE"), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "GRAPH_CONFIDENCE_UNSAFE"));
  });

  it("H: empty delta is safe with no affected files", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [], { empty: true });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedTests, []);
    assert.deepStrictEqual(result.affectedEntryPoints, []);
    assert.ok(result.riskSignals.some((s) => s.reason === "EMPTY_DELTA"));
  });

  it("I: unknown file falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "src/weird.unknown", changeType: "modified" }], {}, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "UNKNOWN_FILE"));
  });

  it("J: infrastructure change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "ops/main.tf", changeType: "modified" }], { infrastructureChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "INFRASTRUCTURE_GLOBAL"));
  });

  it("K: database change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "database/migrations/001.sql", changeType: "modified" }], { databaseChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "DATABASE_GLOBAL"));
  });

  it("L: lockfile change falls back", () => {
    const graph = makeGraph([], []);
    const profile = makeProfile();
    const delta = makeDelta("base", "head", [{ path: "package-lock.json", changeType: "modified" }], { lockfileChanged: true }, { modified: 1 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, true);
    assert.ok(result.riskSignals.some((s) => s.reason === "LOCKFILE_GLOBAL"));
  });

  it("M: multiple changes union", () => {
    const graph = makeGraph(
      ["src/lib/util.ts", "src/app/page.tsx", "src/lib/util.test.ts", "src/styles.module.css", "src/app/page.test.tsx"],
      [
        ["src/app/page.tsx", "src/lib/util.ts"],
        ["src/lib/util.test.ts", "src/lib/util.ts"],
        ["src/app/page.tsx", "src/styles.module.css"],
        ["src/app/page.test.tsx", "src/app/page.tsx"],
      ],
    );
    const profile = makeProfile({ next: true, entryPoints: ["src/app/page.tsx"] });
    const delta = makeDelta("base", "head", [
      { path: "src/lib/util.ts", changeType: "modified" },
      { path: "src/styles.module.css", changeType: "modified" },
    ], {}, { modified: 2 });
    const result = analyzer.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.deepStrictEqual(result.affectedSourceFiles.sort(), ["src/app/page.tsx", "src/lib/util.ts"]);
    assert.deepStrictEqual(result.affectedTests.map((t) => t.path).sort(), ["src/app/page.test.tsx", "src/lib/util.test.ts"]);
  });

  it("N: always-run security tests are included", () => {
    const graph = makeGraph(["scripts/test-security.js", "src/lib/util.ts"], [["scripts/test-security.js", "src/lib/util.ts"]]);
    const profile = makeProfile({ tests: ["src/**/*.test.ts", "scripts/*.js"] });
    const custom = new ImpactAnalyzer([
      { name: "security", reason: "ALWAYS_RUN_POLICY", patterns: [/test-security\.js$/] },
    ]);
    const delta = makeDelta("base", "head", [{ path: "src/lib/util.ts", changeType: "modified" }], {}, { modified: 1 });
    const result = custom.analyze(delta, makeDependencyGraphResult(graph), profile);
    assert.strictEqual(result.fallbackRequired, false);
    assert.ok(result.affectedTests.some((t) => t.path === "scripts/test-security.js"));
  });
});

