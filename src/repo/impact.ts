import { extname, posix } from "node:path";
import type { ChangedFile, GitDelta } from "../git/types.js";
import type { DependencyGraph, DependencyGraphNode, DependencyGraphResult, EntryPoint, RepositoryProfile } from "./types.js";
import type { ChangedImpact, EntryPointImpact, ImpactEvidence, ImpactEvidencePath, ImpactReason, ImpactResult, ImpactRiskSignal, TestImpact } from "./impact-types.js";
import { refineConfidenceForDelta } from "./graph.js";
import { createTestFileMatcher, DEFAULT_TEST_FILE_MATCHER } from "./test-discovery.js";
import { resolveTestFixtureOwners } from "./test-fixture-ownership.js";

const SOURCE_EXTENSIONS = new Set([".ts",".tsx",".js",".jsx",".mjs",".cjs",".mts",".cts"]);
const ASSET_EXTENSIONS = new Set([".css",".scss",".sass",".less",".json",".jsonc",".svg",".png",".jpg",".jpeg",".gif",".webp",".ico",".bmp",".woff",".woff2",".ttf",".otf",".eot",".wasm",".md",".txt"]);
const NEXT_ENTRY_NAMES = new Set(["page","layout","route","api","loading","error","template","not-found","middleware","generatemetadata","generatestaticparams"]);

function isSourceFilePath(filePath: string): boolean { return SOURCE_EXTENSIONS.has(extname(filePath).toLowerCase()); }
function isAssetFilePath(filePath: string): boolean { return ASSET_EXTENSIONS.has(extname(filePath).toLowerCase()); }
// "Is this a test?" is answered by the profile's test patterns (src/repo/test-discovery.ts) - one shared
// definition with analyzer discovery and graph node flags. Module-level helpers receive it explicitly.
type IsTestFile = (filePath: string) => boolean;
function isScriptFile(filePath: string): boolean { return filePath.startsWith("scripts/") || filePath.startsWith("ops/"); }
function isDocumentationFile(filePath: string): boolean { const ext = extname(filePath).toLowerCase(); return ext === ".md" || ext === ".mdx" || filePath.startsWith("docs/"); }
function isConfigFile(filePath: string): boolean {
  const CONFIG_FILE_NAMES = new Set(["package.json","package-lock.json","yarn.lock","pnpm-lock.yaml","bun.lockb","bun.lock","tsconfig.json","tsconfig.base.json","tsconfig.build.json","jsconfig.json"]);
  const base = posix.basename(filePath);
  if (CONFIG_FILE_NAMES.has(base)) return true;
  if (base.startsWith("next.config")) return true;
  if (base.startsWith("tailwind.config")) return true;
  if (base.startsWith("postcss.config")) return true;
  if (base.startsWith("eslint.config")) return true;
  if (base.startsWith(".eslintrc")) return true;
  if (base.startsWith("vitest.config")) return true;
  if (base.startsWith("jest.config")) return true;
  if (base.startsWith("prettier.config")) return true;
  if (base.startsWith(".prettierrc")) return true;
  if (filePath.startsWith(".github/")) return true;
  if (filePath.includes("/Dockerfile")) return true;
  if (filePath.startsWith("docker")) return true;
  return false;
}
function isInfrastructureFile(filePath: string): boolean { const INFRA_DIRS = new Set(["ops","terraform","cloudformation","pulumi","cdktf","deploy","deployments","kubernetes","k8s","helm","docker"]); if (filePath.startsWith("ops/")) return true; const first = filePath.split("/")[0]; if (first && INFRA_DIRS.has(first)) return true; if (posix.basename(filePath).includes("Dockerfile")) return true; return false; }
function isDatabaseFile(filePath: string): boolean { const DATABASE_DIRS = new Set(["database","migrations","prisma","drizzle","supabase","schema"]); if (filePath.startsWith("database/")) return true; const first = filePath.split("/")[0]; return first ? DATABASE_DIRS.has(first) : false; }
function classifyNextEntryPoint(filePath: string): EntryPoint["kind"] | undefined { if (!isSourceFilePath(filePath)) return undefined; const base = posix.basename(filePath, extname(filePath)); const lower = base.toLowerCase(); if (lower === "page") return "next-page"; if (lower === "layout") return "next-layout"; if (lower === "route") return "next-route"; if (lower === "api" && filePath.includes("/api/")) return "next-api"; if (lower === "loading") return "next-loading"; if (lower === "error") return "next-error"; if (lower === "template") return "next-template"; if (lower === "not-found") return "next-error"; if (lower === "middleware") return "next-api"; return undefined; }
function allChangePaths(file: ChangedFile): string[] { return file.oldPath ? [file.path, file.oldPath] : [file.path]; }
function nodeByPath(graph: DependencyGraph, path: string): DependencyGraphNode | undefined { return graph.nodes.find((n) => n.path === path); }
function hasNode(graph: DependencyGraph, path: string): boolean { return nodeByPath(graph, path) !== undefined; }
function isEntryPoint(profile: RepositoryProfile, path: string): EntryPoint | undefined { return profile.entryPoints.find((e) => e.path === path); }
function isPotentialNextEntryPoint(path: string): boolean { if (!isSourceFilePath(path)) return false; const base = posix.basename(path, extname(path)).toLowerCase(); return NEXT_ENTRY_NAMES.has(base); }
function isNextLayoutProfile(profile: RepositoryProfile): boolean { return !!profile.nextConfig?.exists; }
function isNextLayoutEntry(profile: RepositoryProfile, filePath: string): boolean { if (!isNextLayoutProfile(profile)) return false; const base = posix.basename(filePath, extname(filePath)).toLowerCase(); return base === "layout"; }
function parentRouteDirectory(filePath: string): string | undefined { const idx = filePath.lastIndexOf("/"); if (idx <= 0) return undefined; return filePath.slice(0, idx); }
function isDescendantOf(parentDir: string, candidateFile: string): boolean { const parent = parentDir.endsWith("/") ? parentDir : `${parentDir}/`; return candidateFile.startsWith(parent); }
function collectDescendantEntryPoints(profile: RepositoryProfile, layoutPath: string): EntryPoint[] { const layoutDir = parentRouteDirectory(layoutPath); if (!layoutDir) return []; return profile.entryPoints.filter((ep) => { if (ep.path === layoutPath) return false; if (!isPotentialNextEntryPoint(ep.path)) return false; return isDescendantOf(layoutDir, ep.path); }); }

