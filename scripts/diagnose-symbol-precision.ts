/**
 * Of the tests reached THROUGH a barrel, how many actually consume the changed symbol?
 *
 * Pre-registered at docs/symbol-precision-preregistration.md, written before this file existed.
 * This is an OFFLINE DIAGNOSTIC. It changes no selection behaviour, produces no selector, and does not
 * re-run the frozen Vue economics, which remain the baseline.
 *
 * THE FAIL-CLOSED RULE, fixed in advance and load-bearing:
 *
 *     UNRESOLVED STAYS SELECTED.
 *
 * Three quantities are reported strictly separately, with D + A + U = the selection size:
 *
 *     D  DEMONSTRATED  a file in the test's dependency closure references the changed symbol
 *     A  ABSENT        no reference found AND nothing in the closure defeated the analysis
 *     U  UNRESOLVED    something in the closure the analysis could not resolve
 *
 * The opportunity estimate may use ONLY `A`. Reporting `selection - D` as removable would silently
 * convert every unresolved case into opportunity, which is the single easiest way to overstate this
 * result. Absence of evidence is not evidence of absence, and here the two differ in exactly the
 * direction that flatters the finding.
 *
 * WHY REFERENCE RATHER THAN IMPORT. A file is counted as DEMONSTRATED if it references the symbol at
 * all, not only if it imports it by name. That is deliberately generous toward DEMONSTRATED: it
 * over-counts genuine dependency and therefore under-counts the opportunity. The conservative direction
 * is the one that cannot manufacture a result.
 *
 * Usage:
 *   npm run diagnose:symbols -- --repo <clone> --commit <sha> --changed <file> [--out <file.json>]
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { buildDependencyGraph } from "../src/repo/graph.js";
import type { DependencyGraph } from "../src/repo/types.js";
import { execBounded } from "./process-exec.js";

const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build"];

/** Constructs this analysis cannot follow. Their presence in a closure forces UNRESOLVED. */
const UNRESOLVABLE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "star-import", re: /import\s+\*\s+as\s+\w+\s+from/ },
  { name: "dynamic-import", re: /\bimport\s*\(/ },
  { name: "require", re: /\brequire\s*\(/ },
  { name: "aliased-reexport", re: /export\s*\{[^}]*\bas\b[^}]*\}\s*from/ },
];

/** Exported identifiers of a source file, from its `export` declarations. */
function exportedSymbols(source: string): string[] {
  const names = new Set<string>();
  for (const m of source.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var|class|enum|interface|type)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]!);
  }
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name);
    }
  }
  return [...names];
}

