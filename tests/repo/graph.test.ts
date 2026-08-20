import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import {
  buildDependencyGraph,
  graphToJson,
  refineConfidenceForDelta,
  validateDependencyGraph,
} from "../../src/repo/graph.js";

interface FixtureFiles {
  [path: string]: string;
}

function createTempRepo(files: FixtureFiles): string {
  const dir = mkdtempSync(join(tmpdir(), "diffci-repo-"));
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture", version: "1.0.0" }),
  );
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "Bundler",
        baseUrl: ".",
        paths: {
          "@/*": ["./src/*"],
        },
        allowImportingTsExtensions: true,
        noEmit: true,
      },
      include: ["**/*.ts"],
    }),
  );

  for (const [relativePath, content] of Object.entries(files)) {
    const full = join(dir, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  return dir;
}

async function buildFixture(files: FixtureFiles) {
  const repoPath = createTempRepo(files);
  return buildDependencyGraph({ repoPath, excludeDirs: ["node_modules"] });
}

function nodePaths(result: Awaited<ReturnType<typeof buildFixture>>, file: string) {
  const graph = result.graph;
  return {
    dependencies: () => graph.dependenciesOf(file),
    dependents: () => graph.dependentsOf(file),
    transitiveDependents: () => graph.transitiveDependentsOf(file),
    transitiveDependencies: () => graph.transitiveDependenciesOf(file),
  };
}

describe("DependencyGraph fixtures", () => {
  it("direct dependency", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "export const b = 1;\n",
    });
    assert.strictEqual(result.confidence, "COMPLETE");

    const a = nodePaths(result, "src/A.ts");
    assert.deepStrictEqual(a.dependencies(), ["src/B.ts"]);

    const b = nodePaths(result, "src/B.ts");
    assert.deepStrictEqual(b.dependents(), ["src/A.ts"]);
  });

  it("transitive dependency", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    assert.deepStrictEqual(nodePaths(result, "src/A.ts").transitiveDependencies(), [
      "src/B.ts",
      "src/C.ts",
    ]);
    assert.deepStrictEqual(nodePaths(result, "src/C.ts").transitiveDependents(), [
      "src/A.ts",
      "src/B.ts",
    ]);
  });

  it("diamond dependency", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B'; import { c } from './C';\n",
      "src/B.ts": "import { d } from './D';\n",
      "src/C.ts": "import { d } from './D';\n",
      "src/D.ts": "export const d = 1;\n",
    });

    const d = nodePaths(result, "src/D.ts");
    assert.deepStrictEqual(d.transitiveDependents().sort(), [
      "src/A.ts",
      "src/B.ts",
      "src/C.ts",
    ]);

    const a = nodePaths(result, "src/A.ts");
    assert.deepStrictEqual(a.transitiveDependencies().sort(), [
      "src/B.ts",
      "src/C.ts",
      "src/D.ts",
    ]);
  });

  it("handles cycles without infinite looping", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "import { a } from './A';\n",
    });

    const a = nodePaths(result, "src/A.ts");
    const transitive = a.transitiveDependencies();
    assert.equal(transitive.includes("src/B.ts"), true);
    assert.equal(transitive.includes("src/C.ts"), true);
    assert.equal(transitive.length, 2);
  });

  it("barrel re-export propagates reverse dependencies", async () => {
    const result = await buildFixture({
      "src/Consumer.ts": "import { Button } from './components';\n",
      "src/components/index.ts": "export { Button } from './Button';\n",
      "src/components/Button.ts": "export function Button() {}\n",
    });

    assert.deepStrictEqual(nodePaths(result, "src/components/index.ts").dependents(), [
      "src/Consumer.ts",
    ]);

    assert.deepStrictEqual(
      nodePaths(result, "src/components/Button.ts").transitiveDependents(),
      ["src/Consumer.ts", "src/components/index.ts"],
    );
  });

  it("export star propagates through barrel", async () => {
    const result = await buildFixture({
      "src/Consumer.ts": "import { Button } from './components';\n",
      "src/components/index.ts": "export * from './Button';\n",
      "src/components/Button.ts": "export function Button() {}\n",
    });

    assert.deepStrictEqual(
      nodePaths(result, "src/components/Button.ts").transitiveDependents(),
      ["src/Consumer.ts", "src/components/index.ts"],
    );
  });

  it("resolves tsconfig path aliases", async () => {
    const result = await buildFixture({
      "src/app.ts": "import { foo } from '@/lib/foo';\n",
      "src/lib/foo.ts": "export const foo = 1;\n",
    });

    assert.deepStrictEqual(nodePaths(result, "src/app.ts").dependencies(), [
      "src/lib/foo.ts",
    ]);
    assert.deepStrictEqual(nodePaths(result, "src/lib/foo.ts").dependents(), [
      "src/app.ts",
    ]);
  });

  it("creates edges for dynamic literal imports", async () => {
    const result = await buildFixture({
      "src/A.ts": "export async function load() { const m = await import('./module'); return m; }\n",
      "src/module.ts": "export const value = 1;\n",
    });

    const edge = result.graph.edges.find(
      (e) => e.from === "src/A.ts" && e.to === "src/module.ts",
    );
    assert.ok(edge);
    assert.strictEqual(edge!.kind, "dynamic-import");
    assert.strictEqual(result.confidence, "COMPLETE");
  });

  it("records dynamic computed imports as unresolved", async () => {
    const result = await buildFixture({
      "src/A.ts": "export async function load(name: string) { return import(`./${name}`); }\n",
    });

    assert.strictEqual(result.confidence, "UNSAFE");
    const unresolved = result.unresolved.find(
      (u) => u.specifier.includes("${name}") || u.specifier.includes("__computed"),
    );
    assert.ok(unresolved);
    assert.strictEqual(unresolved!.dynamic, true);
  });

  it("records missing internal modules as unresolved", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { x } from './missing';\n",
    });

    assert.strictEqual(result.confidence, "UNSAFE");
    const unresolved = result.unresolved.find((u) => u.specifier === "./missing");
    assert.ok(unresolved);
    assert.strictEqual(unresolved!.dynamic, false);
  });

  it("classifies type-only imports separately", async () => {
    const result = await buildFixture({
      "src/A.ts": "import type { T } from './types';\n",
      "src/types.ts": "export interface T {}\n",
    });

    const edge = result.graph.edges.find((e) => e.from === "src/A.ts");
    assert.ok(edge);
    assert.strictEqual(edge!.kind, "type-import");
  });

  it("supports CommonJS require with string literals", async () => {
    const result = await buildFixture({
      "src/A.ts": "const b = require('./b');\n",
      "src/b.ts": "export = 1;\n",
    });

    const edge = result.graph.edges.find(
      (e) => e.from === "src/A.ts" && e.to === "src/b.ts",
    );
    assert.ok(edge);
    assert.strictEqual(edge!.kind, "require");
  });

  it("does not treat external packages as internal edges", async () => {
    const result = await buildFixture({
      "src/A.ts": "import React from 'react';\n",
    });

    const edge = result.graph.edges.find((e) => e.from === "src/A.ts");
    assert.strictEqual(edge, undefined);
    const reference = result.references.find(
      (r) => r.specifier === "react" && r.resolution === "external-package",
    );
    assert.ok(reference);
    assert.strictEqual(result.unresolved.length, 0);
  });

  it("produces deterministic JSON output", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    const json1 = JSON.stringify(result.graph);
    const json2 = JSON.stringify(result.graph);
    assert.strictEqual(json1, json2);
  });

  it("safety A: unresolved internal dependencies prevent COMPLETE confidence", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { x } from './missing';\n",
    });
    assert.notStrictEqual(result.confidence, "COMPLETE");
    assert.ok(result.unresolved.length > 0);
  });

  it("safety B: platform built-ins do not reduce confidence", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { readFileSync } from 'node:fs';\n",
    });

    const ref = result.references.find((r) => r.specifier === "node:fs");
    assert.ok(ref);
    assert.strictEqual(ref!.resolution, "platform-builtin");
    assert.strictEqual(result.confidence, "COMPLETE");
  });

  it("safety C: asset imports have reversible reverse-impact edges", async () => {
    const result = await buildFixture({
      "src/A.ts": "import styles from './styles.module.css';\n",
      "src/styles.module.css": ".btn { color: red; }\n",
    });

    const assetEdge = result.graph.edges.find(
      (e) => e.from === "src/A.ts" && e.to === "src/styles.module.css",
    );
    assert.ok(assetEdge);
    assert.strictEqual(assetEdge!.kind, "asset");
    assert.deepStrictEqual(
      result.graph.dependentsOf("src/styles.module.css"),
      ["src/A.ts"],
    );
    assert.strictEqual(result.references.find((r) => r.resolution === "internal-asset")?.resolution, "internal-asset");
  });

  it("safety D: every internal edge has a reverse edge", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\nimport { c } from './C';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    for (const edge of result.graph.edges) {
      assert.ok(
        result.graph.nodes.some((n) => n.path === edge.from),
        `edge from missing node ${edge.from}`,
      );
      assert.ok(
        result.graph.nodes.some((n) => n.path === edge.to),
        `edge to missing node ${edge.to}`,
      );
      const reverse = result.graph.reverse[edge.to];
      assert.ok(
        reverse?.includes(edge.from),
        `missing reverse edge ${edge.to} -> ${edge.from}`,
      );
    }
  });

  it("safety E: traversal terminates on cycles", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { a } from './A';\n",
    });

    const a = nodePaths(result, "src/A.ts");
    const deps = a.transitiveDependencies();
    assert.deepStrictEqual(deps, ["src/B.ts"]);

    const b = nodePaths(result, "src/B.ts");
    assert.deepStrictEqual(b.transitiveDependents(), ["src/A.ts"]);
  });

  it("safety F: graphToJson output is deterministic", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });

    const json1 = graphToJson(result);
    const json2 = graphToJson(result);
    assert.strictEqual(json1, json2);
  });

  it("safety G: missing internal targets are not silently discarded", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { x } from './missing';\n",
    });

    const unresolved = result.unresolved.find((u) => u.specifier === "./missing");
    assert.ok(unresolved);
    assert.strictEqual(unresolved!.importer, "src/A.ts");
  });

  it("safety H: validateDependencyGraph reports no critical findings for consistent graph", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "import { c } from './C';\n",
      "src/C.ts": "export const c = 1;\n",
    });
    const report = validateDependencyGraph(result.graph);
    assert.strictEqual(report.criticalCount, 0);
    assert.strictEqual(report.stats.edgeCount, result.graph.edges.length);
  });
});