function shortestPathBFS(graph: DependencyGraph, start: string, target: string, direction: "dependents" | "dependencies", maxDepth = 8): string[] | undefined {
  if (start === target) return [start];
  const adjacency = direction === "dependents" ? (p: string) => graph.dependentsOf(p) : (p: string) => graph.dependenciesOf(p);
  const visited = new Map<string, string | null>();
  const queue: Array<{ path: string; depth: number }> = [{ path: start, depth: 0 }];
  visited.set(start, null);
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const next of adjacency(current.path)) {
      if (visited.has(next)) continue;
      visited.set(next, current.path);
      if (next === target) {
        const result: string[] = [target];
        let back: string | null | undefined = current.path;
        while (back) { result.unshift(back); back = visited.get(back); }
        return result;
      }
      queue.push({ path: next, depth: current.depth + 1 });
    }
  }
  return undefined;
}
function shortestDependentPathToTest(graph: DependencyGraph, changedFilePath: string, testPath: string): ImpactEvidencePath | undefined {
  const path = shortestPathBFS(graph, changedFilePath, testPath, "dependents", 12);
  if (!path) return undefined;
  return { changedFile: changedFilePath, path, pathKind: "dependents" };
}
function collectScriptsAmong(candidates: Iterable<string>, isTestFile: IsTestFile): string[] { const result: string[] = []; for (const path of candidates) { if (isScriptFile(path) && !isTestFile(path)) result.push(path); } return result.sort(); }
function makeEvidence(reason: ImpactReason, changedFile: string, message: string, affectedFile?: string, path?: ImpactEvidencePath): ImpactEvidence { return { reason, changedFile, affectedFile, message, path }; }

function classifyChangedFile(file: ChangedFile, isTestFile: IsTestFile, repositoryFiles?: ReadonlySet<string>): ChangedImpact["category"] {
  const path = file.path;
  const oldPath = file.oldPath;
  if (isConfigFile(path) || (oldPath && isConfigFile(oldPath))) return "config";
  if (isInfrastructureFile(path) || (oldPath && isInfrastructureFile(oldPath))) return "infrastructure";
  if (isDatabaseFile(path) || (oldPath && isDatabaseFile(oldPath))) return "database";
  if (isSourceFilePath(path)) {
    if (isTestFile(path)) return "test";
    if (isScriptFile(path)) return "script";
    if (classifyNextEntryPoint(path)) return "entry-point";
    return "source";
  }
  if (isAssetFilePath(path)) return "asset";
  if (isDocumentationFile(path)) return "docs";
  if (isTranslatedDocumentationCompanion(path, repositoryFiles)) return "docs";
  // Recorded test inputs under <scope>/tests/<snapshots|fixtures>/ are owned by the tests beside them
  // (src/repo/test-fixture-ownership.ts). Only claimed when an owner can actually be resolved at HEAD.
  if (resolveTestFixtureOwners(path, isTestFile, repositoryFiles)) return "test-fixture";
  return "unknown";
}

