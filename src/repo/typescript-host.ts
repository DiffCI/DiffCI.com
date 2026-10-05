import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";
import type { TypeScriptProgramMetrics } from "./types.js";

/** Measures the original compiler host without changing ASTs, compiler options or resolution. */
export function createMeasuredGraphCompilerHost(options: ts.CompilerOptions) {
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  const libraryDirectory = dirname(ts.getDefaultLibFilePath(options));
  const metrics: TypeScriptProgramMetrics = {
    sourceFileLoads: 0, sourceFileLoadMs: 0, failedSourceFileLoads: 0,
    bundledLibraryLoads: 0, bundledLibraryLoadMs: 0,
    otherDeclarationLoads: 0, otherDeclarationLoadMs: 0,
    implementationLoads: 0, implementationLoadMs: 0,
  };
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const started = performance.now();
    const source = original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const elapsed = performance.now() - started;
    metrics.sourceFileLoads++; metrics.sourceFileLoadMs += elapsed;
    if (!source) metrics.failedSourceFileLoads++;
    else {
      const libraryName = relative(libraryDirectory, resolve(fileName));
      if (libraryName === basename(libraryName) && /^lib(?:\.[\w.-]+)?\.d\.ts$/.test(libraryName)) {
        metrics.bundledLibraryLoads++; metrics.bundledLibraryLoadMs += elapsed;
      } else if (source.isDeclarationFile) {
        metrics.otherDeclarationLoads++; metrics.otherDeclarationLoadMs += elapsed;
      } else {
        metrics.implementationLoads++; metrics.implementationLoadMs += elapsed;
      }
    }
    return source;
  };
  return { host, metrics };
}
