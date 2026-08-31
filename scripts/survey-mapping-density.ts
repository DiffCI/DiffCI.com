/**
 * Test-to-production connectivity across the frozen 40, measured in the canonical environment.
 *
 * WHY. Prettier selected zero tests not because reachability failed - 5 changed files reached 105
 * affected source files - but because 1,419 of its 1,464 test files contain no `import` or `require`
 * at all. Its tests call a global (`runFormatTest`) injected through jest's `setupFiles`, so no static
 * edge from test to source exists or can be inferred. A file-level import graph cannot map them.
 *
 * That makes test-to-production static connectivity a candidate ICP variable, and the question is
 * whether Prettier is an architectural outlier or the norm. This measures it.
 *
 * TWO DENSITIES, AND THE SECOND MATTERS MORE.
 *
 *   importDensity  = tests containing any static import or require / test files
 *   mappingDensity = test nodes that can reach a production node / test nodes
 *
 * A test can import `vitest` and `./fixture.js` and thereby count as "has imports" while offering no
 * path to production code at all. Only the second density is DiffCI's actual applicability condition.
 * Both direct edges and transitive reachability are reported, because a test that reaches production
 * only through a helper is still mappable.
 *
 * NO INSTALL. Graph construction reads the repository's own sources, so this needs a clone and nothing
 * else - which is what makes forty repositories cheap enough to measure at all.
 *
 * Usage:
 *   npm run survey:density -- --frame <frame.json> --out <dir> [--work <dir>]
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { ALREADY_EXAMINED, repositorySlugFromFacts } from "./survey-density-helpers.js";

interface Frame {
  source: string;
  sourcePublished: string;
  ranks: string[];
}

export interface DensityRow {
  rank: number;
  packageName: string;
  repository: string | null;
  headSha?: string;
  /** Why this repository produced no density, when it produced none. */
  status:
    | "MEASURED"
    | "EXCLUDED_ALREADY_EXAMINED"
    | "EXCLUDED_NO_REPOSITORY"
    | "ANALYZER_INELIGIBLE"
    | "NO_TESTS_DISCOVERED"
    | "CLONE_FAILED"
    | "ERROR";
  reason?: string;

  framework?: string;
  testFiles?: number;
  graphNodes?: number;
  graphEdges?: number;

  /** Tests whose file text contains any static import or require. */
  testsWithStaticImports?: number;
  importDensity?: number;

  /** Test nodes with at least one direct edge to a non-test node. */
  testsWithDirectProductionEdge?: number;
  /** Test nodes that reach a non-test node through any number of edges. */
  testsReachingProduction?: number;
  mappingDensity?: number;
  /** Total edges from a test node to a non-test node. */
  testToProductionEdges?: number;

  /** Evidence of the pattern Prettier exhibits: a runner injected through framework setup. */
  setupFilesConfigured?: boolean;
  globalRunnerSuspected?: boolean;
}

