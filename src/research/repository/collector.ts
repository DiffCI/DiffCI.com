import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ResearchRepository, RepositoryMetadata } from "../types.js";

export function runGit(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr?.trim() || result.stdout?.trim() || "unknown"}`);
  }
  return result.stdout;
}

export function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

export function repoLocalPath(cacheDir: string, repo: ResearchRepository): string {
  return resolve(cacheDir, `${repo.owner}--${repo.name}`);
}

/** Fast-path exclusion for a repository whose language DiffCI's graph engine can never analyze,
 * skipping the clone entirely. Real finding, larger-study run 2026-08-20: pallets/flask took 210
 * seconds and spf13/cobra took 42 seconds just to clone+walk before being excluded on language alone
 * (both correctly excluded either way - the exclusion decision never depended on anything the clone
 * would reveal), and junit-team/junit5 (a large repo) timed out entirely at 240s doing the same wasted
 * work. Checking repo.primaryLanguage - already known from the corpus config, no clone needed - avoids
 * burning real Cloudflare compute/bandwidth and timeout risk on repositories that were always going to
 * be excluded regardless of what the clone contained. */
export function isKnownUnsupportedLanguage(primaryLanguage: string): boolean {
  return primaryLanguage !== "typescript" && primaryLanguage !== "javascript";
}

export function unsupportedLanguageMetadata(repo: ResearchRepository, cacheDir: string): RepositoryMetadata {
  const reason = `DiffCI graph parser does not yet support ${repo.primaryLanguage}`;
  return {
    ...buildMetadata(repo, repoLocalPath(cacheDir, repo)),
    languageSupport: { diffciGraphCapable: false, reason },
    exclusionReason: `DiffCI cannot analyze this repository: ${reason}`,
  };
}

export function cloneOrUpdateRepo(repo: ResearchRepository, cacheDir: string, depth: number): RepositoryMetadata {
  if (isKnownUnsupportedLanguage(repo.primaryLanguage)) {
    return unsupportedLanguageMetadata(repo, cacheDir);
  }

  const localPath = repoLocalPath(cacheDir, repo);
  ensureDir(dirname(localPath));

  if (!existsSync(resolve(localPath, ".git"))) {
    const cloneUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
    const result = spawnSync("git", ["clone", "--depth", String(depth), "--filter=blob:none", "--no-single-branch", cloneUrl, localPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.status !== 0) {
      return buildMetadata(repo, localPath, `clone failed: ${result.stderr?.trim() || result.stdout?.trim() || "unknown"}`);
    }
  } else {
    try {
      runGit(["fetch", "--depth", String(depth), "--force", "origin", repoMetadataDefaultBranch(localPath) || "HEAD:refs/heads/fetch-tmp"], localPath);
      const defaultBranch = runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], localPath).replace("origin/", "").trim();
      if (defaultBranch) {
        runGit(["reset", "--hard", `origin/${defaultBranch}`], localPath);
      }
    } catch (error: unknown) {
      return buildMetadata(repo, localPath, `fetch failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return collectMetadata(repo, localPath);
}

function repoMetadataDefaultBranch(localPath: string): string | undefined {
  try {
    return runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], localPath).replace("origin/", "").trim();
  } catch {
    return undefined;
  }
}