// Stage 1B regression tests (2026-08-21, docs/research/2026-08-21-stage1b-*.md): reachability-aware
// per-delta confidence refinement. Real fixtures via buildFixture()/buildDependencyGraph(), not
// hand-rolled DependencyGraphResult mocks - the exact class of fixture/production mismatch that first
// surfaced as a false regression while building this feature (see the commit history) only shows up
// against hand-rolled fixtures, not real graph construction, so these tests deliberately use the real
// pipeline end to end.
describe("refineConfidenceForDelta", () => {
  it("narrows UNSAFE to COMPLETE when the unresolved import is unreachable from the delta's changed files", async () => {
    const result = await buildFixture({
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
      "src/unrelated.ts": "export const z = 1;\n",
    });
    assert.strictEqual(result.confidence, "UNSAFE", "the raw, delta-independent confidence is still UNSAFE");
    assert.strictEqual(refineConfidenceForDelta(result, ["src/unrelated.ts"]), "COMPLETE", "unrelated.ts has no connection to broken.ts in either direction");
  });

  it("keeps UNSAFE when the changed file IS the one with the unresolved import", async () => {
    const result = await buildFixture({
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
      "src/unrelated.ts": "export const z = 1;\n",
    });
    assert.strictEqual(refineConfidenceForDelta(result, ["src/broken.ts"]), "UNSAFE");
  });

  it("keeps UNSAFE when the changed file transitively DEPENDS ON the file with the unresolved import", async () => {
    const result = await buildFixture({
      "src/entry.ts": "import { y } from './broken';\n",
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
    });
    assert.strictEqual(refineConfidenceForDelta(result, ["src/entry.ts"]), "UNSAFE", "entry.ts depends on broken.ts, so its own incompleteness is inherited");
  });

  it("keeps UNSAFE when the changed file is transitively DEPENDED ON BY the file with the unresolved import", async () => {
    const result = await buildFixture({
      "src/shared.ts": "export const s = 1;\n",
      "src/broken.ts": "import { s } from './shared';\nimport { x } from './missing';\n",
    });
    assert.strictEqual(refineConfidenceForDelta(result, ["src/shared.ts"]), "UNSAFE", "broken.ts depends on shared.ts, so changing shared.ts could ripple into the incompletely-understood broken.ts");
  });

  it("passes through a confidence that was never UNSAFE, unchanged, with no narrowing applied", async () => {
    const result = await buildFixture({
      "src/A.ts": "import { b } from './B';\n",
      "src/B.ts": "export const b = 1;\n",
    });
    assert.strictEqual(result.confidence, "COMPLETE");
    assert.strictEqual(refineConfidenceForDelta(result, ["src/A.ts"]), "COMPLETE");
    assert.strictEqual(refineConfidenceForDelta(result, []), "COMPLETE", "even with no changed files at all - nothing to narrow when it was never UNSAFE");
  });

  it("never narrows below PARTIAL when project references were used, even after successful narrowing", async () => {
    // Reuses the exact fixture shape the dedicated project-references test file already establishes
    // produces resolvedViaProjectReferences: true - see graph.project-references.test.ts. This
    // synthesizes the same effect directly on a real, otherwise-UNSAFE result to test the interaction
    // specifically, rather than duplicating that file's full multi-project fixture setup.
    const result = await buildFixture({
      "src/broken.ts": "import { x } from './missing';\nexport const y = 1;\n",
      "src/unrelated.ts": "export const z = 1;\n",
    });
    const withProjectReferences = { ...result, resolvedViaProjectReferences: true };
    assert.strictEqual(refineConfidenceForDelta(withProjectReferences, ["src/unrelated.ts"]), "PARTIAL", "narrowing must respect the project-references cap, not jump straight to COMPLETE");
  });
});

