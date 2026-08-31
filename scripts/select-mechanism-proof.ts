/**
 * MECHANISM_PROOF_01 selection, applied mechanically to the frozen density measurements.
 *
 * The rule is frozen in docs/mechanism-proof-01-preregistration.md and transcribed here without
 * addition, so the selection is reproducible by a third party from committed data rather than asserted
 * in prose.
 *
 * Usage: npm run select:mechanism-proof
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface Row {
  rank: number;
  packageName: string;
  repository: string | null;
  status: string;
  testFiles?: number;
  mappingDensity?: number;
  testToProductionEdges?: number;
}

interface CorpusEntry {
  source: string;
  mutationQualified?: string;
  mutationQualificationReason?: string;
}

const MIN_MAPPING_DENSITY = 0.7;
const MIN_TEST_FILES = 20;
/** Closed in COMPUTE_PROOF_V1; reopening either would reverse a sealed disqualification. */
const DISQUALIFIED_IN_V1 = new Set(["typescript-eslint/typescript-eslint", "jestjs/jest"]);

function main(): void {
  const rows = (
    JSON.parse(readFileSync(resolve("docs/evidence/density-02/density-summary.json"), "utf8")) as { rows: Row[] }
  ).rows;
  const corpus = JSON.parse(readFileSync(resolve("scripts/dogfood-corpus.json"), "utf8")) as CorpusEntry[];
  const byRepository = new Map(corpus.map((e) => [e.source, e]));

  // One entry per repository - the frame is packages, and some repositories appear more than once.
  const unique = new Map<string, Row>();
  for (const row of rows) {
    if (row.status !== "MEASURED" || !row.repository) continue;
    const existing = unique.get(row.repository);
    if (!existing || (row.testFiles ?? 0) > (existing.testFiles ?? 0)) unique.set(row.repository, row);
  }

  console.log(`\n  MECHANISM_PROOF_01 SELECTION\n`);
  console.log(`    ${"repository".padEnd(38)}${"tests".padStart(7)}${"mapping".padStart(10)}${"edges".padStart(8)}  ${"green twice".padEnd(13)} verdict`);

  const qualifying: Row[] = [];
  for (const row of [...unique.values()].sort((a, b) => (b.mappingDensity ?? 0) - (a.mappingDensity ?? 0))) {
    const entry = byRepository.get(row.repository!);
    const greenTwice = entry?.mutationQualified === "yes";
    const failures: string[] = [];
    if ((row.mappingDensity ?? 0) < MIN_MAPPING_DENSITY) failures.push(`mapping<${MIN_MAPPING_DENSITY * 100}%`);
    if ((row.testFiles ?? 0) < MIN_TEST_FILES) failures.push(`tests<${MIN_TEST_FILES}`);
    if (DISQUALIFIED_IN_V1.has(row.repository!)) failures.push("disqualified in V1");
    if (!greenTwice) failures.push(entry === undefined || entry.mutationQualified === "unknown" ? "no green baselines yet" : "not green twice");
    if (failures.length === 0) qualifying.push(row);

    // Only rows that clear the structural bar are worth printing in full; the rest would be noise.
    if ((row.mappingDensity ?? 0) >= 0.4) {
      console.log(
        `    ${row.repository!.padEnd(38)}${String(row.testFiles ?? "-").padStart(7)}` +
          `${(((row.mappingDensity ?? 0) * 100).toFixed(1) + "%").padStart(10)}${String(row.testToProductionEdges ?? "-").padStart(8)}  ` +
          `${(greenTwice ? "yes" : "no").padEnd(13)} ${failures.length === 0 ? "QUALIFIES" : failures.join(", ")}`,
      );
    }
  }

  qualifying.sort(
    (a, b) =>
      (b.mappingDensity ?? 0) - (a.mappingDensity ?? 0) ||
      (b.testFiles ?? 0) - (a.testFiles ?? 0) ||
      a.repository!.localeCompare(b.repository!),
  );

  console.log(`\n  qualifying: ${qualifying.length}`);
  qualifying.forEach((row, index) => {
    console.log(
      `    ${index === 0 ? "SELECTED " : "next     "} ${row.repository}  ` +
        `(mapping ${((row.mappingDensity ?? 0) * 100).toFixed(1)}%, ${row.testFiles} tests, ${row.testToProductionEdges} edges)`,
    );
  });
  if (qualifying.length === 0) console.log(`    NONE - MECHANISM_PROOF_01 has no candidate under the frozen rule.`);
  console.log("");
}

main();
