// Experimental benchmark arm only; never installed as the production graph host.
import { basename, dirname, relative, resolve } from "node:path";
import ts from "typescript";

export function createGraphCompilerHost(options: ts.CompilerOptions): ts.CompilerHost {
  const host = ts.createCompilerHost(options);
  const original = host.getSourceFile;
  const libraryDirectory = dirname(ts.getDefaultLibFilePath(options));
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreateNewSourceFile) => {
    const libraryName = relative(libraryDirectory, resolve(fileName));
    if (libraryName !== basename(libraryName) || !/^lib(?:\.[\w.-]+)?\.d\.ts$/.test(libraryName))
      return original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const contents = host.readFile(fileName);
    if (contents === undefined) return original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const directives = ts.preProcessFile(contents, true, true);
    if (directives.importedFiles.length || directives.ambientExternalModules?.length)
      return original(fileName, languageVersion, onError, shouldCreateNewSourceFile);
    const source = ts.createSourceFile(fileName, "", languageVersion);
    source.referencedFiles = directives.referencedFiles;
    source.typeReferenceDirectives = directives.typeReferenceDirectives;
    source.libReferenceDirectives = directives.libReferenceDirectives;
    source.hasNoDefaultLib = directives.isLibFile;
    return source;
  };
  return host;
}