// Stage 1B regression test (2026-08-21, docs/research/2026-08-21-stage1b-*.md): tsconfig-file-scope
// fallback. Root-caused in Stage 1A against the real sindresorhus/execa: reproduces the exact shape
// (tsconfig scoped to declaration-only validation via "files", no "include") against a synthetic
// fixture with real .js source under lib/ - a directory the default source-root convention already
// covers, so this exercises the actual production discovery path end to end, not a mock.
describe("createProgram tsconfig-file-scope fallback", () => {
  it("discovers real .js source when the tsconfig is scoped to declaration-only validation", async () => {
    // Deliberately NO allowJs here, matching the real sindresorhus/execa tsconfig this reproduces - a
    // tsconfig scoped to declaration-only validation was never designed to compile .js at all, so it
    // correctly never sets allowJs itself. The fallback must set it automatically when it fires (see
    // createProgram()'s doc comment) - this test would fail again if that forcing were ever removed.
    const result = await buildFixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", types: ["node"] },
        files: ["index.d.ts"],
      }),
      "index.d.ts": "export declare function run(): void;\n",
      "lib/helper.js": "export function helper() { return 1; }\n",
      "lib/main.js": "import { helper } from './helper.js';\nexport function run() { return helper(); }\n",
    });

    assert.ok(result.profile.stats.sourceFiles > 0, "the fallback must have discovered real .js source, not left the graph empty");
    const helperNode = result.graph.nodes.find((n) => n.path === "lib/helper.js");
    assert.ok(helperNode, "lib/helper.js must be a real graph node");
    assert.deepStrictEqual(result.graph.dependentsOf("lib/helper.js"), ["lib/main.js"], "the real import edge between the two fallback-discovered files must be resolved, not just the files present");
  });

  it("does not trigger the fallback when the tsconfig's file list already includes real source (not scoped to declarations only)", async () => {
    const result = await buildFixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", moduleResolution: "nodenext", allowJs: true },
        files: ["lib/main.js"],
      }),
      "lib/main.js": "export function run() { return 1; }\n",
      "lib/unrelated.js": "export function neverImported() { return 2; }\n",
    });

    // The fallback must not blanket-add every discovered file when the tsconfig already names real
    // source - only lib/main.js (what the tsconfig actually specified) should be a graph node; adding
    // lib/unrelated.js too would silently override a tsconfig that was never actually mis-scoped.
    assert.ok(result.graph.nodes.some((n) => n.path === "lib/main.js"));
    assert.ok(!result.graph.nodes.some((n) => n.path === "lib/unrelated.js"), "the fallback trigger (every fileName is a .d.ts) must not fire here - lib/main.js is real source, not a declaration file");
  });
});