import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, extname, join, relative, resolve, sep } from "node:path";
import type {
  EntryPoint,
  PackageManager,
  PathAlias,
  RepositoryProfile,
  SourceRoot,
  TestLocation,
  Workflow,
} from "./types.js";

const DEFAULT_TEST_PATTERNS = [
  "**/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
  "**/*.spec.{ts,tsx,js,jsx,mjs,cjs,mts,cts}",
];

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "coverage",
  "tmp",
  "temp",
]);

export interface AnalyzeRepositoryOptions {
  repoPath?: string;
  sourceRoots?: string[];
  testPatterns?: string[];
  excludeDirs?: string[];
}

function toPosix(p: string): string {
  return p.split(sep).join("/");
}

function repoRelative(repoPath: string, absolutePath: string): string {
  return toPosix(relative(repoPath, absolutePath));
}

function readJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function detectPackageManager(repoPath: string): PackageManager {
  if (existsSync(join(repoPath, "bun.lockb")) || existsSync(join(repoPath, "bun.lock"))) {
    return "bun";
  }
  if (existsSync(join(repoPath, "pnpm-lock.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoPath, "yarn.lock"))) {
    return "yarn";
  }
  if (existsSync(join(repoPath, "package-lock.json"))) {
    return "npm";
  }
  return "unknown";
}

function findConfig(repoPath: string, name: string): string | undefined {
  const candidates = readdirSync(repoPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.startsWith(name))
    .map((entry) => entry.name)
    .sort();
  return candidates.length > 0 ? candidates[0] : undefined;
}

function discoverWorkflows(repoPath: string): Workflow[] {
  const workflowDir = join(repoPath, ".github", "workflows");
  if (!existsSync(workflowDir)) return [];

  const workflows: Workflow[] = [];
  for (const entry of readdirSync(workflowDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!/\.(ya?ml)$/.test(entry.name)) continue;
    const path = repoRelative(repoPath, join(workflowDir, entry.name));
    workflows.push({ path });
  }
  return workflows;
}

function parseTsconfigPaths(paths: Record<string, string[]> | undefined): PathAlias[] {
  if (!paths) return [];
  return Object.entries(paths).map(([pattern, substitutions]) => ({
    pattern,
    substitutions: substitutions.map(toPosix),
  }));
}

function loadTsconfig(repoPath: string): RepositoryProfile["tsconfig"] | undefined {
  const path = join(repoPath, "tsconfig.json");
  if (!existsSync(path)) return undefined;

  const raw = readJson<Record<string, unknown>>(path);
  if (!raw) return undefined;

  const compilerOptions = (raw.compilerOptions ?? {}) as Record<string, unknown>;
  return {
    path: toPosix(relative(repoPath, path)),
    baseUrl: typeof compilerOptions.baseUrl === "string" ? compilerOptions.baseUrl : undefined,
    pathAliases: parseTsconfigPaths(
      (compilerOptions.paths ?? {}) as Record<string, string[]>,
    ),
    allowJs: compilerOptions.allowJs === true,
    include: Array.isArray(raw.include) ? raw.include.map(String) : [],
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
  };
}

function inferRootKind(name: string): SourceRoot["kind"] {
  if (name === "src" || name === "lib") return "source";
  if (name === "app" || name === "pages") return "app";
  if (name === "scripts") return "scripts";
  if (name === "ops") return "operations";
  if (name === "tests" || name === "test") return "tests";
  if (name === "api") return "api";
  return "source";
}

function listDirectSubdirectories(dirPath: string): string[] {
  if (!existsSync(dirPath)) return [];
  return readdirSync(dirPath, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

function discoverSourceRoots(
  repoPath: string,
  sourceRoots?: string[],
  excludeDirs?: string[],
): SourceRoot[] {
  const roots: SourceRoot[] = [];
  const exclusions = new Set(excludeDirs ?? []);

  function tryRoot(name: string, kind: SourceRoot["kind"]): void {
    if (exclusions.has(name)) return;
    const full = join(repoPath, name);
    if (existsSync(full) && statSync(full).isDirectory()) {
      roots.push({ path: name, kind });
    }
  }

  if (sourceRoots && sourceRoots.length > 0) {
    for (const name of sourceRoots) {
      tryRoot(name, inferRootKind(name));
    }
    return roots;
  }

  tryRoot("src", "source");
  tryRoot("app", "app");
  tryRoot("pages", "app");
  tryRoot("lib", "source");
  tryRoot("scripts", "scripts");
  tryRoot("ops", "operations");
  tryRoot("tests", "tests");
  tryRoot("test", "tests");
  tryRoot("api", "api");

  // Real finding, Stage 0 medium batch (2026-08-21): colinhacks/zod (and other monorepos - trpc,
  // vitest before it was excluded on the separate tsconfig gap) have a top-level scripts/ directory
  // (an AUXILIARY root - build/release tooling, not application code) but no src/app/lib/tests/test/api
  // at the root; their real source and tests live nested under packages/<name>/src/. The old
  // `roots.length === 0` fallback condition meant scripts/ alone being present was enough to skip the
  // "scan every top-level directory" fallback entirely, so packages/ - where everything actually is -
  // was never scanned at all: discoverTests() came back with testsTotal:0 for every single delta in
  // these repositories, and downstream selected-test counts (computed independently via the impact
  // graph, not this file list) were then compared against a total of 0, producing the impossible
  // "selected > total" records caught in Gate C's aggregation. Fixed by only skipping the fallback when
  // a PRIMARY (code-bearing) root was found - scripts/ops alone no longer suppresses it.
  const hasPrimarySourceRoot = roots.some((r) => r.kind !== "scripts" && r.kind !== "operations");
  if (!hasPrimarySourceRoot) {
    const covered = new Set(roots.map((r) => r.path));
    const dirs = listDirectSubdirectories(repoPath)
      .filter((name) => !IGNORED_DIRS.has(name) && !exclusions.has(name) && !covered.has(name));
    for (const name of dirs) {
      roots.push({ path: name, kind: "source" });
    }
  }

  return roots;
}

function isTestFile(fileName: string): boolean {
  return /\.(test|spec)\./.test(fileName);
}

function expandGlobBraces(pattern: string): string[] {
  const match = /\{([^{}]*)\}/.exec(pattern);
  if (!match) return [pattern];
  const prefix = pattern.slice(0, match.index);
  const suffix = pattern.slice((match.index ?? 0) + match[0].length);
  const alternatives = match[1]!.split(",");
  const result: string[] = [];
  for (const alt of alternatives) result.push(...expandGlobBraces(`${prefix}${alt}${suffix}`));
  return result;
}

function globToRegex(pattern: string): RegExp {
  let escaped = pattern.replace(/\\/g, "\\\\").replace(/\./g, "\\.");
  // Protect the multi-segment globstar sequences behind placeholders before the
  // single-`*` replace runs below - otherwise the `*` inside "(?:.*/)?"/"(?:/.*)?"
  // gets re-matched and mangled by that same replace (e.g. "**/*.test.ts" would wrongly
  // become "^(?:.[^/]*/)?[^/]*\.test\.ts$" instead of "^(?:.*/)?[^/]*\.test\.ts$",
  // silently failing to match anything more than one directory level deep).
  escaped = escaped
    .replace(/\*\*\//g, "\0GLOBSTAR_SLASH\0")
    .replace(/\/\*\*/g, "\0SLASH_GLOBSTAR\0")
    .replace(/\*/g, "[^/]*")
    .replace(/\0GLOBSTAR_SLASH\0/g, "(?:.*/)?")
    .replace(/\0SLASH_GLOBSTAR\0/g, "(?:/.*)?");
  return new RegExp(`^${escaped}$`);
}

/**
 * Matches a repo-relative (posix) path against a glob pattern that may contain `**`, `*`,
 * and `{a,b,c}` brace alternation (e.g. "**\/*.test.{ts,tsx,js,jsx,mjs,cjs,mts,cts}").
 */
function matchesTestGlob(path: string, pattern: string): boolean {
  return expandGlobBraces(pattern).some((p) => globToRegex(p).test(path));
}

function scanFiles(
  dirPath: string,
  repoPath: string,
  excludeDirs: ReadonlySet<string>,
  callback: (relativePath: string, fileName: string) => void,
): void {
  const entries = readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (excludeDirs.has(entry.name) || entry.name.startsWith(".")) continue;
      scanFiles(join(dirPath, entry.name), repoPath, excludeDirs, callback);
      continue;
    }
    if (entry.isFile()) continue;
    callback(repoRelative(repoPath, join(dirPath, entry.name)), entry.name);
  }
}

function discoverTests(
  repoPath: string,
  roots: SourceRoot[],
  patterns: string[],
  excludeDirs: string[],
): { locations: TestLocation[]; filePaths: string[] } {
  const counts = new Map<string, number>();
  const filePaths: string[] = [];
  const sources = roots.length > 0 ? roots.map((r) => join(repoPath, r.path)) : [repoPath];
  const exclusions = new Set([...IGNORED_DIRS.values(), ...excludeDirs]);

  for (const source of sources) {
    if (!existsSync(source)) continue;
    scanFiles(source, repoPath, exclusions, (relPath, fileName) => {
      if (!isTestFile(fileName)) return;
      for (const pattern of patterns) {
        if (!matchesTestGlob(relPath, pattern)) continue;
        counts.set(pattern, (counts.get(pattern) ?? 0) + 1);
        filePaths.push(relPath);
        break;
      }
    });
  }

  const locations = Array.from(counts.entries())
    .map(([glob, count]) => ({ glob, count }))
    .sort((a, b) => a.glob.localeCompare(b.glob));
  return { locations, filePaths: filePaths.sort() };
}

function discoverConfigFiles(repoPath: string, excludeDirs: string[]): string[] {
  const configNames = new Set<string>([
    "package.json",
    "package-lock.json",
    "pnpm-lock.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    "tsconfig.json",
    "jsconfig.json",
    "next.config.js",
    "next.config.mjs",
    "next.config.ts",
    "tailwind.config.js",
    "tailwind.config.ts",
    "postcss.config.js",
    "postcss.config.mjs",
    "eslint.config.js",
    "eslint.config.mjs",
    "eslint.config.ts",
    "biome.json",
    ".eslintrc.json",
    ".prettierrc",
    "playwright.config.ts",
    "vitest.config.ts",
    "jest.config.js",
    "next-env.d.ts",
    ".gitignore",
    ".env.example",
    ".env.local.example",
  ]);

  const found: string[] = [];
  const exclusions = new Set([...IGNORED_DIRS.values(), ...excludeDirs]);

  function walk(dirPath: string): void {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const full = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        if (exclusions.has(entry.name) || entry.name.startsWith(".")) continue;
        if (entry.name === "ops" || entry.name === "scripts") {
          found.push(repoRelative(repoPath, full));
        }
        walk(full);
        continue;
      }
      if (configNames.has(entry.name)) {
        found.push(repoRelative(repoPath, full));
      }
    }
  }

  walk(repoPath);
  return found.sort();
}

function isSourceExt(ext: string): boolean {
  const sourceExts = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);
  return sourceExts.has(ext.toLowerCase());
}

