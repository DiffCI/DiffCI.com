import { existsSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { analyzeRepository, type AnalyzeRepositoryOptions } from "./analyzer.js";
import type {
  DependencyEdge,
  DependencyEdgeKind,
  DependencyGraph,
  DependencyGraphNode,
  DependencyGraphResult,
  GraphConfidence,
  GraphIntegrityFinding,
  GraphIntegrityReport,
  GraphPerformanceMetrics,
  ResolutionReference,
  SourceRoot,
  UnresolvedDependency,
} from "./types.js";

interface ImportRef {
  specifier: string;
  kind: DependencyEdgeKind;
  dynamic: boolean;
}

const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);

const ASSET_EXTENSIONS = new Set([
  ".css",
  ".scss",
  ".sass",
  ".less",
  ".json",
  ".jsonc",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".bmp",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".wasm",
  ".md",
  ".txt",
]);

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function isSourceFileName(fileName: string): boolean {
  return SOURCE_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isAssetFileName(fileName: string): boolean {
  return ASSET_EXTENSIONS.has(extname(fileName).toLowerCase());
}

function isNodeBuiltin(specifier: string): boolean {
  return isBuiltin(specifier);
}

function isTestFileName(fileName: string): boolean {
  return /\.(test|spec)\./.test(fileName);
}

function toRelativeInternal(
  repoPath: string,
  absolutePath: string,
): string | undefined {
  const rel = toPosix(normalize(relative(repoPath, absolutePath)));
  if (rel.startsWith("..")) return undefined;
  if (rel === "node_modules" || rel.startsWith("node_modules/")) return undefined;
  return rel;
}

function isExcludedPath(rel: string, excludeDirs: string[]): boolean {
  return excludeDirs.some(
    (dir) => rel === dir || rel.startsWith(`${dir}/`),
  );
}

function extractImportRefs(sourceFile: ts.SourceFile): ImportRef[] {
  const refs: ImportRef[] = [];

  function visit(node: ts.Node) {
    if (ts.isImportDeclaration(node)) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const isTypeOnly = node.importClause?.isTypeOnly ?? false;
        const kind: DependencyEdgeKind = isTypeOnly ? "type-import" : "import";
        refs.push({ specifier: specifier.text, kind, dynamic: false });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const specifier = node.moduleSpecifier;
      if (ts.isStringLiteral(specifier)) {
        const kind: DependencyEdgeKind = node.isTypeOnly ? "type-import" : "re-export";
        refs.push({ specifier: specifier.text, kind, dynamic: false });
      }
    } else if (ts.isCallExpression(node)) {
      const firstArg = node.arguments[0];
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword && firstArg) {
        if (ts.isStringLiteral(firstArg)) {
          refs.push({
            specifier: firstArg.text,
            kind: "dynamic-import",
            dynamic: true,
          });
        } else {
          refs.push({
            specifier: firstArg.getText(sourceFile).slice(0, 200),
            kind: "dynamic-import",
            dynamic: true,
          });
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === "require" &&
        firstArg &&
        ts.isStringLiteral(firstArg)
      ) {
        refs.push({
          specifier: firstArg.text,
          kind: "require",
          dynamic: false,
        });
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return refs;
}

class DependencyGraphImpl implements DependencyGraph {
  readonly nodes: DependencyGraphNode[];
  readonly edges: DependencyEdge[];
  readonly forward: Record<string, string[]> = {};
  readonly reverse: Record<string, string[]> = {};

  constructor(
    sourcePaths: ReadonlySet<string>,
    assetPaths: ReadonlySet<string>,
    edges: DependencyEdge[],
    private repoPath: string,
  ) {
    this.edges = [...edges].sort(DependencyGraphImpl.compareEdges);
    this.nodes = [
      ...Array.from(sourcePaths).map((p) => ({
        path: p,
        isSource: true,
        isAsset: false,
        isTest: isTestFileName(p),
        isEntryPoint: false,
      })),
      ...Array.from(assetPaths).map((p) => ({
        path: p,
        isSource: false,
        isAsset: true,
        assetType: extname(p).toLowerCase(),
        isTest: false,
        isEntryPoint: false,
      })),
    ].sort((a, b) => a.path.localeCompare(b.path));

    for (const node of this.nodes) {
      this.forward[node.path] = [];
      this.reverse[node.path] = [];
    }

    for (const edge of this.edges) {
      if (this.forward[edge.from] !== undefined) {
        this.forward[edge.from]!.push(edge.to);
      }
      if (this.reverse[edge.to] !== undefined) {
        this.reverse[edge.to]!.push(edge.from);
      }
    }

    for (const key of Object.keys(this.forward)) {
      this.forward[key] = [...new Set(this.forward[key]!)].sort();
    }
    for (const key of Object.keys(this.reverse)) {
      this.reverse[key] = [...new Set(this.reverse[key]!)].sort();
    }
  }

  private static compareEdges(a: DependencyEdge, b: DependencyEdge): number {
    return (
      a.from.localeCompare(b.from) ||
      a.to.localeCompare(b.to) ||
      a.kind.localeCompare(b.kind)
    );
  }

  dependenciesOf(filePath: string): string[] {
    const rel = this.normalizeQuery(filePath);
    return this.forward[rel] ?? [];
  }

  dependentsOf(filePath: string): string[] {
    const rel = this.normalizeQuery(filePath);
    return this.reverse[rel] ?? [];
  }

  transitiveDependenciesOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, "forward");
  }

  transitiveDependentsOf(filePath: string): string[] {
    return this.transitiveTraversal(filePath, "reverse");
  }

  private transitiveTraversal(
    filePath: string,
    direction: "forward" | "reverse",
  ): string[] {
    const rel = this.normalizeQuery(filePath);
    const visited = new Set<string>();
    const queue: string[] = [rel];
    const result: string[] = [];
    const adjacency = direction === "forward" ? this.forward : this.reverse;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current)) continue;
      visited.add(current);
      if (current !== rel) result.push(current);
      for (const next of adjacency[current] ?? []) {
        if (!visited.has(next)) queue.push(next);
      }
    }

    return result.sort();
  }

  private normalizeQuery(filePath: string): string {
    const rel = toPosix(normalize(relative(this.repoPath, resolve(this.repoPath, filePath))));
    return rel;
  }
}