const STATIC_IMPORT = /(^|\n)\s*(import\s|export\s+[^=]*\sfrom\s|const\s+[^=]*=\s*require\s*\(|require\s*\()/;

function main(): void {
  const args = process.argv.slice(2);
  const flagOf = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };
  const framePath = resolve(flagOf("frame") ?? "docs/evidence/survey/frame-ranks-1-40.json");
  const outDir = resolve(flagOf("out") ?? "density-out");
  const workDir = resolve(flagOf("work") ?? join(outDir, "clones"));
  mkdirSync(outDir, { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const frame = JSON.parse(readFileSync(framePath, "utf8")) as Frame;
  console.log(`\n  TEST-TO-PRODUCTION CONNECTIVITY`);
  console.log(`  frame: ${frame.source}`);
  console.log(`  entries: ${frame.ranks.length}\n`);

  void (async () => {
    const { classifyTypeScriptProject, buildDependencyGraph } = await import("../src/repo/graph.js");
    const rows: DensityRow[] = [];

    for (let i = 0; i < frame.ranks.length; i++) {
      const rank = i + 1;
      const packageName = frame.ranks[i]!;
      const row: DensityRow = { rank, packageName, repository: null, status: "ERROR" };

      try {
        const repository = await repositorySlugFromFacts(packageName);
        row.repository = repository;
        if (!repository) {
          row.status = "EXCLUDED_NO_REPOSITORY";
        } else if (ALREADY_EXAMINED.has(repository)) {
          row.status = "EXCLUDED_ALREADY_EXAMINED";
          row.reason = "examined before the survey";
        } else {
          const clonePath = join(workDir, `r${rank}`);
          if (!existsSync(clonePath)) {
            execFileSync("git", ["clone", "--quiet", "--depth", "1", `https://github.com/${repository}.git`, clonePath], {
              stdio: "pipe",
              timeout: 15 * 60_000,
            });
          }
          row.headSha = execFileSync("git", ["-C", clonePath, "rev-parse", "HEAD"], { encoding: "utf8", timeout: 60_000 }).trim();

          const capability = classifyTypeScriptProject(clonePath);
          if (!capability.capable) {
            row.status = "ANALYZER_INELIGIBLE";
            row.reason = capability.reason;
          } else {
            const result = await buildDependencyGraph({ repoPath: clonePath, excludeDirs: ["node_modules", ".git", "dist", "build", "coverage"] });
            const graph = result.graph;
            const profile = result.profile;
            row.framework = (profile as { framework?: string }).framework ?? "unknown";
            row.graphNodes = graph.nodes.length;
            row.graphEdges = graph.edges.length;
            row.testFiles = profile.testFilePaths.length;

            if (graph.nodes.length === 0 || profile.testFilePaths.length === 0) {
              row.status = "NO_TESTS_DISCOVERED";
            } else {
              const isTest = new Map<string, boolean>(graph.nodes.map((n: { path: string; isTest: boolean }) => [n.path, n.isTest === true]));
              const testNodes = graph.nodes.filter((n: { isTest: boolean }) => n.isTest === true);

              // Import density, straight from the file text.
              let withImports = 0;
              for (const node of testNodes) {
                try {
                  if (STATIC_IMPORT.test(readFileSync(join(clonePath, node.path), "utf8"))) withImports += 1;
                } catch {
                  // Unreadable file counts as no imports rather than dropping the test from the denominator.
                }
              }
              row.testsWithStaticImports = withImports;
              row.importDensity = testNodes.length === 0 ? 0 : withImports / testNodes.length;

              // Mapping density. Direct first, then transitive - a test reaching production only through
              // a shared helper is still mappable, and conflating the two would understate the product.
              let directCount = 0;
              let productionEdges = 0;
              let reaching = 0;
              for (const node of testNodes) {
                const direct = graph.dependenciesOf(node.path).filter((p: string) => isTest.get(p) === false);
                productionEdges += direct.length;
                if (direct.length > 0) directCount += 1;
                const transitive = graph.transitiveDependenciesOf(node.path);
                if (transitive.some((p: string) => isTest.get(p) === false)) reaching += 1;
              }
              row.testsWithDirectProductionEdge = directCount;
              row.testToProductionEdges = productionEdges;
              row.testsReachingProduction = reaching;
              row.mappingDensity = testNodes.length === 0 ? 0 : reaching / testNodes.length;

              // The Prettier pattern, recorded as evidence rather than inferred from the density.
              const configText = ["jest.config.js", "jest.config.ts", "jest.config.mjs", "vitest.config.ts", "vitest.config.js", "package.json"]
                .map((f) => {
                  try {
                    return readFileSync(join(clonePath, f), "utf8");
                  } catch {
                    return "";
                  }
                })
                .join("\n");
              row.setupFilesConfigured = /setupFiles|globalSetup|setupFilesAfterEnv/.test(configText);
              row.globalRunnerSuspected = row.setupFilesConfigured === true && (row.mappingDensity ?? 1) < 0.2;

              row.status = "MEASURED";
            }
          }
        }
      } catch (error) {
        row.status = row.repository ? "CLONE_FAILED" : "ERROR";
        row.reason = error instanceof Error ? error.message.slice(0, 300) : String(error);
      }

      rows.push(row);
      const density = row.mappingDensity === undefined ? "-" : `${(row.mappingDensity * 100).toFixed(1)}%`;
      const imports = row.importDensity === undefined ? "-" : `${(row.importDensity * 100).toFixed(1)}%`;
      console.log(
        `  ${String(rank).padStart(2)}. ${packageName.padEnd(30)} ${(row.repository ?? "-").padEnd(34)} ` +
          `${row.status.padEnd(26)} tests ${String(row.testFiles ?? "-").padStart(6)}  import ${imports.padStart(7)}  mapping ${density.padStart(7)}`,
      );
      writeFileSync(join(outDir, "density-rows.json"), `${JSON.stringify(rows, null, 2)}\n`);
    }

    const measured = rows.filter((r) => r.status === "MEASURED");
    const band = (lo: number, hi: number): number => measured.filter((r) => (r.mappingDensity ?? 0) >= lo && (r.mappingDensity ?? 0) < hi).length;

    const summary = {
      frame: { source: frame.source, entries: frame.ranks.length },
      producedAt: new Date().toISOString(),
      chain: {
        frameEntries: frame.ranks.length,
        excluded: rows.filter((r) => r.status.startsWith("EXCLUDED_")).length,
        analyzerIneligible: rows.filter((r) => r.status === "ANALYZER_INELIGIBLE").length,
        noTestsDiscovered: rows.filter((r) => r.status === "NO_TESTS_DISCOVERED").length,
        failed: rows.filter((r) => r.status === "CLONE_FAILED" || r.status === "ERROR").length,
        measured: measured.length,
      },
      mappingDensityBands: {
        "0-20%": band(0, 0.2),
        "20-40%": band(0.2, 0.4),
        "40-60%": band(0.4, 0.6),
        "60-80%": band(0.6, 0.8),
        "80-100%": band(0.8, 1.0001),
      },
      note:
        "mappingDensity is test nodes that can reach a non-test node through the static import graph, " +
        "divided by test nodes. It is DiffCI's actual applicability condition; importDensity is reported " +
        "alongside because a test can import a fixture and still offer no path to production code.",
      rows,
    };
    writeFileSync(join(outDir, "density-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`\n  CHAIN`);
    for (const [k, v] of Object.entries(summary.chain)) console.log(`    ${k.padEnd(22)} ${v}`);
    console.log(`\n  MAPPING DENSITY BANDS (measured repositories only)`);
    for (const [k, v] of Object.entries(summary.mappingDensityBands)) console.log(`    ${k.padEnd(10)} ${v}`);
    console.log("");
  })();
}

main();