function classifyEntryPoints(
  repoPath: string,
  isNext: boolean,
  roots: SourceRoot[],
  excludeDirs: string[],
): EntryPoint[] {
  const entries: EntryPoint[] = [];
  const exclusions = new Set([...IGNORED_DIRS.values(), ...excludeDirs]);

  function walk(dirPath: string, fromRoot: string): void {
    const entriesList = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entriesList) {
      const full = join(dirPath, entry.name);
      const rel = repoRelative(repoPath, full);
      if (entry.isDirectory()) {
        if (exclusions.has(entry.name) || entry.name.startsWith(".")) continue;
        walk(full, fromRoot);
        continue;
      }
      if (!entry.isFile()) continue;

      const ext = extname(entry.name).toLowerCase();
      if (!isSourceExt(ext)) continue;
      const name = basename(entry.name, ext);
      const lower = name.toLowerCase();

      if (isNext && rel.startsWith(fromRoot + "/")) {
        if (lower === "page") {
          entries.push({ path: rel, kind: "next-page" });
        } else if (lower === "layout") {
          entries.push({ path: rel, kind: "next-layout" });
        } else if (lower === "route") {
          entries.push({ path: rel, kind: "next-route" });
        } else if (lower === "api") {
          entries.push({ path: rel, kind: "next-api" });
        } else if (lower === "loading") {
          entries.push({ path: rel, kind: "next-loading" });
        } else if (lower === "error") {
          entries.push({ path: rel, kind: "next-error" });
        } else if (lower === "template") {
          entries.push({ path: rel, kind: "next-template" });
        }
      }

      if (lower.includes(".test") || lower.includes(".spec")) {
        entries.push({ path: rel, kind: "test" });
      }

      if (fromRoot === "scripts") {
        entries.push({ path: rel, kind: "script" });
      }
    }
  }

  for (const root of roots) {
    const fullRoot = join(repoPath, root.path);
    if (!existsSync(fullRoot)) continue;
    walk(fullRoot, root.path);
  }

  return entries;
}

