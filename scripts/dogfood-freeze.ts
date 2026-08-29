/**
 * Freezes one mutation run into an immutable evidence bundle.
 *
 * WHY FREEZING IS NOT THE SAME AS SUMMARISING. A summary is derived, and derivation can be changed
 * later. If the aggregation logic gains a rule six weeks from now - excluding a class of row,
 * rounding differently, counting a denominator another way - every historical summary silently
 * acquires new numbers, and nobody can tell what the experiment originally established. That is the
 * same class of problem as the contaminated results file and the unwired `--build` flag: evidence
 * that looks solid while quietly being something else.
 *
 * So a freeze captures the whole object, not the conclusion:
 *
 *   run manifest + COMPLETE marker + raw results + agent digest + environment identity
 *   + corpus definition and the commit it came from + THIS summariser's version
 *
 * and then records a checksum over all of it. A later reader can recompute the summary, compare it to
 * the frozen one, and see immediately whether the difference is in the data or in the arithmetic.
 *
 * THE FUNNEL IS THE POINT. "3 of 3 recall confirmed" is a true statement that hides how many
 * candidates were discarded and why. The frozen summary reports the whole path from candidates to
 * conclusions - candidates, baseline-qualified, environment-dirty, measurable, confirmed, false green,
 * unmeasurable - because the attrition is where the honesty lives.
 *
 * Usage: npm run dogfood:freeze -- --run .dogfood/runs/<runId> [--out .dogfood/frozen]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repoRoot = resolve(dirname(import.meta.filename), "..");

/**
 * Bumped whenever the funnel arithmetic below changes. A frozen bundle records the version that
 * produced it, so a summary computed by v1 is never silently compared against one computed by v2.
 */
const SUMMARISER_VERSION = "1.0.0";

interface MutationRow {
  repository: string;
  headSha: string;
  baseSha: string;
  classification: string;
  efficiency?: string;
  selection?: { selected: number; total: number; baselineSelected?: number; versusBaseline?: number; detecting: number };
  reason: string;
  mutatedFile?: string;
  attemptedFiles?: string[];
}

function sha256OfFile(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function gitOutput(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
  } catch {
    return undefined;
  }
}

function agentDigest(): { tarball: string; sha256: string } | undefined {
  const distDir = join(repoRoot, "dist-agent");
  if (!existsSync(distDir)) return undefined;
  const tarball = readdirSync(distDir).find((f) => f.endsWith(".tgz"));
  if (!tarball) return undefined;
  return { tarball, sha256: sha256OfFile(join(distDir, tarball)) };
}

/**
 * The attrition path from candidates to conclusions.
 *
 * Every stage is reported, including the ones that discard evidence, because a recall ratio without
 * its denominator's history is not interpretable.
 */
