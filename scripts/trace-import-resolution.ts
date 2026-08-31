/**
 * Why one unmapped import did not become a graph edge, traced end to end.
 *
 * The density survey found 20 of 28 measured repositories under 20% test-to-production mapping, but
 * that band mixes at least three unrelated causes. Before any resolver is changed, this classifies a
 * representative failure per repository along the chain the user specified:
 *
 *   test -> import specifier -> package/workspace identity -> package.json exports/main
 *        -> expected source target -> DiffCI resolution result
 *
 * IT CHANGES NOTHING. It reads the repository and the graph the current analyser produces, and reports
 * where the chain breaks. Whether that is one generic defect or several unrelated ones is the question;
 * answering it by patching first would destroy the evidence.
 *
 * Usage: npm run trace:imports -- --repo <clone> [--max 3]
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

interface WorkspacePackage {
  name: string;
  dir: string;
  main?: unknown;
  module?: unknown;
  types?: unknown;
  exports?: unknown;
  /** Fields some monorepos use to point tooling at source rather than build output. */
  sourceFields: Record<string, unknown>;
}

/** Every package.json in the tree, so a bare specifier can be tested against workspace identity. */
function findWorkspacePackages(root: string, limit = 4000): WorkspacePackage[] {
  const out: WorkspacePackage[] = [];
  const stack = [root];
  const skip = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "fixtures", "__fixtures__"]);
  let seen = 0;
  while (stack.length > 0 && seen < limit) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    seen += 1;
    if (entries.includes("package.json")) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
        if (typeof pkg.name === "string") {
          const sourceFields: Record<string, unknown> = {};
          for (const key of ["source", "sourceRoot", "publishConfig", "bolt", "typesVersions"]) {
            if (pkg[key] !== undefined) sourceFields[key] = pkg[key];
          }
          out.push({
            name: pkg.name,
            dir: dir.slice(root.length + 1).replace(/\\/g, "/"),
            main: pkg.main,
            module: pkg.module,
            types: pkg.types,
            exports: pkg.exports,
            sourceFields,
          });
        }
      } catch {
        // A malformed package.json is itself worth nothing here; skip it.
      }
    }
    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      try {
        if (statSync(full).isDirectory()) stack.push(full);
      } catch {
        // unreadable
      }
    }
  }
  return out;
}