/** Files reachable FROM `start` by following dependency edges - the closure the selector traversed. */
function dependencyClosure(graph: DependencyGraph, start: string): Set<string> {
  const out = new Map<string, string[]>();
  for (const e of graph.edges) {
    const list = out.get(e.from) ?? [];
    list.push(e.to);
    out.set(e.from, list);
  }
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const next of out.get(cur) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = args.indexOf(`--${n}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const repoPath = resolve(flag("repo") ?? "");
  const commit = flag("commit") ?? "";
  const changedFile = flag("changed") ?? "";
  if (!existsSync(repoPath) || !commit || !changedFile) throw new Error("--repo, --commit and --changed are required");

  execBounded("git", ["checkout", "--quiet", "--force", commit], { cwd: repoPath, timeoutMs: 120_000 });

  const changedSource = readFileSync(join(repoPath, changedFile), "utf8");
  const symbols = exportedSymbols(changedSource);
  if (symbols.length === 0) throw new Error(`no exported symbols found in ${changedFile}`);

  // The selection under test comes from the frozen trace artifact, not recomputed here, so the
  // diagnostic explains the same 183 files the economics measured.
  const traces = JSON.parse(readFileSync(resolve("docs/evidence/vue-selection-traces.json"), "utf8")) as {
    results: Array<{ headSha?: string; selectedCount?: number; traces?: Array<{ file: string }> }>;
  };
  const target = traces.results.find((r) => r.headSha === commit);
  if (!target?.traces) throw new Error(`no frozen trace for ${commit}`);
  const selected = target.traces.map((t) => t.file);

  console.log(`\n  commit        ${commit.slice(0, 9)}`);
  console.log(`  changed file  ${changedFile}`);
  console.log(`  symbols       ${symbols.join(", ")}`);
  console.log(`  selection     ${selected.length} test files (frozen)\n`);

  const graphResultPromise = buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });

  void graphResultPromise.then((graphResult) => {
    const graph = graphResult.graph;
    const symbolRe = new RegExp(`\\b(${symbols.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`);

    // Read each file once; a closure of hundreds of files is walked per test.
    const cache = new Map<string, { references: boolean; unresolvable: string[] } | null>();
    const inspect = (file: string): { references: boolean; unresolvable: string[] } | null => {
      if (cache.has(file)) return cache.get(file)!;
      let src: string;
      try {
        src = readFileSync(join(repoPath, file), "utf8");
      } catch {
        cache.set(file, null); // unreadable - itself an unresolved condition
        return null;
      }
      const unresolvable = UNRESOLVABLE_PATTERNS.filter((p) => p.re.test(src)).map((p) => p.name);

      // THE DEFINING FILE AND ITS RE-EXPORTERS ARE NOT CONSUMERS (2026-08-30).
      //
      // A first version of this diagnostic scanned every file in the closure and returned
      // DEMONSTRATED 183 / ABSENT 0 / UNRESOLVED 0 - a tautology, not a finding. The changed file is in
      // every closure BY CONSTRUCTION, since being reachable from it is exactly why those tests were
      // selected, and it defines the symbols it exports. A barrel that re-exports it contains the
      // identifier textually for the same non-reason.
      //
      // The question is whether some CONSUMER uses the symbol, so the definition site is skipped and
      // `export ... from` lines are stripped before scanning. A file that both re-exports and genuinely
      // uses the symbol still counts, because only the re-export lines are removed.
      if (file === changedFile) {
        const entry = { references: false, unresolvable };
        cache.set(file, entry);
        return entry;
      }
      const withoutReexports = src.replace(/export\s*(?:\*|\{[^}]*\})\s*(?:as\s+\w+\s*)?from\s*['"][^'"]+['"]/g, "");
      const entry = { references: symbolRe.test(withoutReexports), unresolvable };
      cache.set(file, entry);
      return entry;
    };

    const demonstrated: string[] = [];
    const absent: string[] = [];
    const unresolved: Array<{ file: string; why: string[] }> = [];

    for (const test of selected) {
      const closure = dependencyClosure(graph, test);
      let references = false;
      const why = new Set<string>();
      for (const f of closure) {
        const info = inspect(f);
        if (info === null) {
          why.add(`unreadable:${f}`);
          continue;
        }
        if (info.references) {
          references = true;
          break; // DEMONSTRATED outranks everything; no need to keep looking
        }
        for (const u of info.unresolvable) why.add(u);
      }
      if (references) demonstrated.push(test);
      else if (why.size > 0) unresolved.push({ file: test, why: [...why].slice(0, 4) });
      else absent.push(test);
    }

    const D = demonstrated.length;
    const A = absent.length;
    const U = unresolved.length;

    const result = {
      producedAt: new Date().toISOString(),
      commit,
      changedFile,
      symbols,
      selectionSize: selected.length,
      graph: { nodes: graph.nodes.length, edges: graph.edges.length },
      counts: { DEMONSTRATED: D, ABSENT: A, UNRESOLVED: U, sum: D + A + U },
      /** The ONLY quantity the pre-registration permits as an opportunity estimate. */
      fileOpportunityUpperBound: A,
      note:
        "fileOpportunityUpperBound counts ABSENT files ONLY. selectionSize - DEMONSTRATED is NOT the " +
        "opportunity: that would convert every UNRESOLVED case into opportunity. No CPU figure is " +
        "attributed here - per-file execution cost was not measured, and manufacturing it from file " +
        "counts is forbidden by the pre-registration.",
      demonstrated,
      absent,
      unresolved,
    };

    const out = flag("out");
    if (out) writeFileSync(resolve(out), `${JSON.stringify(result, null, 2)}\n`);

    console.log(`  DEMONSTRATED  ${String(D).padStart(4)}   a file in the closure references ${symbols.join("/")}`);
    console.log(`  ABSENT        ${String(A).padStart(4)}   no reference, and nothing defeated the analysis`);
    console.log(`  UNRESOLVED    ${String(U).padStart(4)}   analysis could not resolve the closure`);
    console.log(`  ${"-".repeat(46)}`);
    console.log(`  sum           ${String(D + A + U).padStart(4)}   (selection ${selected.length})\n`);
    console.log(`  file opportunity UPPER BOUND = ${A}  (ABSENT only; never ${selected.length} - ${D})`);
    console.log(`  no CPU opportunity is reported: per-file execution cost was not measured.\n`);

    if (U > 0) {
      const reasons = new Map<string, number>();
      for (const u of unresolved) for (const w of u.why) reasons.set(w.split(":")[0]!, (reasons.get(w.split(":")[0]!) ?? 0) + 1);
      console.log("  why unresolved:");
      for (const [r, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${r}`);
      console.log("");
    }
  });
}

main();
