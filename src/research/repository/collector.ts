import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { classifyTypeScriptProject } from "../../repo/graph.js";
import type { ResearchRepository, RepositoryMetadata } from "../types.js";

/**
 * Git authentication for PRIVATE repositories (2026-08-21, first hit by the DiffCI Shadow App
 * dogfood: adityankale190895/DiffCI.com is private, and the anonymous-clone path below failed with
 * "clone failed" on the very first webhook-triggered self-poll). When GITHUB_CLONE_TOKEN is set in
 * the process environment (the Worker passes an App installation token via exec's env option - never
 * a CLI arg, same rule as GITHUB_TOKEN in cloudflare-analyze-batch.ts), every git subprocess gets an
 * `http.<github>.extraheader` Authorization header injected via GIT_CONFIG_* environment variables.
 * The token therefore never appears in argv, in any URL, or in git's stderr (which buildMetadata
 * copies into error strings) - the actions/checkout approach, not the token-in-URL one.
 * GIT_TERMINAL_PROMPT=0 makes an auth failure fail fast instead of waiting on a prompt that can
 * never be answered inside a container.
 */
export function gitAuthEnv(cloneToken: string | undefined = process.env.GITHUB_CLONE_TOKEN): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (!cloneToken) return base;
  const basic = Buffer.from(`x-access-token:${cloneToken}`).toString("base64");
  return {
    ...base,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: basic ${basic}`,
  };
}

export function runGit(args: string[], cwd: string, maxBuffer = 64 * 1024 * 1024): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer, env: gitAuthEnv() });
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

export function cloneOrUpdateRepo(repo: ResearchRepository, cacheDir: string, depth: number, options?: { blobFilter?: boolean }): RepositoryMetadata {
  if (isKnownUnsupportedLanguage(repo.primaryLanguage)) {
    return unsupportedLanguageMetadata(repo, cacheDir);
  }

  const localPath = repoLocalPath(cacheDir, repo);
  ensureDir(dirname(localPath));

  if (!existsSync(resolve(localPath, ".git"))) {
    const cloneUrl = `https://github.com/${repo.owner}/${repo.name}.git`;
    // --filter=blob:none defers blob downloads to on-demand "lazy fetches" by whatever git process
    // later touches a missing blob. Real finding (2026-08-21, DiffCI.com self-shadow): those lazy
    // fetches run OUTSIDE this module's gitAuthEnv() - analyzeGitDelta's own git subprocesses hit
    // "could not read Username for 'https://github.com'" on a PRIVATE repo and the delta analysis
    // failed, while public repos lazily fetched fine anonymously (why unjs/* never showed this).
    // Callers analyzing arbitrary later git state on possibly-private repos (the shadow poll) pass
    // blobFilter:false for a full-blob shallow clone; the default keeps the bandwidth-saving filter
    // for the public-corpus research paths.
    const filterArgs = options?.blobFilter === false ? [] : ["--filter=blob:none"];
    const result = spawnSync("git", ["clone", "--depth", String(depth), ...filterArgs, "--no-single-branch", cloneUrl, localPath], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      env: gitAuthEnv(),
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
  // Phase 01 F3 (2026-08-26): ask the graph builder itself what it can handle instead of restating a
  // rule beside it. The paragraph above describes the ROOT-ONLY check this used to perform, and why
  // an upward findConfigFile walk was the wrong thing to mirror. Both concerns are now settled inside
  // classifyTypeScriptProject(), which never walks above the repository root and does recognise the
  // nested per-package layouts graph.ts has supported since 2026-08-24. Refusing those cost roughly
  // 144 container launches a day on vitest-dev/vitest, for repositories that then built 2000-node
  // graphs when the refusal was bypassed.
  const project = classifyTypeScriptProject(localPath);
  const isTsOrJs = repo.primaryLanguage === "typescript" || repo.primaryLanguage === "javascript";
  if (!isTsOrJs) {
    metadata.languageSupport = { diffciGraphCapable: false, reason: `DiffCI graph parser does not yet support ${repo.primaryLanguage}` };
  } else if (!project.capable) {
    // Real finding, 2026-08-20 small batch: lukeed/kleur (plain JS, no tsconfig.json anywhere in the
    // repo) made every single sampled commit fail outright inside createProgram() ("No tsconfig.json
    // found in ..."), producing zero records and zero fallback rather than an explicit, reported
    // exclusion - a silent gap, not a safe failure mode. That case is still excluded; a monorepo with
    // per-package tsconfigs is not the same case and is no longer treated as one.
    metadata.languageSupport = { diffciGraphCapable: false, reason: project.reason };
  } else {
    metadata.languageSupport = {
      diffciGraphCapable: true,
      reason:
        project.kind === "root"
          ? "DiffCI graph parser supports TS/JS source"
          : `DiffCI graph parser supports TS/JS source (${project.reason}; graph confidence is capped at PARTIAL for this layout)`,
    };
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