export function hydrateDependencyGraph(graph: DependencyGraph, repoPath: string): DependencyGraph {
  const sourcePaths = new Set(graph.nodes.filter((n) => n.isSource).map((n) => n.path));
  const assetPaths = new Set(graph.nodes.filter((n) => n.isAsset).map((n) => n.path));
  return new DependencyGraphImpl(sourcePaths, assetPaths, graph.edges, repoPath);
}

/**
 * TypeScript "solution style" tsconfigs (`"files": [], "references": [...]`) parse to zero
 * root file names via ts.parseJsonConfigFileContent — it does not expand `references` into
 * `fileNames` (that requires solution-build APIs this module doesn't otherwise use). Left
 * unhandled, that produces an empty ts.Program and therefore an empty dependency graph,
 * which computeConfidence() would otherwise happily report as "COMPLETE" (nothing to
 * flag as unresolved when there's nothing to resolve). Recursively resolve each
 * referenced project's own file list and compiler options so the program actually
 * contains the real source files.
 */
function resolveProjectReferenceInputs(
  configPath: string,
  visited: Set<string>,
): { fileNames: string[]; optionsList: ts.CompilerOptions[] } {
  const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
  const normalized = ts.sys.resolvePath ? ts.sys.resolvePath(configPath) : configPath;
  if (visited.has(normalized)) return collected; // guard against reference cycles
  visited.add(normalized);

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error || !config) return collected;

  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(configPath), undefined, configPath);
  collected.fileNames.push(...parsed.fileNames);
  if (parsed.fileNames.length > 0) collected.optionsList.push(parsed.options);

  for (const ref of parsed.projectReferences ?? []) {
    const refConfigPath = ts.resolveProjectReferencePath(ref);
    if (!ts.sys.fileExists(refConfigPath)) continue;
    const nested = resolveProjectReferenceInputs(refConfigPath, visited);
    collected.fileNames.push(...nested.fileNames);
    collected.optionsList.push(...nested.optionsList);
  }

  return collected;
}