const SPECIFIER = /(?:^|\n)\s*(?:import\s[^;'"]*from\s*|import\s*|export\s[^;'"]*from\s*)['"]([^'"]+)['"]|require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function specifiersOf(text: string): string[] {
  const out = new Set<string>();
  for (const match of text.matchAll(SPECIFIER)) {
    const spec = match[1] ?? match[2];
    if (spec) out.add(spec);
  }
  return [...out];
}

const BUILTIN = /^(node:|assert|buffer|child_process|crypto|events|fs|http|https|os|path|stream|url|util|zlib|module)/;

function classify(spec: string, workspaceNames: Set<string>): string {
  if (spec.startsWith(".")) return "relative";
  if (BUILTIN.test(spec)) return "node-builtin";
  if (workspaceNames.has(spec)) return "WORKSPACE PACKAGE (declared in this repository)";
  const scopeRoot = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  if (workspaceNames.has(scopeRoot)) return `WORKSPACE PACKAGE SUBPATH (root "${scopeRoot}" is in this repository)`;
  return "external dependency";
}

function main(): void {
  const args = process.argv.slice(2);
  const flagOf = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const repoPath = resolve(flagOf("repo") ?? "");
  if (!flagOf("repo")) throw new Error("--repo <clone> is required");
  const max = Number(flagOf("max") ?? 3);

  void (async () => {
    const { buildDependencyGraph } = await import("../src/repo/graph.js");
    const result = await buildDependencyGraph({ repoPath, excludeDirs: ["node_modules", ".git", "dist", "build", "coverage"] });
    const graph = result.graph;
    const isTest = new Map<string, boolean>(graph.nodes.map((n: { path: string; isTest: boolean }) => [n.path, n.isTest === true]));
    const nodePaths = new Set(graph.nodes.map((n: { path: string }) => n.path));

    const packages = findWorkspacePackages(repoPath);
    const workspaceNames = new Set(packages.map((p) => p.name));

    console.log(`\n  IMPORT RESOLUTION TRACE`);
    console.log(`  repo:              ${repoPath}`);
    console.log(`  graph nodes        ${graph.nodes.length}`);
    console.log(`  graph edges        ${graph.edges.length}`);
    console.log(`  package.json found ${packages.length}  (workspace package names available to a resolver)`);
    if (packages.length > 0) {
      console.log(`  sample packages:`);
      for (const p of packages.slice(0, 6)) console.log(`     ${p.name.padEnd(42)} ${p.dir || "."}  main=${JSON.stringify(p.main)}`);
    }

    // Tests that import something yet reach no production file: the population the survey counted as 0%.
    const unmapped = graph.nodes
      .filter((n: { isTest: boolean }) => n.isTest === true)
      .filter((n: { path: string }) => graph.dependenciesOf(n.path).filter((p: string) => isTest.get(p) === false).length === 0)
      .filter((n: { path: string }) => {
        try {
          return specifiersOf(readFileSync(join(repoPath, n.path), "utf8")).length > 0;
        } catch {
          return false;
        }
      });

    console.log(`\n  test nodes with imports but NO production edge: ${unmapped.length}\n`);

    for (const node of unmapped.slice(0, max)) {
      const text = readFileSync(join(repoPath, node.path), "utf8");
      const specs = specifiersOf(text);
      console.log(`  ${"=".repeat(76)}`);
      console.log(`  TEST  ${node.path}`);
      console.log(`  graph dependenciesOf() -> ${JSON.stringify(graph.dependenciesOf(node.path))}`);
      console.log("");
      for (const spec of specs.slice(0, 8)) {
        const kind = classify(spec, workspaceNames);
        console.log(`    specifier            ${spec}`);
        console.log(`      classification     ${kind}`);
        if (kind.startsWith("WORKSPACE")) {
          const root = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
          const pkg = packages.find((p) => p.name === spec) ?? packages.find((p) => p.name === root)!;
          console.log(`      package dir        ${pkg.dir || "."}`);
          console.log(`      main               ${JSON.stringify(pkg.main)}`);
          console.log(`      module             ${JSON.stringify(pkg.module)}`);
          console.log(`      exports            ${JSON.stringify(pkg.exports)?.slice(0, 160) ?? "undefined"}`);
          if (Object.keys(pkg.sourceFields).length > 0) console.log(`      source fields      ${JSON.stringify(pkg.sourceFields).slice(0, 160)}`);
          const candidates = [pkg.main, pkg.module, "src/index.ts", "src/index.js", "index.ts", "index.js"]
            .filter((c): c is string => typeof c === "string")
            .map((c) => posix.normalize(posix.join(pkg.dir, c.replace(/^\.\//, ""))));
          const present = candidates.filter((c) => existsSync(join(repoPath, c)));
          console.log(`      expected target    ${present.length > 0 ? present[0] : "(none of " + candidates.slice(0, 3).join(", ") + " exists in source)"}`);
          if (present.length > 0) {
            console.log(`      target in graph    ${nodePaths.has(present[0]!) ? "YES" : "NO"}`);
            console.log(`      edge test->target  ${graph.dependenciesOf(node.path).includes(present[0]!) ? "YES" : "NO  <- resolution gap"}`);
          }
        } else if (kind === "relative") {
          const target = posix.normalize(posix.join(posix.dirname(node.path), spec));
          const tried = [target, `${target}.ts`, `${target}.js`, `${target}.tsx`, `${target}/index.ts`, `${target}/index.js`, target.replace(/\.js$/, ".ts")];
          const present = tried.filter((t) => existsSync(join(repoPath, t)));
          console.log(`      expected target    ${present.length > 0 ? present[0] : "(no source file - " + target + " is absent, likely generated)"}`);
          if (present.length > 0) {
            console.log(`      target in graph    ${nodePaths.has(present[0]!) ? "YES" : "NO"}`);
            console.log(`      edge test->target  ${graph.dependenciesOf(node.path).includes(present[0]!) ? "YES" : "NO  <- resolution gap"}`);
          }
        }
        console.log("");
      }
    }
    console.log(`  ${"=".repeat(76)}\n`);
  })();
}

main();
