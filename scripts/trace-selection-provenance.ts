/**
 * Why did each selected test file enter the selection?
 *
 * vuejs/core produces five distinct selections across sixteen commits - 57, 97, 98, 162, 183 files -
 * and within each bucket the sets are BYTE-IDENTICAL (pairwise Jaccard 1.000, see
 * docs/vue-selection-bucket-analysis.md). A 57-file core is selected on every candidate. The economics
 * are -1163.33 CPU-s incremental, with three candidates costing more than the entire suite.
 *
 * That establishes the regions are real. It says nothing about what pulls them.
 *
 * This traces provenance for each selected file, using the impact analyser's OWN recorded reasons and
 * evidence chains. The selector already knows why it selected each file - `TestImpact.reasons` and
 * `ImpactEvidence.path` - the information simply never reaches the observation report.
 *
 * OBSERVATIONAL ONLY. Nothing about selection behaviour is changed, and no judgement is made here about
 * whether a reason is necessary or unnecessary. Establishing WHY a file was selected and deciding
 * whether it SHOULD have been are two different experiments, and conflating them would let the second
 * quietly rewrite the first.
 *
 * FIDELITY. This calls src/ directly rather than the packaged agent, so it is only meaningful if it
 * reproduces the frozen selection counts. The script asserts that per commit and refuses to emit a
 * trace for any commit whose count does not match what was expected.
 *
 * Usage:
 *   npm run trace:selection -- --repo <clone> --expect <sha>=<count>,... [--out <file.json>]
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { analyzeGitDelta } from "../src/git/git-diff.js";
import { classifyTypeScriptProject, buildDependencyGraph } from "../src/repo/graph.js";
import { ImpactAnalyzer } from "../src/repo/impact.js";
import type { ImpactEvidence, ImpactReason } from "../src/repo/impact-types.js";
import { execBounded } from "./process-exec.js";

/** Exactly what observe.ts uses, so the graph is the one the agent built. */
const EXCLUDE_DIRS = ["node_modules", ".next", "dist", "build"];

interface FileTrace {
  file: string;
  reasons: ImpactReason[];
  /** The causal chains the analyser recorded for this file, changed-file first. */
  chains: Array<{ reason: ImpactReason; changedFile: string; pathKind?: string; path?: string[]; message: string }>;
}

interface CommitTrace {
  headSha: string;
  baseSha: string;
  changedFiles: string[];
  selectedCount: number;
  expectedCount: number;
  countMatches: boolean;
  graph: { nodes: number; edges: number; confidence: string };
  fallbackRequired: boolean;
  reasonHistogram: Record<string, number>;
  /** Files whose only recorded reason is one that widens without a per-file dependency path. */
  filesWithNoDependencyChain: string[];
  traces: FileTrace[];
}