/**
 * Executable directly-changed tests (2026-08-24): the set of added / modified / renamed-destination /
 * copied-destination test files in a delta that MUST be present in the final selected-test set. This is
 * the "changed-test self-selection" invariant's input. Deleted tests are excluded (their paths no longer
 * exist at HEAD and must never be executed; a deleted test is instead handled conservatively elsewhere).
 * Only `file.path` is considered here: for a rename/copy that is the destination (the source identity is
 * `file.oldPath` and is intentionally not a test to run).
 */
export function directlyChangedExecutableTests(delta: GitDelta, isTestFile: IsTestFile): string[] {
  const result = new Set<string>();
  for (const file of delta.files) {
    if (file.changeType === "deleted") continue;
    const path = file.path;
    if (isSourceFilePath(path) && isTestFile(path)) result.add(path);
  }
  return Array.from(result).sort();
}

/**
 * Translated-documentation companion records (2026-08-23, docs/research/2026-08-23-deepseek-harness-
 * benchmark.md): the deepseek-harness benchmark showed 26/28 fallbacks carried "Unknown changed file"
 * and 777 of those files were `<doc>.i18n.yaml` - per-document translation-pairing metadata (the git
 * blob hashes of `<doc>.md` / `<doc>.zh.md`) consumed only by a pre-push gate and a merge driver,
 * never by runtime code or tests. Classifying them as docs is a RELATIONSHIP rule, not a YAML rule:
 *   1. the file name is `<base>.<tag>.yaml|yml` where <tag> denotes translation METADATA
 *      (`i18n`, `l10n`, `translation`, `translations`) - NOT a locale code, because `<base>.en.yaml`
 *      is just as plausibly runtime i18n content loaded by a site generator;
 *   2. a Markdown document `<base>.md` / `<base>.mdx` exists beside it at HEAD - the companion must
 *      actually accompany a document; and
 *   3. the caller supplied the HEAD file list at all. Without it the relationship cannot be verified
 *      and the file stays "unknown" (full validation) - existing callers that pass nothing see
 *      byte-identical behavior.
 * Ordinary YAML (CI config, locale bundles under `locales/`, anything without the documented
 * companion) never reaches this check as docs. Config/infra/database classification runs first, so
 * e.g. `.github/README.i18n.yaml` still counts as config.
 */
const TRANSLATION_METADATA_TAGS = new Set(["i18n", "l10n", "translation", "translations"]);
export function isTranslatedDocumentationCompanion(filePath: string, repositoryFiles: ReadonlySet<string> | undefined): boolean {
  if (!repositoryFiles) return false;
  const base = posix.basename(filePath);
  const match = /^(.+)\.([A-Za-z0-9_-]+)\.(yaml|yml)$/.exec(base);
  if (!match) return false;
  const [, docStem, tag] = match;
  if (!docStem || !tag || !TRANSLATION_METADATA_TAGS.has(tag.toLowerCase())) return false;
  const dir = posix.dirname(filePath);
  const companionBase = dir === "." ? docStem : `${dir}/${docStem}`;
  return repositoryFiles.has(`${companionBase}.md`) || repositoryFiles.has(`${companionBase}.mdx`);
}

export interface ImpactAnalyzeOptions {
  /** Repo-relative paths of every file present at HEAD (e.g. `git ls-tree -r --name-only <head>`).
   * Enables relationship-based classification (see isTranslatedDocumentationCompanion). Optional -
   * omitting it disables those rules and keeps prior behavior exactly. */
  repositoryFiles?: ReadonlySet<string>;
}

function changedFileReasons(file: ChangedFile): ImpactReason[] {
  switch (file.changeType) {
    case "added": return ["DIRECT_CHANGE"];
    case "deleted": return ["DIRECT_CHANGE", "DELETED_FILE_LEGACY_DEPENDENTS"];
    case "renamed": return ["DIRECT_CHANGE", "RENAMED_FILE_LEGACY_IDENTITY"];
    default: return ["DIRECT_CHANGE"];
  }
}