function buildFunnel(rows: MutationRow[]) {
  const count = (c: string): number => rows.filter((r) => r.classification === c).length;

  const confirmed = count("RECALL_CONFIRMED");
  const falseGreen = count("FALSE_GREEN");
  const measurable = confirmed + falseGreen;

  return {
    candidates: rows.length,
    baselineQualified: rows.length - count("ENVIRONMENT_DIRTY") - count("INVALID_RUN"),
    environmentDirty: count("ENVIRONMENT_DIRTY"),
    invalidRun: count("INVALID_RUN"),
    recallUnmeasurable: count("RECALL_UNMEASURABLE"),
    recallMeasurable: measurable,
    recallConfirmed: confirmed,
    falseGreen,
    /** The primary safety metric. Undefined - never 0 - when nothing was measurable. */
    falseGreenRate: measurable > 0 ? falseGreen / measurable : undefined,
    efficiency: {
      efficient: rows.filter((r) => r.efficiency === "EFFICIENT").length,
      comparable: rows.filter((r) => r.efficiency === "COMPARABLE").length,
      selectionOverbroad: rows.filter((r) => r.efficiency === "SELECTION_OVERBROAD").length,
      /** Scored only where the safety question was answerable, so this is measurable-case coverage. */
      scored: rows.filter((r) => r.efficiency !== undefined).length,
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const index = args.indexOf(`--${name}`);
    return index !== -1 ? args[index + 1] : undefined;
  };

  const runDir = resolve(flag("run") ?? "");
  if (!existsSync(runDir)) throw new Error("--run <run directory> is required");

  // A run without its COMPLETE sentinel is a partial run. Freezing one would enshrine half an
  // experiment as evidence, which is precisely what the sentinel exists to prevent.
  if (!existsSync(join(runDir, "COMPLETE"))) {
    throw new Error(`${runDir} has no COMPLETE marker - it is a partial run and must not be frozen`);
  }

  const manifest = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8")) as Record<string, unknown>;
  const resultsPath = join(runDir, "results.jsonl");
  const rows = readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as MutationRow);

  // COMPLETE says the harness finished; it does not say it measured anything. A mutation pass whose
  // candidate list came out empty finishes in seconds and writes COMPLETE over zero rows (observed for
  // real on 2026-08-29, when a repository-identity mismatch silently discarded all 22 candidates).
  // Freezing that would mint an evidence bundle whose funnel reads 0/0 with a clean checksum over it.
  if (rows.length === 0) {
    throw new Error(`${runDir} completed but classified nothing - an empty run is a silent no-op, not evidence, and must not be frozen`);
  }

  const outRoot = resolve(flag("out") ?? join(repoRoot, ".dogfood", "frozen"));
  const frozenDir = join(outRoot, String(manifest.runId ?? "unknown-run"));
  mkdirSync(frozenDir, { recursive: true });

  for (const file of ["manifest.json", "results.jsonl", "COMPLETE"]) {
    copyFileSync(join(runDir, file), join(frozenDir, file));
  }

  // The corpus the run actually consumed. A run directory collected from the canonical Linux
  // environment carries its own copy, because the manifest's `corpusPath` names a path inside a
  // container that does not exist on the machine doing the freezing (2026-08-28). Preferring the local
  // copy is what keeps a container-produced bundle structurally identical to a locally-produced one -
  // without it the Linux bundle would silently lack the corpus and stop being comparable to the very
  // evidence it was produced to be compared against. The manifest itself is never rewritten.
  const collectedCorpus = join(runDir, "corpus.jsonl");
  const corpusPath = typeof manifest.corpusPath === "string" ? manifest.corpusPath : undefined;
  if (existsSync(collectedCorpus)) copyFileSync(collectedCorpus, join(frozenDir, "corpus.jsonl"));
  else if (corpusPath && existsSync(corpusPath)) copyFileSync(corpusPath, join(frozenDir, "corpus.jsonl"));

  const corpusDefinition = join(repoRoot, "scripts", "dogfood-corpus.json");
  if (existsSync(corpusDefinition)) copyFileSync(corpusDefinition, join(frozenDir, "corpus-definition.json"));

  const funnel = buildFunnel(rows);

  const frozen = {
    frozenAt: new Date().toISOString(),
    summariserVersion: SUMMARISER_VERSION,
    runId: manifest.runId,
    repository: manifest.repository,
    // The environment identity, carried through from the run rather than recomputed here - a freeze
    // performed on a different machine must not overwrite where the evidence was produced.
    environment: {
      validationImage: manifest.validationImage ?? null,
      insideValidationImage: manifest.insideValidationImage ?? false,
      node: manifest.node,
      platform: manifest.platform,
    },
    agent: agentDigest() ?? null,
    diffciCommit: gitOutput(["rev-parse", "HEAD"]),
    diffciTreeClean: gitOutput(["status", "--porcelain"]) === "",
    commands: manifest.commands,
    funnel,
    /**
     * Stated in the bundle itself so a reader does not have to reconstruct the caveat. Each of these
     * has bitten this corpus already.
     */
    caveats: [
      funnel.recallMeasurable < 10 ? `Only ${funnel.recallMeasurable} measurable case(s). Too few to support a reliability estimate.` : undefined,
      manifest.insideValidationImage ? undefined : "Produced on a developer host, NOT the canonical validation image. Not interchangeable with image results.",
      funnel.environmentDirty > 0 ? `${funnel.environmentDirty} candidate(s) refused as ENVIRONMENT_DIRTY - the baseline was not green, so nothing was measured there.` : undefined,
    ].filter((c): c is string => c !== undefined),
  };

  writeFileSync(join(frozenDir, "frozen-summary.json"), `${JSON.stringify(frozen, null, 2)}\n`);

  // A checksum over every file in the bundle. Not tamper-proofing - it is a way for a later reader to
  // establish that the numbers they are recomputing came from the bytes originally frozen.
  const checksums: Record<string, string> = {};
  for (const file of readdirSync(frozenDir).sort()) {
    if (file === "CHECKSUMS.json") continue;
    checksums[file] = sha256OfFile(join(frozenDir, file));
  }
  writeFileSync(join(frozenDir, "CHECKSUMS.json"), `${JSON.stringify(checksums, null, 2)}\n`);

  console.log(`\nFrozen: ${frozenDir}\n`);
  console.log("  FUNNEL");
  console.log(`    candidates                ${funnel.candidates}`);
  console.log(`    baseline-qualified        ${funnel.baselineQualified}`);
  console.log(`    environment-dirty         ${funnel.environmentDirty}`);
  console.log(`    invalid runs              ${funnel.invalidRun}`);
  console.log(`    recall-unmeasurable       ${funnel.recallUnmeasurable}`);
  console.log(`    recall-MEASURABLE         ${funnel.recallMeasurable}`);
  console.log(`      recall confirmed        ${funnel.recallConfirmed}`);
  console.log(`      FALSE GREEN             ${funnel.falseGreen}`);
  console.log(`\n  false greens / measurable   ${funnel.falseGreenRate === undefined ? "UNDEFINED (nothing measurable)" : `${funnel.falseGreen}/${funnel.recallMeasurable}`}`);
  console.log("\n  EFFICIENCY (independent of recall)");
  console.log(`    efficient                 ${funnel.efficiency.efficient}`);
  console.log(`    comparable                ${funnel.efficiency.comparable}`);
  console.log(`    selection overbroad       ${funnel.efficiency.selectionOverbroad}`);
  for (const caveat of frozen.caveats) console.log(`\n  CAVEAT: ${caveat}`);
  console.log();
}

main();