const FALLBACK_SCAN_IGNORED_DIRS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", "tmp", "temp"]);
/** Bound on how many files this walk will ever collect, purely as a defensive cap against pathological
 * repos - real source roots are never anywhere close to this in practice. */
const FALLBACK_SCAN_MAX_FILES = 20_000;

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): recursively collects real
 * TS/JS source file paths under the given source-root directories. Used only as a fallback when the
 * repository's own tsconfig scopes the compiler Program to something that excludes real source
 * entirely (see the doc comment on the caller below) - independent of, and not a replacement for, the
 * repo's own tsconfig-driven file discovery. */
function discoverFallbackSourceFiles(repoPath: string, sourceRoots: SourceRoot[]): string[] {
  const found: string[] = [];
  function walk(dirAbs: string): void {
    if (found.length >= FALLBACK_SCAN_MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // root doesn't exist / unreadable - not this function's concern to report, just skip it
    }
    for (const entry of entries) {
      if (found.length >= FALLBACK_SCAN_MAX_FILES) return;
      if (FALLBACK_SCAN_IGNORED_DIRS.has(entry.name)) continue;
      const full = join(dirAbs, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && isSourceFileName(entry.name) && !entry.name.endsWith(".d.ts")) {
        found.push(full);
      }
    }
  }
  for (const root of sourceRoots) walk(join(repoPath, root.path));
  return found;
}

function createProgram(
  repoPath: string,
  fallbackSourceRoots: SourceRoot[] = [],
): {
  program: ts.Program;
  options: ts.CompilerOptions;
  fileNames: readonly string[];
  resolvedViaProjectReferences: boolean;
} {
  const configPath = ts.findConfigFile(repoPath, ts.sys.fileExists, "tsconfig.json");
  if (!configPath) {
    throw new Error(`No tsconfig.json found in ${repoPath}`);
  }

  const { config, error } = ts.readConfigFile(configPath, ts.sys.readFile);
  if (error) {
    throw new Error(ts.flattenDiagnosticMessageText(error.messageText, "\n"));
  }

  const parsed = ts.parseJsonConfigFileContent(
    config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );

  let fileNames: readonly string[] = parsed.fileNames;
  let options = parsed.options;
  let resolvedViaProjectReferences = false;

  if (fileNames.length === 0 && parsed.projectReferences && parsed.projectReferences.length > 0) {
    const visited = new Set<string>([ts.sys.resolvePath ? ts.sys.resolvePath(configPath) : configPath]);
    const collected: { fileNames: string[]; optionsList: ts.CompilerOptions[] } = { fileNames: [], optionsList: [] };
    for (const ref of parsed.projectReferences) {
      const refConfigPath = ts.resolveProjectReferencePath(ref);
      if (!ts.sys.fileExists(refConfigPath)) continue;
      const nested = resolveProjectReferenceInputs(refConfigPath, visited);
      collected.fileNames.push(...nested.fileNames);
      collected.optionsList.push(...nested.optionsList);
    }
    if (collected.fileNames.length > 0) {
      fileNames = Array.from(new Set(collected.fileNames));
      // Best-effort merge: later-referenced projects' options win on conflict. This is an
      // approximation (referenced projects can legitimately have different compiler
      // settings) but is used only for import resolution / AST parsing here, not for type
      // checking, so it is strictly better than the empty-graph status quo.
      options = collected.optionsList.reduce((merged, opts) => ({ ...merged, ...opts }), {} as ts.CompilerOptions);
      resolvedViaProjectReferences = true;
    }
  }

  // Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md), root-caused in Stage 1A
  // (sindresorhus/execa): a real repository's tsconfig can exist and be entirely valid (so the repo is
  // correctly not excluded by the "no tsconfig" rule) yet be scoped ONLY to declaration-file validation
  // via an explicit "files" list with no "include" glob (a genuine, non-niche pattern for ESM-first
  // packages that hand-author both .js source and a separate .d.ts for `tsc`-only type-checking) - the
  // resulting Program never loads any real .js/.ts implementation source at all, producing a graph with
  // (effectively) zero source nodes despite real, testable code existing. Trigger is narrow and
  // specific: the tsconfig's own file list resolved to at least one file, but EVERY one of them is a
  // declaration file - not "the file list is merely small" (a genuinely small, correctly-scoped
  // tsconfig should not be second-guessed). When triggered, independently-discovered source files
  // (analyzer.ts's own glob-based source-root scan, entirely separate from and unaffected by the
  // tsconfig's own file-list scoping) are ADDED to the Program's root files - never replacing what the
  // tsconfig specified, only supplementing it.
  if (fileNames.length > 0 && fileNames.every((f) => f.endsWith(".d.ts")) && fallbackSourceRoots.length > 0) {
    const discovered = discoverFallbackSourceFiles(repoPath, fallbackSourceRoots);
    if (discovered.length > 0) {
      fileNames = Array.from(new Set([...fileNames, ...discovered]));
      // Real-world validation finding (2026-08-21, docs/research/2026-08-21-stage1b-*.md): merely
      // adding discovered .js files to rootNames is not sufficient - a tsconfig scoped to declaration-
      // only validation (this fallback's whole trigger condition) was never designed to compile .js at
      // all, so it correctly never sets allowJs. Without it, TypeScript does not treat the
      // fallback-added .js files as valid program members for AST/import extraction purposes. Only
      // forced on when the fallback itself already fired - never changes behavior for a repo whose
      // tsconfig was never mis-scoped in the first place.
      options = { ...options, allowJs: true };
    }
  }

  const program = ts.createProgram({
    rootNames: fileNames,
    options,
    configFileParsingDiagnostics: parsed.errors,
  });

  return { program, options, fileNames, resolvedViaProjectReferences };
}