export function analyzeRepository(
  options: AnalyzeRepositoryOptions = {},
): RepositoryProfile {
  const repoPath = options.repoPath ? resolve(options.repoPath) : process.cwd();
  const excludeDirs = options.excludeDirs ?? [];
  const packageManager = detectPackageManager(repoPath);
  const packageJsonRaw = readJson<{
    name?: string;
    version?: string;
    scripts?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  }>(join(repoPath, "package.json"));

  const dependencies = Object.keys(packageJsonRaw?.dependencies ?? {});
  const devDependencies = Object.keys(packageJsonRaw?.devDependencies ?? {});
  const scripts = packageJsonRaw?.scripts ?? {};
  const isNext = dependencies.includes("next") || devDependencies.includes("next");

  const tsconfig = loadTsconfig(repoPath);
  const roots = discoverSourceRoots(repoPath, options.sourceRoots, excludeDirs);
  const { locations: tests, filePaths: testFilePaths } = discoverTests(
    repoPath,
    roots,
    options.testPatterns ?? DEFAULT_TEST_PATTERNS,
    excludeDirs,
  );
  const workflows = discoverWorkflows(repoPath);
  const configFiles = discoverConfigFiles(repoPath, excludeDirs);
  const entryPoints = classifyEntryPoints(
    repoPath,
    isNext,
    roots,
    excludeDirs,
  );

  const testFileCount = testFilePaths.length;
  const lockfile =
    packageManager === "npm"
      ? "package-lock.json"
      : packageManager === "yarn"
        ? "yarn.lock"
        : packageManager === "pnpm"
          ? "pnpm-lock.yaml"
          : packageManager === "bun"
            ? (existsSync(join(repoPath, "bun.lockb")) ? "bun.lockb" : "bun.lock")
            : undefined;

  const nextConfigFile = findConfig(repoPath, "next.config");

  return {
    packageManager,
    packageJson: {
      name: packageJsonRaw?.name,
      version: packageJsonRaw?.version,
      scripts,
      dependencies,
      devDependencies,
    },
    lockfile,
    tsconfig,
    nextConfig: {
      exists: !!nextConfigFile,
      file: nextConfigFile,
    },
    sourceRoots: roots,
    tests,
    testFilePaths,
    workflows,
    configFiles,
    pathAliases: tsconfig?.pathAliases ?? [],
    entryPoints,
    stats: {
      sourceFiles: roots.length,
      testFiles: testFileCount,
      workflowFiles: workflows.length,
      configFiles: configFiles.length,
    },
  };
}