export function collectMetadata(repo: ResearchRepository, localPath: string): RepositoryMetadata {
  const metadata = buildMetadata(repo, localPath);
  try {
    metadata.defaultBranch = runGit(["rev-parse", "--abbrev-ref", "origin/HEAD"], localPath).replace("origin/", "").trim();
  } catch {
    metadata.defaultBranch = "main";
  }

  try {
    const countStr = runGit(["rev-list", "--count", "HEAD"], localPath).trim();
    metadata.commitCount = Number.parseInt(countStr, 10) || 0;
  } catch {
    metadata.commitCount = 0;
  }

  const { sourceFiles, workflowFiles, sizeMb } = countRepoFiles(localPath);
  metadata.sourceFiles = sourceFiles;
  metadata.workflowFiles = workflowFiles;
  // Deliberately root-only, NOT a recursive search of the whole tree, and NOT a replica of
  // createProgram()'s ts.findConfigFile() upward-past-the-repo-root walk (src/repo/graph.ts).
  // ts.findConfigFile(repoRoot, ...) starts its search AT repoRoot and walks UP toward the filesystem
  // root - it never descends into subdirectories. A first version of this check walked the whole repo
  // tree looking for any tsconfig.json anywhere, which produced a real false negative live: fastify
  // (and several other real corpus repos) have a tsconfig.json nested in an examples/ or fixtures/
  // subdirectory that ts.findConfigFile() will never see, so they were reported as graph-capable and
  // then failed every single sampled commit anyway ("No tsconfig.json found in ..."). Checking only
  // localPath/tsconfig.json matches what createProgram() actually looks at first and is the only
  // environment-independent thing to check (unlike the upward walk, which risks accidentally finding an
  // ANCESTOR tsconfig.json outside the repo entirely when repos are cloned to a path nested inside
  // diffci/ itself, as they are in local runs - a separate, still-unfixed latent bug in graph.ts, not
  // this repository-scoped check).
  const hasTsconfig = existsSync(resolve(localPath, "tsconfig.json"));
  const isTsOrJs = repo.primaryLanguage === "typescript" || repo.primaryLanguage === "javascript";
  if (!isTsOrJs) {
    metadata.languageSupport = { diffciGraphCapable: false, reason: `DiffCI graph parser does not yet support ${repo.primaryLanguage}` };
  } else if (!hasTsconfig) {
    // Real finding, 2026-08-20 small batch: lukeed/kleur (plain JS, no tsconfig.json anywhere in the
    // repo) made every single sampled commit fail outright inside createProgram() ("No tsconfig.json
    // found in ..."), producing zero records and zero fallback rather than an explicit, reported
    // exclusion - a silent gap, not a safe failure mode.
    metadata.languageSupport = { diffciGraphCapable: false, reason: "no tsconfig.json found at the repository root" };
  } else {
    metadata.languageSupport = { diffciGraphCapable: true, reason: "DiffCI graph parser supports TS/JS source" };
  }

  // Every path above that leaves diffciGraphCapable false represents a repository createProgram() will
  // always fail against (no tsconfig.json to build a ts.Program from, for ANY language, not just JS
  // without one) - exclude it here, before clone-sampling/analysis is attempted, rather than letting
  // every single sampled commit fail individually with the same underlying cause. This also covers the
  // non-JS/TS corpus languages (Python/Go/Rust/Java), which were silently hitting the identical
  // "No tsconfig.json found" failure per-commit before this fix - diffciGraphCapable was computed but
  // never actually consulted anywhere in the analysis path.
  if (sizeMb > 1024) {
    metadata.exclusionReason = `repository disk size ${sizeMb.toFixed(0)} MB exceeds 1 GB limit`;
  } else if (sourceFiles > 5000) {
    metadata.exclusionReason = `source file count ${sourceFiles} exceeds 5000 limit`;
  } else if (!metadata.languageSupport.diffciGraphCapable) {
    metadata.exclusionReason = `DiffCI cannot analyze this repository: ${metadata.languageSupport.reason}`;
  }

  return metadata;
}

function buildMetadata(repo: ResearchRepository, localPath: string, exclusionReason?: string): RepositoryMetadata {
  return {
    repository: `${repo.owner}/${repo.name}`,
    cloneUrl: `https://github.com/${repo.owner}/${repo.name}.git`,
    localPath,
    primaryLanguage: repo.primaryLanguage,
    framework: repo.framework,
    sizeClass: repo.sizeClass,
    license: "unknown",
    defaultBranch: "main",
    commitCount: 0,
    sourceFiles: 0,
    workflowFiles: 0,
    languageSupport: { diffciGraphCapable: false, reason: "not evaluated" },
    exclusionReason,
  };
}

function isSourceFile(path: string): boolean {
  return /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(path);
}

function countRepoFiles(localPath: string): { sourceFiles: number; workflowFiles: number; sizeMb: number } {
  let sourceFiles = 0;
  let workflowFiles = 0;
  let totalSize = 0;
  const ignored = new Set([".git", "node_modules", ".next", "dist", "build", "coverage", "target", ".venv"]);

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".github") continue;
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        if (ignored.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile()) {
        const rel = full.slice(localPath.length + 1).replace(/\\/g, "/");
        if (isSourceFile(rel)) sourceFiles++;
        if (rel.startsWith(".github/workflows/") && /\.(ya?ml)$/.test(rel)) workflowFiles++;
        try {
          totalSize += statSync(full).size;
        } catch {}
      }
    }
  }

  walk(localPath);
  return { sourceFiles, workflowFiles, sizeMb: totalSize / (1024 * 1024) };
}
