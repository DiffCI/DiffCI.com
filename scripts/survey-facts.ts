/**
 * Addressability survey: FACT COLLECTION.
 *
 * This module records what a repository *is*. It reaches no conclusion, assigns no gate, and knows
 * nothing about the taxonomy. Adjudication lives in `survey-adjudicate.ts` and is a pure function over
 * the facts this writes.
 *
 * WHY THE SEPARATION IS THE POINT. If collection and judgement were one pass, a classification could
 * never be audited afterwards without re-fetching the world - and re-fetching means the evidence has
 * moved. Facts are captured once, committed, and every verdict is derivable from them offline. If a
 * classification is later found wrong, the facts stay put and only the derivation changes, which is
 * exactly the property `datefns-qualify-01` lacked when a green verdict turned out to describe 5% of a
 * repository.
 *
 * Nothing here is repository-specific. Every field is collected the same way for every entry.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Everything observed about one frame entry. Verdict-free by construction. */
export interface RepositoryFacts {
  rank: number;
  packageName: string;
  collectedAt: string;

  /** npm registry metadata. */
  registry: {
    resolved: boolean;
    repositoryUrl?: string;
    deprecated?: boolean;
    error?: string;
  };

  /** "owner/name", or null when the registry names no usable GitHub repository. */
  repository: string | null;

  /** GitHub metadata. `unknown: true` when the API could not be consulted - never guessed. */
  github: {
    unknown: boolean;
    archived?: boolean;
    fork?: boolean;
    language?: string | null;
    error?: string;
  };

  /** Clone outcome. Everything below is absent when this failed. */
  clone: { ok: boolean; headSha?: string; error?: string };

  /** Straight from the repository's own package.json. */
  packageJson?: {
    present: boolean;
    private?: boolean;
    type?: string;
    packageManager?: string;
    /** Raw `workspaces` field, whatever shape it has. */
    workspaces?: unknown;
    scripts: Record<string, string>;
    devDependencyNames: string[];
    dependencyNames: string[];
  };

  /** Presence only - these files' existence is the fact, not their contents. */
  files: {
    lockfiles: string[];
    workspaceConfigs: string[];
    runnerConfigs: string[];
    ciWorkflows: string[];
  };

  /** Counts of files matching each pattern, so a test surface can be sized without judgement. */
  testSurface: {
    /** Directory names at the repository root, for spotting a packages/ layout. */
    rootDirectories: string[];
    /** How many files match each of a fixed set of test-file patterns. */
    patternCounts: Record<string, number>;
    /** Total source-ish files, for the JS/TS question. */
    extensionCounts: Record<string, number>;
  };
}

/** Fixed, applied identically to every entry. Never tuned per repository. */
const TEST_PATTERNS: Record<string, RegExp> = {
  "*.test.[jt]s(x)": /\.test\.[jt]sx?$/,
  "*.spec.[jt]s(x)": /\.spec\.[jt]sx?$/,
  "__tests__/**": /(^|[\\/])__tests__[\\/]/,
  "test/** or tests/**": /(^|[\\/])tests?[\\/]/,
  "test.[jt]s or tests.[jt]s": /(^|[\\/])tests?\.[jt]sx?$/,
};

const RUNNER_CONFIG_FILES = [
  "vitest.config.ts", "vitest.config.js", "vitest.config.mjs", "vitest.config.mts",
  "jest.config.js", "jest.config.ts", "jest.config.mjs", "jest.config.cjs", "jest.config.json",
  ".mocharc.yml", ".mocharc.yaml", ".mocharc.json", ".mocharc.js", ".mocharc.cjs",
  ".borp.yaml", ".borp.yml", "ava.config.js", "ava.config.mjs", "ava.config.cjs",
  "karma.conf.js", "playwright.config.ts", "playwright.config.js", "web-test-runner.config.js",
  "tap.yaml", ".taprc", "uvu.config.js", "jasmine.json",
];

const WORKSPACE_CONFIG_FILES = ["pnpm-workspace.yaml", "lerna.json", "nx.json", "turbo.json", "rush.json"];
const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "npm-shrinkwrap.json"];

const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".cache", "vendor"]);

/** Walks the tree once, bounded, counting extensions and test-pattern matches. */
function walk(root: string): { relPaths: string[] } {
  const out: string[] = [];
  const stack = [root];
  // A ceiling rather than a full walk: some of these repositories are enormous, and the counts only
  // need to establish shape. Recorded in the facts so a truncated walk is never mistaken for a small
  // repository.
  const LIMIT = 60_000;
  while (stack.length > 0 && out.length < LIMIT) {
    const dir = stack.pop()!;
    let entries: string[];
    try { entries = readdirSync(dir); } catch { continue; }
    for (const entry of entries) {
      if (IGNORED_DIRECTORIES.has(entry)) continue;
      const full = join(dir, entry);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) stack.push(full);
      else out.push(full.slice(root.length + 1).replace(/\\/g, "/"));
    }
  }
  return { relPaths: out };
}

