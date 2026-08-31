/*
 * The agent is installed by dogfood-observe's OWN installAgent, imported rather than reimplemented.
 * A second copy of that logic could drift from it, and the duplicate glob matcher deleted on
 * 2026-08-30 is what that costs: two implementations of one idea, one of them wrong for months.
 * Reusing it also means the bytes under test here are the same packaged tarball, with the same
 * integrity assertion, that every other observation in this project has run.
 */

/**
 * Observe an EXPLICIT list of commit pairs, rather than N commits derived from HEAD.
 *
 * MECHANISM_PROOF_01 sealed five specific ts-jest pairs at `07bc3d1`. The existing observation pass
 * derives its candidates from `git log`, which would observe a different set - so this exists to
 * execute the sealed draw faithfully. It is infrastructure for running the pre-registered experiment,
 * NOT a change to it: the pairs are read from a file and used verbatim, and nothing here selects,
 * filters, reorders or substitutes a candidate.
 *
 * Same agent binary, same `observe` invocation and same `execBounded` meter as `dogfood-observe`, so
 * the analysis CPU it reports is comparable with every other arm this project has measured.
 *
 * IT MUTATES NOTHING and executes no test suite.
 *
 * Usage:
 *   npm run observe:pairs -- --repo <clone> --pairs <pairs.json> --out <corpus.jsonl>
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { installAgent } from "./dogfood-observe.js";
import { execBounded } from "./process-exec.js";

interface Pair {
  index: number;
  base: string;
  head: string;
  subject?: string;
  implementationFiles?: string[];
  changedTestFiles?: string[];
}

interface PairsFile {
  repository: string;
  pinnedTree: string;
  sealedAt: string;
  pairs: Pair[];
}

function flagOf(args: string[], key: string): string | undefined {
  const i = args.indexOf(`--${key}`);
  return i !== -1 ? args[i + 1] : undefined;
}

function main(): void {
  const args = process.argv.slice(2);
  const repoPath = resolve(flagOf(args, "repo") ?? "");
  const pairsPath = resolve(flagOf(args, "pairs") ?? "");
  const outPath = resolve(flagOf(args, "out") ?? "named-pairs-corpus.jsonl");
  if (!flagOf(args, "repo") || !flagOf(args, "pairs")) throw new Error("--repo <clone> and --pairs <pairs.json> are required");

  const spec = JSON.parse(readFileSync(pairsPath, "utf8")) as PairsFile;
  const agent = installAgent();
  const reportDir = join(resolve(flagOf(args, "reports") ?? "named-pairs-reports"));
  mkdirSync(reportDir, { recursive: true });

  console.log(`\n  OBSERVATION OVER A SEALED CANDIDATE LIST`);
  console.log(`  repository   ${spec.repository}`);
  console.log(`  pinned tree  ${spec.pinnedTree}`);
  console.log(`  sealed at    ${spec.sealedAt}`);
  console.log(`  agent        ${agent.version}  ${agent.integrity.slice(0, 26)}...`);
  console.log(`  pairs        ${spec.pairs.length}   -- used VERBATIM, none selected or substituted\n`);

  const rows: unknown[] = [];
  for (const pair of spec.pairs) {
    const reportPath = join(reportDir, `${pair.head.slice(0, 12)}.json`);

    // The agent analyses the tree as checked out, so the worktree has to move to the candidate's head.
    const checkout = spawnSync("git", ["checkout", "--quiet", "--force", pair.head], { cwd: repoPath, encoding: "utf8" });
    const notes: string[] = [];
    if (checkout.status !== 0) notes.push(`checkout failed: ${(checkout.stderr ?? "").trim().split("\n")[0]}`);

    const run = execBounded(process.execPath, [agent.bin, "observe", "--repo", repoPath, "--base", pair.base, "--head", pair.head, "--out", reportPath], {
      timeoutMs: 15 * 60_000,
    });
    if (run.status !== 0) notes.push(`agent exited ${String(run.status)}`);

    let report: Record<string, any> = {};
    if (existsSync(reportPath)) {
      try {
        report = JSON.parse(readFileSync(reportPath, "utf8"));
      } catch (err) {
        notes.push(`report is not valid JSON: ${(err as Error).message.slice(0, 120)}`);
      }
    } else {
      notes.push("agent wrote no report");
    }

    const result = (report.result ?? {}) as Record<string, any>;
    const selected: string[] = Array.isArray(result.selectedTests) ? result.selectedTests : [];
    const total: number | undefined = typeof result.totalTestCount === "number" ? result.totalTestCount : undefined;

    // The classification the stop rule turns on. SELECTIVE with an empty set is NOT the same outcome as
    // SELECTIVE with work in it, and collapsing them is how a null result would look like a positive.
    let classification: string;
    if (report.status !== "OBSERVED") classification = report.status === "REFUSED" ? "REFUSED" : String(report.status ?? "ERROR");
    else if (result.mode === "FULL") classification = "FULL";
    else classification = selected.length > 0 ? "SELECTIVE-nonempty" : "SELECTIVE-empty";

    // Direct-change vs production-impact. A test DiffCI selects because that very file was edited
    // proves nothing about the dependency graph; a test reached through changed production code does.
    const changedTests = new Set(pair.changedTestFiles ?? []);
    const direct = selected.filter((p) => changedTests.has(p));
    const throughImpact = selected.filter((p) => !changedTests.has(p));

    const row = {
      index: pair.index,
      repository: spec.repository,
      base: pair.base,
      head: pair.head,
      subject: pair.subject,
      implementationFiles: pair.implementationFiles ?? [],
      changedTestFiles: pair.changedTestFiles ?? [],
      classification,
      stage: report.stage,
      reason: report.reason ?? result.fallbackReasons,
      selectedCount: selected.length,
      totalTestCount: total,
      selectedDirectlyChanged: direct.length,
      selectedThroughProductionImpact: throughImpact.length,
      selectedTests: selected,
      comparatorSelected: result.pathBaseline?.selectedTestCount,
      analysisCpuSeconds: run.cpuSeconds,
      analysisWallMs: run.ms,
      graph: result.graph,
      analysisStatus: result.analysisStatus,
      notes,
    };
    rows.push(row);

    console.log(
      `  ${String(pair.index).padStart(2)}. ${pair.head.slice(0, 9)}  ${classification.padEnd(20)} ` +
        `selected ${String(selected.length).padStart(4)}/${String(total ?? "?").padEnd(5)} ` +
        `direct ${String(direct.length).padStart(3)}  impact ${String(throughImpact.length).padStart(3)}  ` +
        `cpu ${run.cpuSeconds === undefined ? "?" : run.cpuSeconds.toFixed(2)}s  wall ${(run.ms / 1000).toFixed(1)}s`,
    );
    if (notes.length > 0) console.log(`      notes: ${notes.join(" | ")}`);
  }

  writeFileSync(outPath, `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);

  const nonEmpty = rows.filter((r: any) => r.classification === "SELECTIVE-nonempty").length;
  const counts: Record<string, number> = {};
  for (const r of rows as any[]) counts[r.classification] = (counts[r.classification] ?? 0) + 1;
  console.log(`\n  CLASSIFICATION`);
  for (const [k, v] of Object.entries(counts)) console.log(`    ${k.padEnd(22)} ${v}`);
  console.log(`\n  SELECTIVE-nonempty: ${nonEmpty} of ${rows.length}`);
  console.log(
    nonEmpty === 0
      ? `\n  STOP. The sealed rule ends MECHANISM_PROOF_01 here: no threshold change, no other commit,\n  no move to another repository, and NOTHING is mutated.\n`
      : `\n  Observation complete. Mutation is a SEPARATE decision and is not taken here.\n`,
  );
  console.log(`  written to ${outPath}\n`);
}

main();
