import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildDependencyGraph } from "../src/repo/graph.js";
import type { DependencyGraph } from "../src/repo/types.js";
import { resolveDentalPresenceRepoPath } from "./target-repo.js";

const repoPath = resolveDentalPresenceRepoPath();

function pickRepresentatives(graph: DependencyGraph) {
  const nodes = graph.nodes.map((n) => n.path);

  function first(pattern: RegExp, excludeTest = true): string | undefined {
    return nodes.find((p) => {
      if (!pattern.test(p)) return false;
      return !excludeTest || !/\.(test|spec)\./.test(p);
    });
  }

  const component = first(/src\/components\/.*\.tsx$/, true);
  const page = first(/src\/app\/.*\bpage\.tsx$/, true);
  const apiRoute = first(/src\/app\/api\/.*\broute\.ts$/, true);
  const sharedLib = first(/src\/lib\/auth\/[^/]+\.ts$/, true);
  const deepUtility = first(/src\/lib\/infrastructure\/[^/]+\/[^/]+\.ts$/, true);
  const featureModule = first(/src\/app\/\(app\)\/.*\.tsx$/, true);
  const test = first(/src\/.*\.test\.tsx?$/, false);
  const reExportFile = graph.edges.find((e) => e.kind === "re-export")?.from;

  const dynamicFile = graph.edges.find((e) => e.kind === "dynamic-import")?.from;
  const typeFile = graph.edges.find((e) => e.kind === "type-import")?.from;
  const dynamicEdge = graph.edges.find((e) => e.kind === "dynamic-import");
  const typeEdge = graph.edges.find((e) => e.kind === "type-import");
  const reExportEdge = graph.edges.find((e) => e.kind === "re-export");

  return {
    component,
    page,
    apiRoute,
    sharedLib,
    deepUtility,
    featureModule,
    test,
    reExportFile,
    dynamicFile,
    dynamicEdge: dynamicEdge ? { from: dynamicEdge.from, to: dynamicEdge.to } : undefined,
    typeFile,
    typeEdge: typeEdge ? { from: typeEdge.from, to: typeEdge.to } : undefined,
    reExportEdge: reExportEdge ? { from: reExportEdge.from, to: reExportEdge.to } : undefined,
  };
}

async function main() {
  const result = await buildDependencyGraph({
    repoPath,
    excludeDirs: ["node_modules", ".next", "dist", "build"],
  });

  const {
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
  } = result;

  const edgeKindCounts: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgeKindCounts[edge.kind] = (edgeKindCounts[edge.kind] ?? 0) + 1;
  }

  const dynamicUnresolved = unresolved.filter((u) => u.dynamic);
  const internalEdges = graph.edges.length - internalAssetEdges;

  const unresolvedBySpecifier = new Map<string, number>();
  const unresolvedByReason = new Map<string, number>();
  for (const u of unresolved) {
    if (!u.specifier.startsWith(".") && !u.specifier.startsWith("/")) {
      const key = u.specifier.split("/")[0] ?? u.specifier;
      unresolvedBySpecifier.set(key, (unresolvedBySpecifier.get(key) ?? 0) + 1);
    }
    unresolvedByReason.set(u.reason, (unresolvedByReason.get(u.reason) ?? 0) + 1);
  }

  const representatives = pickRepresentatives(graph);

  const representativeQueries = Object.entries(representatives)
    .filter(([, value]) => value !== undefined)
    .map(([category, value]) => {
      if (typeof value === "string") {
        return {
          category,
          file: value,
          directDependencies: graph.dependenciesOf(value),
          directDependents: graph.dependentsOf(value),
          transitiveDependents: graph.transitiveDependentsOf(value),
        };
      }
      return { category, ...value };
    });

  const report = {
    profile: {
      packageManager: profile.packageManager,
      packageName: profile.packageJson.name,
      sourceRoots: profile.sourceRoots,
      pathAliases: profile.pathAliases,
      nextConfig: profile.nextConfig,
    },
    statistics: {
      filesDiscovered: performance.filesDiscovered,
      filesParsed: performance.filesParsed,
      internalSourceFiles: graph.nodes.filter((n) => n.isSource).length,
      internalAssetFiles: graph.nodes.filter((n) => n.isAsset).length,
      internalSourceEdges: internalEdges,
      internalAssetEdges,
      externalPackageReferences: externalReferences,
      platformBuiltinReferences,
      resolutionCounts: counts,
      unresolvedImports: unresolved.length,
      dynamicUnresolvedImports: dynamicUnresolved.length,
      barrelReExportEdges: edgeKindCounts["re-export"] ?? 0,
      typeOnlyEdges: edgeKindCounts["type-import"] ?? 0,
      dynamicImportEdges: edgeKindCounts["dynamic-import"] ?? 0,
      requireEdges: edgeKindCounts["require"] ?? 0,
      testFiles: graph.nodes.filter((n) => n.isTest).length,
      nextJsEntryPoints: profile.entryPoints.filter((e) =>
        e.kind.startsWith("next-"),
      ).length,
      entryPointKinds: Object.fromEntries(
        Object.entries(
          profile.entryPoints.reduce<Record<string, number>>((acc, e) => {
            acc[e.kind] = (acc[e.kind] ?? 0) + 1;
            return acc;
          }, {}),
        ).sort(([a], [b]) => a.localeCompare(b)),
      ),
    },
    performance: {
      durationMs: Math.round(performance.durationMs * 1000) / 1000,
      heapUsedMb: performance.heapUsedMb,
    },
    confidence,
    integrity: {
      criticalCount: integrity.criticalCount,
      warningCount: integrity.warningCount,
      stats: integrity.stats,
      findings: integrity.findings.slice(0, 50),
    },
    unresolvedAudit: {
      byReason: Object.fromEntries(
        Array.from(unresolvedByReason.entries()).sort((a, b) => b[1] - a[1]),
      ),
      bySpecifierPrefix: Object.fromEntries(
        Array.from(unresolvedBySpecifier.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 20),
      ),
      sample: unresolved.slice(0, 20),
      all: unresolved,
    },
    referencesByResolution: {
      internalSource: references.filter((r) => r.resolution === "internal-source").length,
      internalAsset: references.filter((r) => r.resolution === "internal-asset").length,
      externalPackage: references.filter((r) => r.resolution === "external-package").length,
      platformBuiltin: references.filter((r) => r.resolution === "platform-builtin").length,
      unresolved: references.filter((r) => r.resolution === "unresolved").length,
    },
    representativeQueries,
  };

  // Was resolve(repoPath, "diffci", "graph-audit.json") - that assumed a diffci/ subfolder existed
  // inside the target repo to write into, which no longer applies now that diffci/ has been fully
  // removed from DentalPresence.in. Written under the target repo's own .diffci/ state directory instead
  // (already gitignored there, same convention .diffci/shadow and .diffci/cache already use).
  const outPath = resolve(repoPath, ".diffci", "graph-audit.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});