async function traceCommit(repoPath: string, baseSha: string, headSha: string, expectedCount: number): Promise<CommitTrace | { error: string }> {
  execBounded("git", ["checkout", "--quiet", "--force", headSha], { cwd: repoPath, timeoutMs: 120_000 });

  const capability = classifyTypeScriptProject(repoPath);
  if (!capability.capable) return { error: `not analysable: ${capability.reason}` };

  const deltaResult = await analyzeGitDelta({ baseSha, headSha, repoPath });
  if (!deltaResult.success) return { error: `delta failed: ${deltaResult.error}` };
  const delta = deltaResult.delta;

  const graphResult = await buildDependencyGraph({ repoPath, excludeDirs: EXCLUDE_DIRS });
  const profile = graphResult.profile;
  const impact = new ImpactAnalyzer().analyze(delta, graphResult, profile, { repositoryFiles: deltaResult.inventory?.files });

  const evidenceByFile = new Map<string, ImpactEvidence[]>();
  for (const e of impact.evidence) {
    if (!e.affectedFile) continue;
    const list = evidenceByFile.get(e.affectedFile) ?? [];
    list.push(e);
    evidenceByFile.set(e.affectedFile, list);
  }

  const reasonHistogram: Record<string, number> = {};
  const filesWithNoDependencyChain: string[] = [];
  const traces: FileTrace[] = impact.affectedTests.map((t) => {
    for (const r of t.reasons) reasonHistogram[r] = (reasonHistogram[r] ?? 0) + 1;
    const chains = (evidenceByFile.get(t.path) ?? t.evidence ?? []).map((e) => ({
      reason: e.reason,
      changedFile: e.changedFile,
      pathKind: e.path?.pathKind,
      path: e.path?.path,
      message: e.message,
    }));
    // A file with no recorded path is not necessarily wrongly selected - ALWAYS_RUN_POLICY and the
    // GLOBAL reasons legitimately have none. Recorded, not judged.
    if (!chains.some((c) => Array.isArray(c.path) && c.path.length > 0)) filesWithNoDependencyChain.push(t.path);
    return { file: t.path, reasons: t.reasons, chains };
  });

  return {
    headSha,
    baseSha,
    changedFiles: delta.files.map((f) => f.path),
    selectedCount: impact.affectedTests.length,
    expectedCount,
    countMatches: impact.affectedTests.length === expectedCount,
    graph: { nodes: graphResult.graph.nodes.length, edges: graphResult.graph.edges.length, confidence: String(graphResult.confidence) },
    fallbackRequired: impact.fallbackRequired,
    reasonHistogram,
    filesWithNoDependencyChain,
    traces,
  };
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (n: string): string | undefined => {
    const i = args.indexOf(`--${n}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const repoPath = resolve(flag("repo") ?? "");
  if (!existsSync(repoPath)) throw new Error("--repo <clone> is required");

  // `<headSha>=<expectedSelectedCount>` pairs. The expectation is what makes this a fidelity check
  // rather than a fresh measurement.
  const expect = (flag("expect") ?? "").split(",").filter(Boolean).map((pair) => {
    const [sha, count] = pair.split("=");
    return { sha: sha!, count: Number(count) };
  });
  if (expect.length === 0) throw new Error("--expect <sha>=<count>,... is required");

  const results: Array<CommitTrace | { headSha: string; error: string }> = [];
  for (const { sha, count } of expect) {
    const parent = execBounded("git", ["rev-parse", `${sha}^`], { cwd: repoPath, timeoutMs: 60_000 }).out.trim();
    process.stdout.write(`  tracing ${sha.slice(0, 9)} (expect ${count}) ... `);
    const r = await traceCommit(repoPath, parent, sha, count);
    if ("error" in r) {
      process.stdout.write(`ERROR ${r.error}\n`);
      results.push({ headSha: sha, error: r.error });
      continue;
    }
    process.stdout.write(`${r.selectedCount} selected  ${r.countMatches ? "MATCHES" : "*** MISMATCH ***"}\n`);
    results.push(r);
  }

  const traced = results.filter((r): r is CommitTrace => !("error" in r));
  const mismatched = traced.filter((r) => !r.countMatches);

  const out = flag("out");
  if (out) writeFileSync(resolve(out), `${JSON.stringify({ producedAt: new Date().toISOString(), repoPath, results }, null, 2)}\n`);

  console.log(`\n  traced ${traced.length}, count mismatches ${mismatched.length}\n`);
  if (mismatched.length > 0) {
    console.log("  MISMATCH: src/ does not reproduce the frozen selection counts. The trace does NOT");
    console.log("  explain the frozen Vue result and must not be interpreted as if it does.\n");
    process.exitCode = 1;
    return;
  }

  for (const r of traced) {
    console.log(`  ${r.headSha.slice(0, 9)}  selected=${r.selectedCount}  changed=${r.changedFiles.length}  graph=${r.graph.nodes}n/${r.graph.edges}e  conf=${r.graph.confidence}  fallback=${r.fallbackRequired}`);
    const hist = Object.entries(r.reasonHistogram).sort((a, b) => b[1] - a[1]);
    for (const [reason, n] of hist) console.log(`      ${String(n).padStart(4)}  ${reason}`);
    console.log(`      files with no recorded dependency chain: ${r.filesWithNoDependencyChain.length}`);
    console.log("");
  }
}

void main();
