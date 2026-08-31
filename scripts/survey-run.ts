/**
 * Addressability survey: ORCHESTRATION.
 *
 * Walks the frozen frame in rank order, collects facts, adjudicates gates 1-4, and writes the funnel.
 * Designed to run unattended inside the canonical Linux container so the survey does not depend on any
 * interactive session staying alive.
 *
 * IT NEVER STOPS EARLY AND NEVER SKIPS. Every rank in the frame is visited, including those already
 * known to be excluded, so the denominator chain stays intact:
 *
 *   40 frame entries -> exclusions -> survey-eligible -> gate outcomes
 *
 * A rank whose collection throws is recorded `SURVEY_ERROR` and the walk continues. One bad repository
 * must not be able to truncate the sample, because a truncated sample looks exactly like a completed
 * one once the numbers are written down.
 *
 * Facts are written before adjudication runs, so a later dispute about a classification can be settled
 * from committed evidence without re-fetching anything.
 *
 * Usage:
 *   npm run survey -- --frame docs/evidence/survey/frame-ranks-1-40.json --out <dir> [--work <dir>]
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { adjudicate, measureRunnerCapabilities, type Adjudication } from "./survey-adjudicate.js";
import { collectFacts, type RepositoryFacts } from "./survey-facts.js";

interface Frame {
  source: string;
  sourcePublished: string;
  ranks: string[];
  /** True rank of ranks[0], minus one. A continuation frame starting at rank 41 sets 40, so the
   * recorded ranks remain the frame own numbering rather than restarting at 1. */
  rankOffset?: number;
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const framePath = resolve(flag("frame") ?? "docs/evidence/survey/frame-ranks-1-40.json");
  const outDir = resolve(flag("out") ?? "survey-out");
  const workDir = resolve(flag("work") ?? join(outDir, "clones"));
  mkdirSync(join(outDir, "facts"), { recursive: true });
  mkdirSync(workDir, { recursive: true });

  const frame = JSON.parse(readFileSync(framePath, "utf8")) as Frame;
  console.log(`\n  ADDRESSABILITY SURVEY`);
  console.log(`  frame: ${frame.source} (published ${frame.sourcePublished})`);
  console.log(`  entries: ${frame.ranks.length}\n`);

  // Recorded once, at the top, so the run carries the apparatus's measured capability rather than a
  // claim about it. If a parser ever changes, this block changes with it.
  const capabilities = measureRunnerCapabilities();
  console.log("  RUNNER CAPABILITY, measured through the real parsers");
  for (const c of capabilities) {
    console.log(
      `    ${c.runner.padEnd(12)} failure count ${(c.failureCountReadable ? "yes" : "no").padEnd(4)}` +
        `  file count ${(c.fileCountReadable ? "yes" : "no").padEnd(4)}  -> ${c.supported ? "SUPPORTED" : "unsupported"}`,
    );
  }
  console.log("");

  const adjudications: Adjudication[] = [];

  void (async () => {
    for (let i = 0; i < frame.ranks.length; i++) {
      const rank = (frame.rankOffset ?? 0) + i + 1;
      const packageName = frame.ranks[i]!;
      let facts: RepositoryFacts;
      try {
        facts = await collectFacts(rank, packageName, workDir, () => new Date().toISOString());
      } catch (err) {
        // The walk continues. A rank that cannot be collected is an outcome, not a reason to stop.
        facts = {
          rank,
          packageName,
          collectedAt: new Date().toISOString(),
          registry: { resolved: false, error: err instanceof Error ? err.message : String(err) },
          repository: null,
          github: { unknown: true },
          clone: { ok: false },
          files: { lockfiles: [], workspaceConfigs: [], runnerConfigs: [], ciWorkflows: [] },
          testSurface: { rootDirectories: [], patternCounts: {}, extensionCounts: {} },
        };
      }

      // Facts first, always - before any verdict exists for this entry.
      writeFileSync(join(outDir, "facts", `${String(rank).padStart(2, "0")}-${packageName.replace(/[@/]/g, "_")}.json`), `${JSON.stringify(facts, null, 2)}\n`);

      const verdict = adjudicate(facts);
      adjudications.push(verdict);
      console.log(
        `  ${String(rank).padStart(2)}. ${packageName.padEnd(34)} ${(verdict.repository ?? "-").padEnd(34)} gate ${verdict.gate}  ${verdict.outcome}`,
      );
    }

    const counts: Record<string, number> = {};
    for (const a of adjudications) counts[a.outcome] = (counts[a.outcome] ?? 0) + 1;

    const excluded = adjudications.filter((a) => a.outcome.startsWith("EXCLUDED_"));
    const eligible = adjudications.filter((a) => !a.outcome.startsWith("EXCLUDED_"));
    const reached = adjudications.filter((a) => a.outcome === "REACHED_QUALIFICATION");

    const summary = {
      frame: { source: frame.source, sourcePublished: frame.sourcePublished, entries: frame.ranks.length },
      runnerCapabilities: capabilities,
      chain: {
        frameEntries: frame.ranks.length,
        excluded: excluded.length,
        surveyEligible: eligible.length,
        reachedQualification: reached.length,
      },
      counts,
      adjudications,
      producedAt: new Date().toISOString(),
      note:
        "Gates 1-4 only. REACHED_QUALIFICATION means the structural gates passed and the repository " +
        "is eligible for the canonical container run that decides gates 5 (baseline green) and 6 " +
        "(calibration readable). It is NOT an assessment reach rate on its own.",
    };
    writeFileSync(join(outDir, "survey-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);

    console.log(`\n  CHAIN`);
    console.log(`    frame entries          ${summary.chain.frameEntries}`);
    console.log(`    excluded               ${summary.chain.excluded}`);
    console.log(`    survey-eligible        ${summary.chain.surveyEligible}`);
    console.log(`    reached qualification  ${summary.chain.reachedQualification}   (gates 1-4 passed)`);
    console.log(`\n  FIRST-FAILURE COUNTS`);
    for (const [k, v] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${k.padEnd(34)} ${v}`);
    }
    console.log(`\n  Gates 5-6 are decided by the canonical container run, not here.\n`);
  })();
}

main();
