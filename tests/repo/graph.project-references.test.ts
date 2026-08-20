import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { buildDependencyGraph } from "../../src/repo/graph.js";

// Regression coverage for the "solution style" tsconfig bug found during the Stage 0
// real pilot (2026-08-19, honojs/hono): a root tsconfig.json with `"files": []` and
// `"references": [...]` parses to zero root file names via
// ts.parseJsonConfigFileContent (references are not expanded), which previously produced
// a silently empty dependency graph that computeConfidence() still reported as "COMPLETE".

function writeJson(path: string, value: unknown): void {
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