export interface AlwaysRunCheck { name: string; reason: ImpactReason; patterns: RegExp[]; }
export const DEFAULT_ALWAYS_RUN_CHECKS: AlwaysRunCheck[] = [
  { name: "security", reason: "ALWAYS_RUN_POLICY", patterns: [/test-security\.js$/i, /security\.test\./i, /scripts[\/]test-security/i] },
  { name: "api-guardrails", reason: "ALWAYS_RUN_POLICY", patterns: [/test-api-guardrails/i, /api-guardrails/i] },
  { name: "architecture-validations", reason: "ALWAYS_RUN_POLICY", patterns: [/scripts[\/].*\.test\.mjs$/i, /verify-.*\.test\./i, /validate-.*\.test\./i] },
];

export class ImpactAnalyzer {
  private alwaysRunChecks: AlwaysRunCheck[];
  private isTestFile: IsTestFile = DEFAULT_TEST_FILE_MATCHER;
  private repositoryFiles: ReadonlySet<string> | undefined;
  constructor(alwaysRunChecks: AlwaysRunCheck[] = DEFAULT_ALWAYS_RUN_CHECKS) { this.alwaysRunChecks = alwaysRunChecks; }

  analyze(delta: GitDelta, graphResult: DependencyGraphResult, profile: RepositoryProfile, options: ImpactAnalyzeOptions = {}): ImpactResult {
    const start = process.hrtime.bigint();
    const { graph } = graphResult;
    this.isTestFile = profile.testPatterns ? createTestFileMatcher(profile.testPatterns) : DEFAULT_TEST_FILE_MATCHER;
    this.repositoryFiles = options.repositoryFiles;
    const changedImpacts: ChangedImpact[] = delta.files.map((file) => ({ file, category: classifyChangedFile(file, this.isTestFile, options.repositoryFiles), reasons: changedFileReasons(file) }));
    const evidence: ImpactEvidence[] = [];
    const riskSignals: ImpactRiskSignal[] = [];
    const fallbackReasons: string[] = [];

    this.applyGlobalRiskRules(delta, riskSignals, fallbackReasons);

    // Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): refine the graph's raw,
    // delta-independent confidence to THIS delta's changed files - see refineConfidenceForDelta()'s doc
    // comment in graph.ts for the full reasoning and what is (and is deliberately NOT) narrowed.
    const changedPaths = delta.files.flatMap((f) => allChangePaths(f));
    const effectiveGraphConfidence = refineConfidenceForDelta(graphResult, changedPaths);

    if (effectiveGraphConfidence === "UNSAFE") {
      const message = "Dependency graph confidence is UNSAFE; full validation required";
      riskSignals.push({ level: "critical", reason: "GRAPH_CONFIDENCE_UNSAFE", message });
      fallbackReasons.push(message);
    }

    if (delta.files.length === 0) {
      riskSignals.push({ level: "info", reason: "EMPTY_DELTA", message: "Empty delta; nothing to analyze" });
    }

    const affectedSources = new Map<string, ImpactEvidence[]>();
    const affectedAssets = new Map<string, ImpactEvidence[]>();
    const affectedEntryPoints = new Map<string, EntryPointImpact>();
    const affectedTests = new Map<string, TestImpact>();
    const affectedScripts = new Map<string, ImpactEvidence[]>();

    for (const changedImpact of changedImpacts) {
      for (const path of allChangePaths(changedImpact.file)) {
        this.processChangedPath(path, changedImpact, graph, profile, affectedSources, affectedAssets, affectedEntryPoints, affectedTests, affectedScripts, evidence, riskSignals, fallbackReasons);
      }
    }

    this.handleStructuralNextLayout(changedImpacts, profile, affectedEntryPoints, affectedSources, evidence);
    this.handleAddedEntryPoints(delta, affectedEntryPoints, affectedSources, affectedTests, evidence, fallbackReasons);
    this.collectAlwaysRunTests(profile, graph, affectedTests, evidence);

    // Changed-test self-selection invariant (2026-08-24): every executable directly-changed test
    // (added / modified / renamed-destination / copied-destination) MUST be present in the final
    // selected-test set. This is a defense-in-depth guard over the traversal above so a selection
    // regression cannot silently authorize a SAFE_TO_PROPOSE that would skip a just-edited test.
    const directlyChangedTests = directlyChangedExecutableTests(delta, this.isTestFile);
    const selectedTestPaths = new Set(affectedTests.keys());
    const missingSelectedTests = directlyChangedTests.filter((t) => !selectedTestPaths.has(t));
    if (missingSelectedTests.length > 0) {
      const message = `Changed test selection invariant violated: ${missingSelectedTests.length} directly changed test(s) not selected (${missingSelectedTests.join(", ")})`;
      riskSignals.push({ level: "critical", reason: "TEST_SELECTION_INVARIANT", message, paths: missingSelectedTests });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
    }

    const fallbackRequired = effectiveGraphConfidence === "UNSAFE" || fallbackReasons.length > 0;
    const analysisStatus: ImpactResult["analysisStatus"] = fallbackRequired ? "FALLBACK" : "SAFE_TO_PROPOSE";
    const dedupedRiskSignals = Array.from(
      new Map(riskSignals.map((s) => [s.reason, s])).values(),
    ).sort((a, b) => a.reason.localeCompare(b.reason));

    return {
      changedFiles: changedImpacts,
      affectedSourceFiles: Array.from(affectedSources.keys()).sort(),
      affectedAssets: Array.from(affectedAssets.keys()).sort(),
      affectedTests: Array.from(affectedTests.values()).sort((a, b) => a.path.localeCompare(b.path)),
      affectedEntryPoints: Array.from(affectedEntryPoints.values()).sort((a, b) => a.path.localeCompare(b.path)),
      affectedScripts: Array.from(affectedScripts.keys()).sort(),
      riskSignals: dedupedRiskSignals,
      fallbackRequired,
      fallbackReasons,
      analysisStatus,
      effectiveGraphConfidence,
      evidence: evidence.sort((a, b) => { const c = a.changedFile.localeCompare(b.changedFile); if (c !== 0) return c; return a.message.localeCompare(b.message); }),
      performance: { durationMs: Number(process.hrtime.bigint() - start) / 1_000_000 },
    };
  }