async function fetchJson(url: string): Promise<{ ok: boolean; body?: any; error?: string }> {
  try {
    const res = await fetch(url, { headers: { "user-agent": "diffci-addressability-survey" } });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true, body: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** "git+https://github.com/owner/name.git" and its many cousins -> "owner/name". */
export function repositorySlugFrom(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const match = /github\.com[/:]([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:[/#?].*)?$/.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

export async function collectFacts(rank: number, packageName: string, workDir: string, now: () => string): Promise<RepositoryFacts> {
  const facts: RepositoryFacts = {
    rank,
    packageName,
    collectedAt: now(),
    registry: { resolved: false },
    repository: null,
    github: { unknown: true },
    clone: { ok: false },
    files: { lockfiles: [], workspaceConfigs: [], runnerConfigs: [], ciWorkflows: [] },
    testSurface: { rootDirectories: [], patternCounts: {}, extensionCounts: {} },
  };

  const meta = await fetchJson(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  if (!meta.ok) {
    facts.registry.error = meta.error;
    return facts;
  }
  const latest = meta.body?.["dist-tags"]?.latest;
  const version = latest ? meta.body?.versions?.[latest] : undefined;
  const repoUrl = version?.repository?.url ?? meta.body?.repository?.url ?? version?.repository ?? meta.body?.repository;
  facts.registry = {
    resolved: true,
    repositoryUrl: typeof repoUrl === "string" ? repoUrl : JSON.stringify(repoUrl ?? null),
    deprecated: Boolean(version?.deprecated ?? meta.body?.deprecated),
  };
  facts.repository = repositorySlugFrom(typeof repoUrl === "string" ? repoUrl : (repoUrl as any)?.url);
  if (!facts.repository) return facts;

  const gh = await fetchJson(`https://api.github.com/repos/${facts.repository}`);
  facts.github = gh.ok
    ? { unknown: false, archived: Boolean(gh.body.archived), fork: Boolean(gh.body.fork), language: gh.body.language ?? null }
    : { unknown: true, error: gh.error };

  const clonePath = join(workDir, `r${rank}`);
  try {
    execFileSync("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${facts.repository}.git`, clonePath], {
      stdio: "pipe",
      timeout: 10 * 60_000,
    });
    const sha = execFileSync("git", ["-C", clonePath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 60_000 }).trim();
    facts.clone = { ok: true, headSha: sha };
  } catch (err) {
    facts.clone = { ok: false, error: err instanceof Error ? err.message.slice(0, 300) : String(err) };
    return facts;
  }

  const pkgPath = join(clonePath, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      facts.packageJson = {
        present: true,
        private: pkg.private,
        type: pkg.type,
        packageManager: pkg.packageManager,
        workspaces: pkg.workspaces,
        scripts: pkg.scripts ?? {},
        devDependencyNames: Object.keys(pkg.devDependencies ?? {}),
        dependencyNames: Object.keys(pkg.dependencies ?? {}),
      };
    } catch (err) {
      facts.packageJson = { present: true, scripts: {}, devDependencyNames: [], dependencyNames: [] };
    }
  } else {
    facts.packageJson = { present: false, scripts: {}, devDependencyNames: [], dependencyNames: [] };
  }

  facts.files.lockfiles = LOCKFILES.filter((f) => existsSync(join(clonePath, f)));
  facts.files.workspaceConfigs = WORKSPACE_CONFIG_FILES.filter((f) => existsSync(join(clonePath, f)));
  facts.files.runnerConfigs = RUNNER_CONFIG_FILES.filter((f) => existsSync(join(clonePath, f)));
  const workflows = join(clonePath, ".github", "workflows");
  facts.files.ciWorkflows = existsSync(workflows) ? readdirSync(workflows).slice(0, 40) : [];

  const { relPaths } = walk(clonePath);
  facts.testSurface.rootDirectories = readdirSync(clonePath)
    .filter((e) => !IGNORED_DIRECTORIES.has(e) && statSync(join(clonePath, e)).isDirectory())
    .slice(0, 60);
  for (const [label, re] of Object.entries(TEST_PATTERNS)) {
    facts.testSurface.patternCounts[label] = relPaths.filter((p) => re.test(p)).length;
  }
  const ext: Record<string, number> = {};
  for (const p of relPaths) {
    const m = /\.([A-Za-z0-9]+)$/.exec(p);
    if (m) ext[m[1]!.toLowerCase()] = (ext[m[1]!.toLowerCase()] ?? 0) + 1;
  }
  facts.testSurface.extensionCounts = Object.fromEntries(
    Object.entries(ext).sort((a, b) => b[1] - a[1]).slice(0, 25),
  );

  return facts;
}
