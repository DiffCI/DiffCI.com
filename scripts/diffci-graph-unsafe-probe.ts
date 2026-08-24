/**
 * Diagnostic (2026-08-23, deepseek-harness Phase 5): for a commit pair, explain WHY the dependency
 * graph's per-delta confidence is UNSAFE. Lists every unresolved import that is reachable from the
 * changed files (the exact set refineConfidenceForDelta() considers) and buckets it by general cause.
 * Read-only: never installs or executes the target repository. Usage:
 *   npx tsx scripts/diffci-graph-unsafe-probe.ts --repo <path> --base <sha> --head <sha>
 */
import { resolve } from "node:path";
import { analyzeGitDelta } from "../src/git/git-diff.js";
import { buildDependencyGraph } from "../src/repo/graph.js";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build", ".git"];

type Cause = "workspace-package" | "external-package" | "relative-missing" | "path-alias" | "dynamic-import" | "non-ts-extension" | "other";

function bucket(specifier: string, dynamic: boolean, reason: string, aliases: readonly string[]): Cause {
  if (dynamic) return "dynamic-import";
  if (specifier.startsWith(".") || specifier.startsWith("/")) {
    if (/\.(json|yaml|yml|wasm|css|md|txt|node|sh|py)$/i.test(specifier)) return "non-ts-extension";
    return "relative-missing";
  }
  if (aliases.some((a) => specifier === a || specifier.startsWith(a.replace(/\*$/, "")))) return "path-alias";
  if (specifier.startsWith("@") && /^@[^/]+\/[^/]+/.test(specifier) && /workspace|internal/i.test(reason)) return "workspace-package";
  if (specifier.startsWith("@") || /^[a-z]/.test(specifier)) return "external-package";
  return "other";
}

async function main() {
  const args = process.argv.slice(2);
  const get = (k: string) => { const i = args.indexOf(k); return i === -1 ? undefined : args[i + 1]; };
  const repoPath = resolve(get("--repo")!); const base = get("--base")!; const head = get("--head")!;
  const git = await analyzeGitDelta({ repoPath, baseSha: base, headSha: head });
  if (!git.success) throw new Error(git.error);
  const g = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });
  const changed = git.delta.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path]));
  const reach = new Set<string>(changed);
  for (const f of changed) { for (const d of g.graph.transitiveDependenciesOf(f)) reach.add(d); for (const d of g.graph.transitiveDependentsOf(f)) reach.add(d); }
  const aliases = g.profile.pathAliases.map((a: any) => a.pattern ?? a.alias ?? "").filter(Boolean);
  const relevant = g.unresolved.filter((u) => reach.has(u.importer));
  const byCause: Record<string, number> = {}; const samples: Record<string, string[]> = {};
  for (const u of relevant) { const c = bucket(u.specifier, u.dynamic, u.reason, aliases); byCause[c] = (byCause[c] ?? 0) + 1; (samples[c] ??= []).length < 4 && samples[c]!.push(`${u.importer} -> ${u.specifier} (${u.reason})`); }
  const importerIsChanged = relevant.filter((u) => changed.includes(u.importer)).length;
  console.log(JSON.stringify({ head: head.slice(0, 10), rawConfidence: g.confidence, integrityCritical: g.integrity.criticalCount, sourceFiles: g.graph.nodes.filter((n) => n.isSource).length, unresolvedTotal: g.unresolved.length, unresolvedRelevant: relevant.length, importerIsChangedFile: importerIsChanged, byCause, samples, resolvedViaProjectReferences: g.resolvedViaProjectReferences }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
