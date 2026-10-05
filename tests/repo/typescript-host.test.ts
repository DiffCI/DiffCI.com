import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { createGraphCompilerHost } from "../../scripts/lib/typescript-host-candidate.js";
import { createMeasuredGraphCompilerHost } from "../../src/repo/typescript-host.js";

test("graph host preserves implementation ASTs and all file/type/lib reference traversal", () => {
  const root = mkdtempSync(join(tmpdir(), "diffci-ts-host-"));
  try {
    const files: Record<string, string> = {
      "entry.ts": '/// <reference lib="es2022" />\n/// <reference types="fixture" />\n/// <reference path="ambient.d.ts" />\nimport { a } from "./alias"; export const entry = a;',
      "alias.ts": 'export { a } from "./generated/outside-include";',
      "ambient.d.ts": 'import "./ambient-dependency"; declare global { const fixture: number; }',
      "ambient-dependency.ts": 'export const dependency = 1;',
      "generated/outside-include.ts": 'export const a = 42;',
      "types/fixture/index.d.ts": 'import "../../type-dependency"; export {};',
      "types/fixture/package.json": '{"name":"fixture","types":"index.d.ts"}',
      "type-dependency.d.ts": 'export declare const typeDependency: number;',
    };
    for (const [name, contents] of Object.entries(files)) {
      mkdirSync(dirname(join(root, name)), { recursive: true }); writeFileSync(join(root, name), contents);
    }
    const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler, typeRoots: [join(root, "types")], types: ["fixture"] };
    const standard = ts.createProgram([join(root, "entry.ts")], options);
    const optimized = ts.createProgram({ rootNames: [join(root, "entry.ts")], options, host: createGraphCompilerHost(options) });
    const measuredHost = createMeasuredGraphCompilerHost(options);
    const measured = ts.createProgram({ rootNames: [join(root, "entry.ts")], options, host: measuredHost.host });
    const list = (program: ts.Program) => program.getSourceFiles().map((file) => file.fileName).sort();
    assert.deepEqual(list(optimized), list(standard));
    assert.deepEqual(list(measured), list(standard));
    for (const original of standard.getSourceFiles()) {
      assert.equal(measured.getSourceFile(original.fileName)!.text, original.text);
      const file = optimized.getSourceFile(original.fileName)!;
      assert.deepEqual(file.referencedFiles, original.referencedFiles);
      assert.deepEqual(file.typeReferenceDirectives, original.typeReferenceDirectives);
      assert.deepEqual(file.libReferenceDirectives, original.libReferenceDirectives);
      assert.equal(file.hasNoDefaultLib, original.hasNoDefaultLib);
      if (realpathSync.native(original.fileName).startsWith(realpathSync.native(root))) {
        assert.equal(file.text, original.text);
        assert.deepEqual(file.statements.map((statement) => statement.getText(file)), original.statements.map((statement) => statement.getText(original)));
      }
    }
    for (const name of ["generated/outside-include.ts", "ambient-dependency.ts", "types/fixture/index.d.ts", "type-dependency.d.ts"])
      assert.ok(optimized.getSourceFiles().some((file) => realpathSync.native(file.fileName) === realpathSync.native(join(root, name))), `missing transitive input ${name}`);
    assert.equal(optimized.getSourceFile(ts.getDefaultLibFilePath(options))!.statements.length, 0);
    assert.ok(measuredHost.metrics.bundledLibraryLoads > 0);
    assert.ok(measuredHost.metrics.otherDeclarationLoads > 0);
    assert.ok(measuredHost.metrics.implementationLoads > 0);
    assert.equal(measuredHost.metrics.failedSourceFileLoads, 0);
    assert.equal(measuredHost.metrics.sourceFileLoads, measuredHost.metrics.bundledLibraryLoads + measuredHost.metrics.otherDeclarationLoads + measuredHost.metrics.implementationLoads);
    assert.ok(Object.values(measuredHost.metrics).every((value) => Number.isFinite(value) && value >= 0));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("patched bundled libraries containing imports keep their original AST", () => {
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022 };
  const host = createGraphCompilerHost(options);
  const library = ts.getDefaultLibFilePath(options);
  const read = host.readFile;
  const patched = 'import type { Something } from "./local-module"; export interface Custom extends Something {}';
  host.readFile = (name) => name === library ? patched : read(name);
  const file = host.getSourceFile(library, ts.ScriptTarget.ES2022)!;
  assert.equal(file.text, patched);
  assert.ok(file.statements.some(ts.isImportDeclaration));
});

test("replacement libraries outside the compiler installation keep declarations and imports", () => {
  const root = mkdtempSync(join(tmpdir(), "diffci-ts-replacement-"));
  try {
    const path = join(root, "lib.dom.d.ts");
    const contents = 'import "./custom-dependency"; declare const customLibrary: number;';
    writeFileSync(path, contents);
    const file = createGraphCompilerHost({}).getSourceFile(path, ts.ScriptTarget.ES2022)!;
    assert.equal(file.text, contents); assert.equal(file.statements.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
