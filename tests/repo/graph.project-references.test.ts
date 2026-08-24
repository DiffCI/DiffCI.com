import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";

// Regression coverage for the "solution style" tsconfig bug found during the Stage 0
// real pilot (2026-08-19, honojs/hono): a root tsconfig.json with `"files": []` and
// `"references": [...]` parses to zero root file names via
// ts.parseJsonConfigFileContent (references are not expanded), which previously produced
// a silently empty dependency graph that computeConfidence() still reported as "COMPLETE".

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
}

describe("buildDependencyGraph project references", () => {
  it("resolves referenced sub-projects instead of producing a silently empty graph", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-project-refs-"));
    try {
      writeJson(join(dir, "package.json"), { name: "solution-fixture", version: "1.0.0" });

      // Root tsconfig: solution-style shell, no files of its own.
      writeJson(join(dir, "tsconfig.json"), {
        files: [],
        references: [{ path: "./tsconfig.build.json" }],
      });

      // Referenced project actually contains the real source files.
      writeJson(join(dir, "tsconfig.build.json"), {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      });

      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/a.ts"), "import { b } from './b';\nexport const a = b + 1;\n");
      writeFileSync(join(dir, "src/b.ts"), "export const b = 1;\n");

      const result = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });

      assert.ok(result.graph.nodes.length > 0, "graph should not be empty when referenced project has real files");
      assert.ok(
        result.graph.nodes.some((n) => n.path === "src/a.ts") && result.graph.nodes.some((n) => n.path === "src/b.ts"),
        "referenced project's actual files should be present as graph nodes",
      );
      assert.deepStrictEqual(result.graph.dependenciesOf("src/a.ts"), ["src/b.ts"]);

      // Must never claim full COMPLETE confidence for a merged/approximated resolution —
      // that was the dangerous part of the original bug (confidently wrong).
      assert.notStrictEqual(result.confidence, "COMPLETE");
      assert.strictEqual(result.confidence, "PARTIAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports UNSAFE (not COMPLETE) when a tsconfig genuinely resolves to zero source files", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-empty-tsconfig-"));
    try {
      writeJson(join(dir, "package.json"), { name: "empty-fixture", version: "1.0.0" });
      // No references, no files, no include — genuinely nothing for the compiler to see.
      writeJson(join(dir, "tsconfig.json"), { files: [] });

      const result = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });

      assert.strictEqual(result.graph.nodes.length, 0);
      assert.strictEqual(result.confidence, "UNSAFE", "an empty graph must never be reported as COMPLETE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("buildDependencyGraph nested tsconfig discovery (no root tsconfig.json)", () => {
  // Regression coverage for the 2026-08-24 blind-baseline "tsconfig crash" finding: biomejs/biome and
  // calcom/cal.diy (and many real monorepos) have per-package `tsconfig.json` files but none at the repo
  // root. ts.findConfigFile() walks UP from the root, never DOWN, so createProgram() used to throw
  // "No tsconfig.json found" and crash the whole analysis. It must now discover the nested per-package
  // tsconfigs, build the graph from their real source files, and - because merging multiple sub-projects'
  // compiler options is a best-effort approximation - cap confidence at PARTIAL, never COMPLETE.

  it("discovers nested per-package tsconfigs and builds a graph (confidence PARTIAL)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-nested-tsconfig-"));
    try {
      writeJson(join(dir, "package.json"), { name: "monorepo-fixture", version: "1.0.0" });
      // Deliberately NO root tsconfig.json.

      writeJson(join(dir, "packages/a/tsconfig.json"), {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          allowImportingTsExtensions: true,
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      });

      mkdirSync(join(dir, "packages/a/src"), { recursive: true });
      writeFileSync(join(dir, "packages/a/src/a.ts"), "import { b } from './b';\nexport const a = b + 1;\n");
      writeFileSync(join(dir, "packages/a/src/b.ts"), "export const b = 1;\n");

      const result = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });

      assert.ok(result.graph.nodes.length > 0, "graph should not be empty when nested packages have real files");
      assert.ok(
        result.graph.nodes.some((n) => n.path === "packages/a/src/a.ts") &&
          result.graph.nodes.some((n) => n.path === "packages/a/src/b.ts"),
        "nested package's actual files should be present as graph nodes",
      );
      assert.deepStrictEqual(result.graph.dependenciesOf("packages/a/src/a.ts"), ["packages/a/src/b.ts"]);

      // Must never claim COMPLETE confidence for merged/approximated multi-project resolution.
      assert.strictEqual(result.confidence, "PARTIAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("merges multiple nested packages and resolves cross-package imports", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-nested-multi-"));
    try {
      writeJson(join(dir, "package.json"), { name: "monorepo-fixture", version: "1.0.0" });
      // No root tsconfig.json.

      writeJson(join(dir, "packages/lib/tsconfig.json"), {
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true },
        include: ["src/**/*.ts"],
      });
      writeJson(join(dir, "packages/app/tsconfig.json"), {
        compilerOptions: { target: "ES2022", module: "ESNext", moduleResolution: "Bundler", noEmit: true },
        include: ["src/**/*.ts"],
      });

      mkdirSync(join(dir, "packages/lib/src"), { recursive: true });
      mkdirSync(join(dir, "packages/app/src"), { recursive: true });
      writeFileSync(join(dir, "packages/lib/src/util.ts"), "export const util = 42;\n");
      writeFileSync(join(dir, "packages/app/src/main.ts"), "import { util } from '../../lib/src/util';\nexport const out = util;\n");

      const result = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });

      assert.ok(result.graph.nodes.some((n) => n.path === "packages/lib/src/util.ts"));
      assert.ok(result.graph.nodes.some((n) => n.path === "packages/app/src/main.ts"));
      assert.deepStrictEqual(
        result.graph.dependenciesOf("packages/app/src/main.ts"),
        ["packages/lib/src/util.ts"],
        "cross-package import should resolve across nested projects",
      );
      assert.strictEqual(result.confidence, "PARTIAL");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns UNSAFE (does not throw) when there is no tsconfig.json anywhere in the repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-no-tsconfig-"));
    try {
      writeJson(join(dir, "package.json"), { name: "plain-fixture", version: "1.0.0" });
      // A .ts source file exists, but no tsconfig.json anywhere - the exact shape that used to throw
      // "No tsconfig.json found" and crash the whole analysis.
      mkdirSync(join(dir, "src"), { recursive: true });
      writeFileSync(join(dir, "src/index.ts"), "export const x = 1;\n");

      // Must NOT throw - it should degrade to an empty graph reported UNSAFE.
      const result = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });

      assert.strictEqual(result.graph.nodes.length, 0);
      assert.strictEqual(result.confidence, "UNSAFE", "no-tsconfig repo must degrade to UNSAFE, never crash");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not descend into node_modules when discovering nested tsconfigs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diffci-nested-ignored-"));
    try {
      writeJson(join(dir, "package.json"), { name: "monorepo-fixture", version: "1.0.0" });
      // No root tsconfig.json. A node_modules tsconfig must be ignored, otherwise its files would leak in.
      writeJson(join(dir, "node_modules/some-dep/tsconfig.json"), {
        compilerOptions: { target: "ES2022", noEmit: true },
        include: ["src/**/*.ts"],
      });
      mkdirSync(join(dir, "node_modules/some-dep/src"), { recursive: true });
      writeFileSync(join(dir, "node_modules/some-dep/src/junk.ts"), "export const junk = 1;\n");

      const result = await buildDependencyGraph({ repoPath: dir, excludeDirs: ["node_modules"] });

      assert.strictEqual(result.graph.nodes.length, 0, "node_modules tsconfig must be ignored");
      assert.strictEqual(result.confidence, "UNSAFE");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