  private applyGlobalRiskRules(delta: GitDelta, riskSignals: ImpactRiskSignal[], fallbackReasons: string[]): void {
    const reasons: Array<{ reason: ImpactReason; message: string; check: (a: GitDelta["analysis"]) => boolean }> = [
      { reason: "CONFIG_GLOBAL", message: "Configuration file(s) changed; full validation required", check: (a) => a.configChanged },
      { reason: "DEPENDENCY_MANIFEST", message: "Dependency manifest changed; full validation required", check: (a) => a.dependencyManifestChanged },
      { reason: "LOCKFILE_GLOBAL", message: "Lockfile changed; full validation required", check: (a) => a.lockfileChanged },
      { reason: "WORKFLOW_GLOBAL", message: "GitHub workflow definition(s) changed; full validation required", check: (a) => a.workflowChanged },
      { reason: "INFRASTRUCTURE_GLOBAL", message: "Infrastructure definition(s) changed; full validation required", check: (a) => a.infrastructureChanged },
      { reason: "DATABASE_GLOBAL", message: "Database definition(s) changed; full validation required", check: (a) => a.databaseChanged },
    ];
    for (const rule of reasons) {
      if (rule.check(delta.analysis)) {
        riskSignals.push({ level: "critical", reason: rule.reason, message: rule.message });
        if (!fallbackReasons.includes(rule.message)) fallbackReasons.push(rule.message);
      }
    }
  }

