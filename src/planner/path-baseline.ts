import type { ChangedFile } from "../git/types.js";

export interface PathBaselineResult {
  strategy: "PATH_BASELINE";
  selectedTests: string[];
  fallbackRequired: boolean;
  fallbackReasons: string[];
  matchedRules: string[];
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

export function runPathBaseline(
  allTestPaths: string[],
  changedFiles: ChangedFile[],
): PathBaselineResult {
  const changedPaths = changedFiles.map((f) => toPosix(f.path));
  const matchedRules: string[] = [];

  const docsOnly = changedPaths.every(
    (p) =>
      p.endsWith(".md") ||
      p.endsWith(".mdx") ||
      p.startsWith("docs/") ||
      p.startsWith("README"),
  );
  if (docsOnly) {
    matchedRules.push("docs-only -> skip tests");
    return {
      strategy: "PATH_BASELINE",
      selectedTests: [],
      fallbackRequired: false,
      fallbackReasons: [],
      matchedRules,
    };
  }

  if (changedPaths.some((p) => p === "package.json" || p === "package-lock.json" || /^(yarn\.lock|pnpm-lock\.yaml|bun\.lockb?)$/.test(p))) {
    matchedRules.push("config/dependency -> full fallback");
    return {
      strategy: "PATH_BASELINE",
      selectedTests: allTestPaths,
      fallbackRequired: true,
      fallbackReasons: ["config/dependency change triggers full fallback"],
      matchedRules,
    };
  }

  if (changedPaths.some((p) => p.startsWith(".github/workflows/"))) {
    matchedRules.push("workflow change -> full fallback");
    return {
      strategy: "PATH_BASELINE",
      selectedTests: allTestPaths,
      fallbackRequired: true,
      fallbackReasons: ["workflow change triggers full fallback"],
      matchedRules,
    };
  }

  if (changedPaths.some((p) => p.startsWith("database/"))) {
    matchedRules.push("database -> full fallback");
    return {
      strategy: "PATH_BASELINE",
      selectedTests: allTestPaths,
      fallbackRequired: true,
      fallbackReasons: ["database change triggers full fallback"],
      matchedRules,
    };
  }

  if (changedPaths.some((p) => p.startsWith("ops/") || p.startsWith("terraform/") || p.startsWith("docker") || p.includes("Dockerfile"))) {
    matchedRules.push("infrastructure -> full fallback");
    return {
      strategy: "PATH_BASELINE",
      selectedTests: allTestPaths,
      fallbackRequired: true,
      fallbackReasons: ["infrastructure change triggers full fallback"],
      matchedRules,
    };
  }

  const selected = new Set<string>();

  if (changedPaths.some((p) => p.startsWith("src/"))) {
    matchedRules.push("src/** -> all source tests");
    for (const test of allTestPaths) {
      if (test.startsWith("src/")) selected.add(test);
    }
  }

  if (changedPaths.some((p) => p.startsWith("scripts/"))) {
    matchedRules.push("scripts/** -> all script validations + script tests");
    for (const test of allTestPaths) {
      if (test.startsWith("scripts/")) selected.add(test);
    }
  }

  if (changedPaths.some((p) => p.startsWith("ops/"))) {
    matchedRules.push("ops/** -> all ops tests");
    for (const test of allTestPaths) {
      if (test.startsWith("ops/")) selected.add(test);
    }
  }

  if (selected.size === 0) {
    matchedRules.push("no matching path rule -> run all tests");
    return {
      strategy: "PATH_BASELINE",
      selectedTests: allTestPaths,
      fallbackRequired: true,
      fallbackReasons: ["unmatched changed paths"],
      matchedRules,
    };
  }

  return {
    strategy: "PATH_BASELINE",
    selectedTests: Array.from(selected),
    fallbackRequired: false,
    fallbackReasons: [],
    matchedRules,
  };
}
