/**
 * How many of the frozen 40 can actually reproduce green in the canonical validation environment?
 *
 * COMPUTE_PROOF_V1 closed INCONCLUSIVE with zero qualified targets, and the hypothesis that fell out of
 * it is that `twoGreenBaselines` - not connectivity - is the binding constraint. That hypothesis is
 * testable directly, and it must be tested BEFORE any V2 is designed, because the wrong response
 * ("green baselines are hard, so V2 permits red ones") would make recall and false-green measurement
 * uninterpretable.
 *
 * DELIBERATELY NO STRUCTURAL THRESHOLDS. No >=100 tests, no >=30% mapping. Those belong to the
 * compute-proof rule; this diagnostic asks a narrower question and applying them would answer a
 * different one.
 *
 * IT RUNS NOTHING. Every row is assembled from committed evidence - the density survey for analyser
 * eligibility and structure, the corpus registry for qualification outcomes already obtained. Gaps are
 * reported AS gaps rather than silently dropped, so the cost of completing the funnel is visible before
 * a single container is spent.
 *
 * Usage: npm run funnel:qualification
 */
import { readFileSync } from "node:fs";

interface DensityRow {
  rank: number;
  packageName: string;
  repository: string | null;
  status: string;
  reason?: string;
  testFiles?: number;
  mappingDensity?: number;
  testToProductionEdges?: number;
}

interface CorpusEntry {
  source: string;
  mutationQualified?: string;
  mutationQualificationReason?: string;
  install?: string[];
  build?: string[];
}

/** Where a repository stopped, in the order the qualifier attempts them. */
type Stage = "ANALYZER" | "INSTALL" | "BUILD" | "BASELINE" | "GREEN_TWICE" | "NOT_ATTEMPTED";

interface FunnelRow {
  rank: number;
  packageName: string;
  repository: string;
  analyzerEligible: boolean;
  testFiles: number | undefined;
  mappingDensity: number | undefined;
  productionEdges: number | undefined;
  stage: Stage;
  detail: string;
}

/**
 * Classify a recorded qualification outcome by the stage it reached.
 *
 * Reading the recorded REASON rather than re-deriving it: the reason strings are what the qualifier
 * actually emitted, and re-running to recover a classification we already hold would be the expense
 * this script exists to avoid.
 */
function classify(entry: CorpusEntry | undefined, analyzerEligible: boolean): { stage: Stage; detail: string } {
  if (!analyzerEligible) return { stage: "ANALYZER", detail: "no tsconfig.json - DiffCI cannot analyse it" };
  if (!entry || entry.mutationQualified === undefined || entry.mutationQualified === "unknown") {
    return { stage: "NOT_ATTEMPTED", detail: "no canonical qualification run exists" };
  }
  if (entry.mutationQualified === "yes") return { stage: "GREEN_TWICE", detail: "green on two consecutive runs" };

  const reason = entry.mutationQualificationReason ?? "";
  if (/^install failed/i.test(reason)) return { stage: "INSTALL", detail: reason.slice(0, 110) };
  if (/^build failed/i.test(reason)) return { stage: "BUILD", detail: reason.slice(0, 110) };
  if (/INVALID|do not use/i.test(entry.mutationQualified)) return { stage: "BASELINE", detail: reason.slice(0, 110) };
  return { stage: "BASELINE", detail: reason.slice(0, 110) };
}

function main(): void {
  const density = JSON.parse(readFileSync("docs/evidence/density-02/density-summary.json", "utf8")) as { rows: DensityRow[] };
  const corpus = JSON.parse(readFileSync("scripts/dogfood-corpus.json", "utf8")) as CorpusEntry[];
  const byRepository = new Map(corpus.map((e) => [e.source, e]));

  const rows: FunnelRow[] = [];
  const seen = new Set<string>();
  for (const row of density.rows) {
    if (!row.repository) continue;
    // The frame is packages; typescript-eslint and DefinitelyTyped each appear more than once.
    if (seen.has(row.repository)) continue;
    seen.add(row.repository);

    // `MEASURED` and `EXCLUDED_ALREADY_EXAMINED` are both analyser-eligible. The second only means the
    // density survey skipped it to avoid recycling a known answer - those repositories were examined
    // EARLIER and carry real qualification evidence, so treating the exclusion as ineligibility would
    // discard it and overstate the ineligible count. `NO_TESTS_DISCOVERED` is likewise not an analyser
    // refusal.
    const analyzerEligible = row.status === "MEASURED" || row.status === "EXCLUDED_ALREADY_EXAMINED";
    const noTests = row.status === "NO_TESTS_DISCOVERED";
    const { stage, detail } = noTests
      ? { stage: "NOT_ATTEMPTED" as Stage, detail: "no test files discovered - outside the product's scope" }
      : classify(byRepository.get(row.repository), analyzerEligible);
    rows.push({
      rank: row.rank,
      packageName: row.packageName,
      repository: row.repository,
      analyzerEligible,
      testFiles: row.testFiles,
      mappingDensity: row.mappingDensity,
      productionEdges: row.testToProductionEdges,
      stage,
      detail,
    });
  }

  const pct = (v: number | undefined): string => (v === undefined ? "   -" : `${(v * 100).toFixed(0)}%`.padStart(4));
  console.log(`\n  CANONICAL QUALIFICATION FUNNEL - assembled from committed evidence, nothing re-run\n`);
  console.log(`  ${"repository".padEnd(36)}${"tests".padStart(6)}${"map".padStart(6)}${"edge".padStart(6)}   ${"stage".padEnd(14)} detail`);
  for (const r of rows.sort((a, b) => a.rank - b.rank)) {
    console.log(
      `  ${r.repository.padEnd(36)}${String(r.testFiles ?? "-").padStart(6)}${pct(r.mappingDensity)}${String(r.productionEdges ?? "-").padStart(6)}   ` +
        `${r.stage.padEnd(14)} ${r.detail}`,
    );
  }

  const count = (s: Stage): number => rows.filter((r) => r.stage === s).length;
  console.log(`\n  WHERE REPOSITORIES STOP  (distinct repositories: ${rows.length})\n`);
  const stages: [Stage, string][] = [
    ["ANALYZER", "analyser ineligible - no tsconfig"],
    ["NOT_ATTEMPTED", "never qualified - NO EVIDENCE YET"],
    ["INSTALL", "install failed"],
    ["BUILD", "build failed"],
    ["BASELINE", "reached a baseline, not green twice"],
    ["GREEN_TWICE", "GREEN ON TWO CONSECUTIVE RUNS"],
  ];
  for (const [stage, label] of stages) console.log(`    ${String(count(stage)).padStart(3)}  ${label}`);

  const attempted = rows.length - count("NOT_ATTEMPTED") - count("ANALYZER");
  console.log(`\n  Of ${rows.length} distinct repositories, ${count("ANALYZER")} are analyser-ineligible and`);
  console.log(`  ${count("NOT_ATTEMPTED")} have never been through canonical qualification at all.`);
  console.log(`  Among the ${attempted} actually attempted: ${count("GREEN_TWICE")} green twice.`);
  console.log(`\n  The ${count("NOT_ATTEMPTED")} unattempted rows are the cost of completing this funnel -`);
  console.log(`  one container run each, and until they exist the green rate is not a rate.\n`);
}

main();