  private processChangedPath(
    changedPath: string,
    changedImpact: ChangedImpact,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedAssets: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
    riskSignals: ImpactRiskSignal[],
    fallbackReasons: string[],
  ): void {
    const category = changedImpact.category;
    if (category === "test-fixture") {
      // Resolved per change PATH (a rename's old path resolves independently); an unresolvable side
      // degrades to the unknown-file fallback below rather than being silently dropped.
      const ownership = resolveTestFixtureOwners(changedPath, this.isTestFile, this.repositoryFiles);
      if (ownership) {
        for (const owner of ownership.owners) {
          this.addAffectedTest(changedPath, owner, graph, affectedTests, "TEST_FIXTURE_OWNER", evidence);
        }
        evidence.push(makeEvidence("TEST_FIXTURE_OWNER", changedPath, `Test fixture ${changedPath} under ${ownership.fixtureDir} is owned by ${ownership.owners.length} test(s) in ${ownership.testsDir} (${ownership.scope})`));
        return;
      }
    }
    if (category === "unknown" || category === "test-fixture") {
      const message = `Unknown changed file: ${changedPath}`;
      evidence.push(makeEvidence("UNKNOWN_FILE", changedPath, message));
      riskSignals.push({ level: "critical", reason: "UNKNOWN_FILE", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    if (category === "docs") return;
    if (isAssetFilePath(changedPath)) {
      this.processAssetChange(changedPath, graph, profile, affectedAssets, affectedEntryPoints, affectedTests, affectedSources, evidence);
      return;
    }
    if (category === "config" || category === "workflow" || category === "infrastructure" || category === "database") {
      evidence.push(makeEvidence("CONFIG_GLOBAL", changedPath, `Global ${category} change at ${changedPath}`));
      return;
    }
    if (category === "test") {
      this.processTestChange(changedPath, changedImpact, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence, riskSignals, fallbackReasons);
      return;
    }
    if (changedImpact.file.changeType === "deleted" && !hasNode(graph, changedPath)) {
      const message = `Deleted source/asset ${changedPath} not present in HEAD dependency graph; legacy dependents cannot be determined`;
      evidence.push(makeEvidence("DELETED_FILE_UNKNOWABLE_GRAPH", changedPath, message));
      riskSignals.push({ level: "critical", reason: "DELETED_FILE_UNKNOWABLE_GRAPH", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }
    this.processSourceChange(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
  }

  private processAssetChange(
    assetPath: string,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedAssets: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedSources: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): void {
    if (!affectedAssets.has(assetPath)) affectedAssets.set(assetPath, []);
    affectedAssets.get(assetPath)!.push(makeEvidence("ASSET_DEPENDENCY", assetPath, `Changed asset: ${assetPath}`));
    if (!hasNode(graph, assetPath)) return;
    const dependents = graph.transitiveDependentsOf(assetPath);
    for (const dependent of dependents) {
      if (nodeByPath(graph, dependent)?.isEntryPoint) {
        this.addAffectedEntryPoint(dependent, profile, affectedEntryPoints, "ASSET_DEPENDENCY", assetPath, evidence);
      }
      if (this.isTestFile(dependent)) {
        this.addAffectedTest(assetPath, dependent, graph, affectedTests, "ASSET_DEPENDENCY", evidence);
      }
      if (isSourceFilePath(dependent) && !this.isTestFile(dependent)) {
        if (!affectedSources.has(dependent)) affectedSources.set(dependent, []);
        affectedSources.get(dependent)!.push(makeEvidence("ASSET_DEPENDENCY", assetPath, `Asset ${assetPath} affects source ${dependent}`, dependent));
      }
    }
  }

  private processSourceChange(
    sourcePath: string,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): void {
    if (!hasNode(graph, sourcePath)) {
      if (isPotentialNextEntryPoint(sourcePath) || isScriptFile(sourcePath)) {
        this.addAffectedEntryPoint(sourcePath, profile, affectedEntryPoints, "NEW_ENTRY_POINT", sourcePath, evidence);
      }
      return;
    }

    if (!this.isTestFile(sourcePath)) {
      if (!affectedSources.has(sourcePath)) affectedSources.set(sourcePath, []);
      affectedSources.get(sourcePath)!.push(makeEvidence("DIRECT_CHANGE", sourcePath, `Changed source: ${sourcePath}`));
    }
    if (isEntryPoint(profile, sourcePath) || classifyNextEntryPoint(sourcePath)) {
      this.addAffectedEntryPoint(sourcePath, profile, affectedEntryPoints, "NEXT_ENTRY_POINT", sourcePath, evidence);
    }

    const dependents = graph.transitiveDependentsOf(sourcePath);
    for (const dependent of dependents) {
      if (!this.isTestFile(dependent)) {
        if (!affectedSources.has(dependent)) affectedSources.set(dependent, []);
        affectedSources.get(dependent)!.push(makeEvidence("DEPENDENCY", sourcePath, `${sourcePath} affects ${dependent} via dependency graph`, dependent));
      }
      if (nodeByPath(graph, dependent)?.isEntryPoint) {
        this.addAffectedEntryPoint(dependent, profile, affectedEntryPoints, "DEPENDENCY", sourcePath, evidence);
      }
      if (this.isTestFile(dependent)) {
        this.addAffectedTest(sourcePath, dependent, graph, affectedTests, "DEPENDENCY", evidence);
      }
    }

    const reachable = new Set([sourcePath, ...dependents]);
    for (const scriptPath of collectScriptsAmong(reachable, this.isTestFile)) {
      if (!affectedScripts.has(scriptPath)) affectedScripts.set(scriptPath, []);
      affectedScripts.get(scriptPath)!.push(makeEvidence("DEPENDENCY", sourcePath, `${sourcePath} affects script ${scriptPath}`, scriptPath));
    }
  }

  /**
   * Handles a directly-changed test file (2026-08-24 fix). Previously changed tests fell through to
   * processSourceChange, which never added the test itself to affectedTests, so a "test-only" diff
   * (e.g. Nx #36723) authorized SAFE_TO_PROPOSE with zero selected tests. Now:
   *   - deleted test: never select the (nonexistent) path; fall back when its node is absent, else
   *     traverse its legacy dependents conservatively;
   *   - rename/copy source identity (oldPath): record the legacy identity only — the destination is the
   *     executable test and is handled on its own path iteration;
   *   - added / modified / renamed-destination / copied-destination: select the test itself and then
   *     traverse dependents (shared test helpers) exactly like processSourceChange.
   */
  private processTestChange(
    changedPath: string,
    changedImpact: ChangedImpact,
    graph: DependencyGraph,
    profile: RepositoryProfile,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedTests: Map<string, TestImpact>,
    affectedScripts: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
    riskSignals: ImpactRiskSignal[],
    fallbackReasons: string[],
  ): void {
    const file = changedImpact.file;
    const isOldPath = file.oldPath !== undefined && changedPath === file.oldPath;

    if (file.changeType === "deleted") {
      // Never select a deleted test. If its node is still present (stale/base graph), traverse legacy
      // dependents conservatively; otherwise safety cannot be established and we require full validation.
      if (hasNode(graph, changedPath)) {
        this.processSourceChange(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
        return;
      }
      const message = `Deleted test ${changedPath}; legacy coverage/dependents cannot be established safely`;
      evidence.push(makeEvidence("DELETED_FILE_UNKNOWABLE_GRAPH", changedPath, message));
      riskSignals.push({ level: "critical", reason: "DELETED_FILE_UNKNOWABLE_GRAPH", message, paths: [changedPath] });
      if (!fallbackReasons.includes(message)) fallbackReasons.push(message);
      return;
    }

    if (isOldPath) {
      evidence.push(makeEvidence("RENAMED_FILE_LEGACY_IDENTITY", changedPath, `Renamed test source ${changedPath}; destination handled separately`));
      return;
    }

    if (this.isTestFile(changedPath)) {
      this.addAffectedTest(changedPath, changedPath, graph, affectedTests, "DIRECT_TEST_CHANGE", evidence);
    }
    this.processSourceChange(changedPath, graph, profile, affectedSources, affectedEntryPoints, affectedTests, affectedScripts, evidence);
  }

  private addAffectedEntryPoint(
    path: string,
    profile: RepositoryProfile,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    reason: ImpactReason,
    changedFile: string,
    evidence: ImpactEvidence[],
  ): void {
    const ep = isEntryPoint(profile, path);
    const kind = ep?.kind ?? classifyNextEntryPoint(path) ?? "unknown";
    const existing = affectedEntryPoints.get(path);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    } else {
      affectedEntryPoints.set(path, { path, kind, reasons: [reason] });
    }
    evidence.push(makeEvidence(reason, changedFile, `Affected entry point ${path} (${kind})`, path));
  }

  private addAffectedTest(
    changedFile: string,
    testPath: string,
    graph: DependencyGraph,
    affectedTests: Map<string, TestImpact>,
    reason: ImpactReason,
    evidence: ImpactEvidence[],
  ): void {
    let existing = affectedTests.get(testPath);
    if (!existing) {
      existing = { path: testPath, reasons: [], evidence: [] };
      affectedTests.set(testPath, existing);
    }
    if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
    const path = shortestDependentPathToTest(graph, changedFile, testPath);
    const ev = makeEvidence(reason, changedFile, `Affected test: ${testPath} due to ${reason}`, testPath, path);
    existing.evidence.push(ev);
    evidence.push(ev);
  }


  private handleStructuralNextLayout(
    changedImpacts: ChangedImpact[],
    profile: RepositoryProfile,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedSources: Map<string, ImpactEvidence[]>,
    evidence: ImpactEvidence[],
  ): void {
    for (const changedImpact of changedImpacts) {
      if (changedImpact.category !== "entry-point") continue;
      for (const path of allChangePaths(changedImpact.file)) {
        if (!isNextLayoutEntry(profile, path)) continue;
        const descendants = collectDescendantEntryPoints(profile, path);
        for (const desc of descendants) {
          this.addAffectedEntryPoint(desc.path, profile, affectedEntryPoints, "NEXT_LAYOUT_ANCESTOR", path, evidence);
          if (!affectedSources.has(desc.path)) affectedSources.set(desc.path, []);
          affectedSources.get(desc.path)!.push(makeEvidence("NEXT_LAYOUT_ANCESTOR", path, `Layout ancestor ${path} structurally affects ${desc.path}`, desc.path));
        }
      }
    }
  }

  private handleAddedEntryPoints(
    delta: GitDelta,
    affectedEntryPoints: Map<string, EntryPointImpact>,
    affectedSources: Map<string, ImpactEvidence[]>,
    affectedTests: Map<string, TestImpact>,
    evidence: ImpactEvidence[],
    _fallbackReasons: string[],
  ): void {
    for (const added of this.detectAddedEntryPoints(delta)) {
      if (!affectedEntryPoints.has(added.path)) {
        affectedEntryPoints.set(added.path, { path: added.path, kind: added.kind, reasons: ["NEW_ENTRY_POINT"] });
        evidence.push(makeEvidence("NEW_ENTRY_POINT", added.path, `New entry point: ${added.path} (${added.kind})`, added.path));
      }
      if (added.kind === "test" && !affectedTests.has(added.path)) {
        affectedTests.set(added.path, { path: added.path, reasons: ["NEW_TEST_FILE"], evidence: [makeEvidence("NEW_TEST_FILE", added.path, `New test file: ${added.path}`, added.path)] });
      }
      if (added.kind === "script") {
        if (!affectedSources.has(added.path)) affectedSources.set(added.path, []);
        affectedSources.get(added.path)!.push(makeEvidence("NEW_SCRIPT_FILE", added.path, `New script: ${added.path}`, added.path));
      }
    }
  }

  private detectAddedEntryPoints(delta: GitDelta): Array<{ path: string; kind: NonNullable<EntryPoint["kind"] | "script" | "test"> }> {
    const result: Array<{ path: string; kind: NonNullable<EntryPoint["kind"] | "script" | "test"> }> = [];
    for (const file of delta.files) {
      if (file.changeType !== "added") continue;
      const kind = classifyNextEntryPoint(file.path);
      if (kind) result.push({ path: file.path, kind });
      else if (file.path.startsWith("scripts/")) result.push({ path: file.path, kind: "script" });
      else if (this.isTestFile(file.path)) result.push({ path: file.path, kind: "test" });
    }
    return result;
  }

  private collectAlwaysRunTests(
    profile: RepositoryProfile,
    graph: DependencyGraph,
    affectedTests: Map<string, TestImpact>,
    evidence: ImpactEvidence[],
  ): void {
    const alwaysRunPaths = new Set<string>();
    const knownTestPaths = new Set<string>();
    for (const testLocation of profile.tests) {
      for (const node of graph.nodes) {
        if (matchesGlob(testLocation.glob, node.path) || this.isTestFile(node.path)) {
          knownTestPaths.add(node.path);
        }
      }
    }
    for (const check of this.alwaysRunChecks) {
      for (const path of knownTestPaths) {
        for (const pattern of check.patterns) {
          if (pattern.test(path)) { alwaysRunPaths.add(path); break; }
        }
      }
    }
    for (const testPath of alwaysRunPaths) {
      if (!affectedTests.has(testPath)) affectedTests.set(testPath, { path: testPath, reasons: ["ALWAYS_RUN_POLICY"], evidence: [] });
      const existing = affectedTests.get(testPath)!;
      if (!existing.reasons.includes("ALWAYS_RUN_POLICY")) existing.reasons.push("ALWAYS_RUN_POLICY");
      const ev = makeEvidence("ALWAYS_RUN_POLICY", testPath, `Always-run check policy includes ${testPath}`, testPath);
      existing.evidence.push(ev);
      evidence.push(ev);
    }
  }
}

function matchesGlob(glob: string, path: string): boolean {
  const trimmed = glob.replace(/^\*\*\//, "").replace(/\*\*\/|\*\*/g, ".*").replace(/\*/g, "[^/]*").replace(/\?/g, ".").replace(/\{([^}]+)\}/g, "($1)").replace(/,/g, "|");
  const regex = new RegExp(`^${trimmed}$`);
  return regex.test(path);
}
