import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRepositoryConfig } from "@diffci.com/core/repo/repo-config";

export interface FullCommandDecision {
  command?: string;
  reason: string;
}

/** Preserve the repository's TypeScript test loader for selected node:test files. */
export function inferSelectedCommand(repoPath: string, proposed: string, selectedTests: readonly string[]): FullCommandDecision {
  if (!/^node --test(?:\s|$)/.test(proposed) || !selectedTests.some(path => /\.(?:ts|tsx|mts|cts)$/.test(path))) {
    return { command: proposed, reason: "DiffCI proposed command" };
  }
  const packagePath = join(repoPath, "package.json");
  if (!existsSync(packagePath)) return { reason: "TypeScript tests require a declared test loader" };
  let script: unknown;
  try { script = JSON.parse(readFileSync(packagePath, "utf8")).scripts?.test; }
  catch { return { reason: "package.json could not be read" }; }
  if (typeof script !== "string") return { reason: "TypeScript tests require a declared test script" };
  const runners = [...script.matchAll(/\btsx(?:\s+--conditions\s+[\w,-]+)?\s+--test\b/g)];
  if (runners.length !== 1) return { reason: "Cannot identify one TypeScript node:test runner in the test script" };
  return {
    command: proposed.replace(/^node --test/, `npx --no-install ${runners[0][0]}`),
    reason: "TypeScript node:test runner from package.json test script",
  };
}

/** Choose the repository's conventional full test command without executing anything. */
export function inferFullCommand(repoPath: string): FullCommandDecision {
  if (existsSync(join(repoPath, "pom.xml"))) {
    const config = readRepositoryConfig(repoPath);
    if (config.configurationError) return { reason: `DiffCI configuration error: ${config.configurationError}` };
    const goal = config.maven?.goal ?? "test";
    const profiles = config.maven?.profiles?.length ? ` -P ${config.maven.profiles.join(",")}` : "";
    return {
      command: `mvn${profiles} ${goal}`,
      reason: config.maven ? "Maven goal and profiles from DiffCI configuration" : "Maven default goal: test; confirm this matches CI",
    };
  }

  const packagePath = join(repoPath, "package.json");
  if (existsSync(packagePath)) {
    let pkg: { scripts?: { test?: unknown }; packageManager?: unknown };
    try { pkg = JSON.parse(readFileSync(packagePath, "utf8")); }
    catch { return { reason: "package.json could not be read" }; }
    if (typeof pkg.scripts?.test !== "string" || !pkg.scripts.test.trim()) {
      return { reason: "package.json has no test script" };
    }
    const manager = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
    if (manager === "pnpm" || manager === "yarn" || manager === "bun") {
      return { command: `${manager} test`, reason: `package.json test script via ${manager}` };
    }
    if (manager && manager !== "npm") return { reason: `unsupported package manager: ${manager}` };
    if (existsSync(join(repoPath, "pnpm-lock.yaml"))) return { command: "pnpm test", reason: "package.json test script with pnpm lockfile" };
    if (existsSync(join(repoPath, "yarn.lock"))) return { command: "yarn test", reason: "package.json test script with Yarn lockfile" };
    if (existsSync(join(repoPath, "bun.lock")) || existsSync(join(repoPath, "bun.lockb"))) return { command: "bun test", reason: "package.json test script with Bun lockfile" };
    return { command: "npm test", reason: "package.json test script" };
  }

  if (existsSync(join(repoPath, "go.mod"))) return { command: "go test ./...", reason: "root Go module" };
  return { reason: "no supported full test command could be inferred" };
}