function classifySpecifier(specifier: string): "relative" | "absolute" | "alias" | "package" {
  if (specifier.startsWith("`./") || specifier.startsWith("`../")) return "relative";
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("`/")) return "absolute";
  if (specifier.startsWith("/")) return "absolute";
  if (specifier.startsWith("`@/")) return "alias";
  if (specifier.startsWith("@/")) return "alias";
  if (specifier.startsWith("`~/")) return "alias";
  if (specifier.startsWith("~/")) return "alias";
  if (specifier.startsWith("`#")) return "alias";
  if (specifier.startsWith("#")) return "alias";
  return "package";
}

function expandAliasCandidates(
  specifier: string,
  aliases: { pattern: string; substitutions: string[] }[],
  repoPath: string,
): string[] {
  for (const { pattern, substitutions } of aliases) {
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      if (specifier.startsWith(prefix)) {
        const rest = specifier.slice(prefix.length);
        return substitutions.map((sub) => {
          const base = sub.endsWith("/*") ? sub.slice(0, -1) : sub;
          return resolve(repoPath, base, rest);
        });
      }
    } else if (specifier === pattern || specifier.startsWith(`${pattern}/`)) {
      return substitutions.map((sub) => resolve(repoPath, sub));
    }
  }
  return [];
}

function findAssetCandidate(
  importerAbs: string,
  specifier: string,
  aliases: { pattern: string; substitutions: string[] }[],
  repoPath: string,
): string | undefined {
  const candidates: string[] = [];
  if (specifier.startsWith(".")) {
    candidates.push(resolve(dirname(importerAbs), specifier));
  } else if (specifier.startsWith("/")) {
    candidates.push(resolve(repoPath, specifier.slice(1)));
  } else {
    candidates.push(...expandAliasCandidates(specifier, aliases, repoPath));
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

export interface BuildDependencyGraphOptions extends AnalyzeRepositoryOptions {}

export async function buildDependencyGraph(
  options: BuildDependencyGraphOptions = {},
): Promise<DependencyGraphResult> {
  const start = process.hrtime.bigint();
  const repoPath = options.repoPath ? resolve(options.repoPath) : process.cwd();

  const profile = analyzeRepository(options);
  const entryPointPaths = new Set(profile.entryPoints.map((e) => e.path));

  let { program, options: compilerOptions, resolvedViaProjectReferences } = createProgram(repoPath, profile.sourceRoots);
  let moduleResolutionCache = ts.createModuleResolutionCache(
    repoPath,
    (x) => x,
    compilerOptions,
  );

  const sourceFiles = program
    .getSourceFiles()
    .filter((sf) => sf.fileName && !sf.fileName.endsWith(".d.ts"));

  const internalSourcePaths = new Set<string>();

  for (const sf of sourceFiles) {
    const rel = toRelativeInternal(repoPath, sf.fileName);
    if (rel && isSourceFileName(sf.fileName) && !isExcludedPath(rel, options.excludeDirs ?? [])) {
      internalSourcePaths.add(rel);
    }
  }

  const edges: DependencyEdge[] = [];
  const unresolved: UnresolvedDependency[] = [];
  const references: ResolutionReference[] = [];
  const assetPaths = new Set<string>();
  const edgeKeys = new Set<string>();

  function addEdge(from: string, to: string, kind: DependencyEdgeKind): void {
    const key = `${from}|${to}|${kind}`;
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    edges.push({ from, to, kind });
  }

  function recordUnresolved(
    importerRel: string,
    ref: ImportRef,
    reason: string,
  ): void {
    unresolved.push({
      importer: importerRel,
      specifier: ref.specifier,
      reason,
      dynamic: ref.dynamic,
      typeOnly: ref.kind === "type-import",
    });
  }

  function recordReference(
    resolution: ResolutionReference["resolution"],
    importer: string,
    ref: ImportRef,
  ): void {
    references.push({
      resolution,
      specifier: ref.specifier,
      importer,
      kind: ref.kind,
      dynamic: ref.dynamic,
    });
  }

  function recordAssetEdge(importerRel: string, assetRel: string): void {
    assetPaths.add(assetRel);
    addEdge(importerRel, assetRel, "asset");
  }

  const filesParsed = sourceFiles.length;

  for (const sf of sourceFiles) {
    const importerRel = toRelativeInternal(repoPath, sf.fileName);
    if (!importerRel || !isSourceFileName(sf.fileName)) continue;
    if (isExcludedPath(importerRel, options.excludeDirs ?? [])) continue;

    const refs = extractImportRefs(sf);
    for (const ref of refs) {
      if (!ref.specifier) {
        recordUnresolved(importerRel, ref, "empty specifier");
        recordReference("unresolved", importerRel, ref);
        continue;
      }

      if (isNodeBuiltin(ref.specifier)) {
        recordReference("platform-builtin", importerRel, ref);
        continue;
      }

      const resolution = ts.resolveModuleName(
        ref.specifier,
        sf.fileName,
        compilerOptions,
        ts.sys,
        moduleResolutionCache,
      );

      if (!resolution.resolvedModule || !resolution.resolvedModule.resolvedFileName) {
        const category = classifySpecifier(ref.specifier);
        if (category === "relative" || category === "absolute" || category === "alias") {
          const assetAbs = findAssetCandidate(
            sf.fileName,
            ref.specifier,
            profile.pathAliases,
            repoPath,
          );
          if (assetAbs) {
            const assetRel = toRelativeInternal(repoPath, assetAbs);
            if (assetRel) {
              recordAssetEdge(importerRel, assetRel);
              recordReference("internal-asset", importerRel, ref);
              continue;
            }
          }
          recordUnresolved(importerRel, ref, "unresolved internal module");
          recordReference("unresolved", importerRel, ref);
        } else {
          recordReference("external-package", importerRel, ref);
        }
        continue;
      }

      const resolved = resolution.resolvedModule.resolvedFileName;
      const targetRel = toRelativeInternal(repoPath, resolved);

      if (targetRel && isSourceFileName(resolved)) {
        internalSourcePaths.add(targetRel);
        addEdge(importerRel, targetRel, ref.kind);
        recordReference("internal-source", importerRel, ref);
        continue;
      }

      if (targetRel && isAssetFileName(resolved)) {
        recordAssetEdge(importerRel, targetRel);
        recordReference("internal-asset", importerRel, ref);
        continue;
      }

      const category = classifySpecifier(ref.specifier);
      if (category === "relative" || category === "absolute" || category === "alias") {
        const reason = targetRel
          ? "resolved to non-source internal file"
          : "resolved outside repository";
        recordUnresolved(importerRel, ref, reason);
        recordReference("unresolved", importerRel, ref);
      } else {
        recordReference("external-package", importerRel, ref);
      }
    }
  }

  const graph = new DependencyGraphImpl(internalSourcePaths, assetPaths, edges, repoPath);

  for (const node of graph.nodes) {
    node.isEntryPoint = entryPointPaths.has(node.path);
  }

  const heapDuringBuildMb = process.memoryUsage
    ? Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
    : undefined;

  // Release the heavy TypeScript AST / program after graph extraction.
  program = undefined as unknown as ts.Program;
  moduleResolutionCache = undefined as unknown as ts.ModuleResolutionCache;
  if (typeof globalThis.gc === "function") {
    try { globalThis.gc(); } catch { /* ignore */ }
  }

  const heapAfterExtractionMb = process.memoryUsage
    ? Math.round((process.memoryUsage().heapUsed / 1024 / 1024) * 100) / 100
    : undefined;

  profile.stats.sourceFiles = graph.nodes.filter((n) => n.isSource).length;
  profile.stats.testFiles = graph.nodes.filter((n) => n.isTest).length;

  const integrity = validateDependencyGraph(graph);
  const dynamicUnresolvedCount = unresolved.filter((u) => u.dynamic).length;
  const confidence = computeConfidence(
    unresolved.length,
    dynamicUnresolvedCount,
    integrity.criticalCount,
    profile.stats.sourceFiles,
    resolvedViaProjectReferences,
  );

  const internalAssetEdges = edges.filter((e) => e.kind === "asset").length;
  const externalReferences = references.filter((r) => r.resolution === "external-package").length;
  const platformBuiltinReferences = references.filter(
    (r) => r.resolution === "platform-builtin",
  ).length;
  const counts = {
    internalSource: references.filter((r) => r.resolution === "internal-source").length,
    internalAsset: internalAssetEdges,
    externalPackage: externalReferences,
    platformBuiltin: platformBuiltinReferences,
    unresolved: unresolved.length,
  };

  const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;

  const performance: GraphPerformanceMetrics = {
    durationMs,
    heapUsedMb: heapDuringBuildMb,
    heapAfterExtractionMb,
    filesDiscovered: filesParsed,
    filesParsed: filesParsed,
  };

  return {
    graph,
    profile,
    unresolved,
    references,
    counts,
    externalReferences,
    platformBuiltinReferences,
    internalAssetEdges,
    performance,
    confidence,
    integrity,
    resolvedViaProjectReferences,
  };
}

export function validateDependencyGraph(graph: DependencyGraph): GraphIntegrityReport {
  const findings: GraphIntegrityFinding[] = [];
  const nodePaths = new Set(graph.nodes.map((n) => n.path));

  for (const edge of graph.edges) {
    if (!nodePaths.has(edge.from)) {
      findings.push({
        level: "critical",
        message: `Edge from nonexistent node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (!nodePaths.has(edge.to)) {
      findings.push({
        level: "critical",
        message: `Edge to nonexistent node: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from.startsWith("../") || edge.from.includes("/../")) {
      findings.push({
        level: "critical",
        message: `Edge path escapes repository: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.to.startsWith("../") || edge.to.includes("/../")) {
      findings.push({
        level: "critical",
        message: `Edge path escapes repository: ${edge.from} -> ${edge.to}`,
      });
    }
    if (edge.from.includes("\\") || edge.to.includes("\\")) {
      findings.push({
        level: "critical",
        message: `Edge path contains backslash: ${edge.from} -> ${edge.to}`,
      });
    }
  }

  const expectedForward: Record<string, string[]> = {};
  const expectedReverse: Record<string, string[]> = {};
  for (const path of nodePaths) {
    expectedForward[path] = [];
    expectedReverse[path] = [];
  }
  for (const edge of graph.edges) {
    if (expectedForward[edge.from] !== undefined) {
      expectedForward[edge.from].push(edge.to);
    }
    if (expectedReverse[edge.to] !== undefined) {
      expectedReverse[edge.to].push(edge.from);
    }
  }

  for (const path of nodePaths) {
    const expectedF = [...new Set(expectedForward[path])].sort();
    const actualF = graph.forward[path]?.slice().sort() ?? [];
    if (JSON.stringify(expectedF) !== JSON.stringify(actualF)) {
      findings.push({
        level: "critical",
        message: `Forward adjacency mismatch for ${path}`,
      });
    }
    const expectedR = [...new Set(expectedReverse[path])].sort();
    const actualR = graph.reverse[path]?.slice().sort() ?? [];
    if (JSON.stringify(expectedR) !== JSON.stringify(actualR)) {
      findings.push({
        level: "critical",
        message: `Reverse adjacency mismatch for ${path}`,
      });
    }
  }

  const connected = new Set<string>();
  for (const edge of graph.edges) {
    connected.add(edge.from);
    connected.add(edge.to);
  }
  for (const node of graph.nodes) {
    if (!connected.has(node.path) && !node.isEntryPoint) {
      findings.push({
        level: "warning",
        message: `Isolated node: ${node.path}`,
      });
    }
    if (!node.path) {
      findings.push({ level: "critical", message: "Node with empty path" });
    } else if (node.path.includes("\\")) {
      findings.push({
        level: "critical",
        message: `Malformed node path with backslash: ${node.path}`,
      });
    }
  }

  return {
    findings,
    criticalCount: findings.filter((f) => f.level === "critical").length,
    warningCount: findings.filter((f) => f.level === "warning").length,
    stats: {
      nodeCount: graph.nodes.length,
      sourceNodeCount: graph.nodes.filter((n) => n.isSource).length,
      assetNodeCount: graph.nodes.filter((n) => n.isAsset).length,
      edgeCount: graph.edges.length,
      assetEdgeCount: graph.edges.filter((e) => e.kind === "asset").length,
    },
  };
}

function computeConfidence(
  unresolvedCount: number,
  dynamicUnresolvedCount: number,
  integrityCriticalCount: number,
  sourceFileCount: number,
  resolvedViaProjectReferences: boolean,
): GraphConfidence {
  // An empty graph has nothing to flag as unresolved and nothing to violate integrity
  // checks, so without this it would fall through to "COMPLETE" — the worst possible
  // failure mode (confidently wrong rather than honestly unsure). Zero source files means
  // we could not build a trustworthy view of the repository at all.
  if (sourceFileCount === 0) return "UNSAFE";
  if (integrityCriticalCount > 0) return "UNSAFE";
  if (dynamicUnresolvedCount > 0) return "UNSAFE";
  if (unresolvedCount > 0) return "UNSAFE";
  // Project-reference resolution merges multiple sub-projects' compiler options into one
  // best-effort approximation (see resolveProjectReferenceInputs) rather than the exact
  // settings TypeScript itself would use per sub-project, so cap confidence at PARTIAL
  // even when nothing else flagged a problem.
  if (resolvedViaProjectReferences) return "PARTIAL";
  return "COMPLETE";
}

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): per-delta refinement of a graph's
 * raw, delta-independent confidence(). Stage 1A's forensic investigation of all 7 fully-UNSAFE
 * repositories found that in 5 of 7, the unresolved-import count was under 0.1% of total graph edges
 * and confined to files structurally unrelated to the actual library/test surface (a build-tooling
 * script, a non-committed generated fixture, an optional peer-dependency shim) - yet computeConfidence()
 * unconditionally treats ANY unresolved import anywhere in the repository as disqualifying the ENTIRE
 * graph for EVERY delta, for as long as that one file's import stays unresolved, regardless of whether
 * the delta being analyzed has anything to do with it.
 *
 * This narrows that: an unresolved import only makes THIS delta's confidence untrustworthy if the
 * unresolved import's importer file is actually reachable from the delta's changed files (in either
 * direction - the changed file might depend on the incomplete file, or something reachable from the
 * changed file might). If none of the graph's unresolved imports are anywhere near this delta, the
 * graph's real incompleteness elsewhere cannot plausibly affect what can safely be determined about
 * THIS specific change.
 *
 * Deliberately NOT narrowed - these remain hard, global blockers regardless of the delta:
 * - `sourceFileCount === 0` (an empty graph gives no reachability information to reason about at all).
 * - `integrity.criticalCount > 0` (the graph's own internal structure is broken - a construction bug,
 *   not a property of any one file, so no delta-specific narrowing is meaningful).
 * These match computeConfidence()'s own priority order - both are checked before the unresolved-import
 * conditions this function narrows, and are returned as-is, unchanged, before reachability is examined.
 *
 * This function accepts the SAME confidence-relevant fields as computeConfidence() (rather than the
 * bare enum) precisely so a `confidence === "UNSAFE"` return value can be disambiguated: reachability
 * narrowing only applies when unresolved/dynamic-unresolved imports are the actual reason, never when
 * sourceFileCount or integrity triggered it. */
export function refineConfidenceForDelta(result: DependencyGraphResult, changedFiles: string[]): GraphConfidence {
  // Anything that was never UNSAFE in the first place passes through untouched - there is nothing to
  // narrow, and re-deriving sourceFileCount/integrity from raw fields here (rather than trusting the
  // already-computed confidence) would be both redundant and a real correctness risk: a caller's
  // profile object could be stale/unrelated to the graph actually being evaluated for reasons that have
  // nothing to do with this delta, and computeConfidence() already made the authoritative call once.
  if (result.confidence !== "UNSAFE") return result.confidence;
  // sourceFileCount===0 can never co-occur with unresolved.length>0 in a real graph (buildDependencyGraph
  // only ever records an unresolved entry for a file that isSourceFileName(), and any such file is
  // unconditionally added to internalSourcePaths before unresolved-detection ever runs - so
  // unresolved.length>0 guarantees sourceFileCount>=1 by construction). No need to re-check it
  // independently; result.confidence already reflects it correctly.
  //
  // integrity.criticalCount>0 is different - it's a genuinely independent condition (graph edge/adjacency
  // consistency, orthogonal to import resolution) that COULD co-occur with real unresolved imports, and
  // is never narrowable by reachability (an internally-broken graph gives no trustworthy reachability
  // information to reason about at all) - checked explicitly here, only within this already-UNSAFE
  // branch, not as an unconditional gate that could override a confidence that was never UNSAFE.
  if (result.integrity.criticalCount > 0) return "UNSAFE";
  if (result.unresolved.length === 0) return result.confidence;

  const reachableFromChanged = new Set<string>();
  for (const file of changedFiles) {
    for (const dep of result.graph.transitiveDependenciesOf(file)) reachableFromChanged.add(dep);
    for (const dep of result.graph.transitiveDependentsOf(file)) reachableFromChanged.add(dep);
  }
  const changedSet = new Set(changedFiles);

  const relevantUnresolved = result.unresolved.some((u) => changedSet.has(u.importer) || reachableFromChanged.has(u.importer));
  if (relevantUnresolved) return "UNSAFE";

  // None of the unresolved imports are reachable from this delta's changed files - narrow to what
  // confidence would have been without the unresolved-import trigger (still respecting the
  // project-references cap, exactly as computeConfidence()'s own final two branches do).
  return result.resolvedViaProjectReferences ? "PARTIAL" : "COMPLETE";
}

export function graphToJson(result: DependencyGraphResult): string {
  const { graph, profile, unresolved, references, counts, externalReferences, platformBuiltinReferences, internalAssetEdges, performance, confidence, integrity } = result;
  return JSON.stringify(
    {
      profile,
      graph: {
        nodes: graph.nodes,
        edges: graph.edges,
      },
      unresolved,
      references,
      counts,
      externalReferences,
      platformBuiltinReferences,
      internalAssetEdges,
      performance,
      confidence,
      integrity,
    },
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2,
  );
}