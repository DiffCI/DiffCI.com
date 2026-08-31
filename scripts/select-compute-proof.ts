/**
 * COMPUTE_PROOF_V1 selection, applied mechanically to the frozen density measurements.
 *
 * The rule is frozen in docs/compute-proof-v1-preregistration.md and is transcribed here without
 * addition. This script exists so the selection is reproducible by a third party from committed data
 * rather than asserted in prose - the same reason the addressability survey's adjudicator is a pure
 * function over recorded facts.
 *
 * `twoGreenBaselines` is deliberately NOT evaluated here: it needs a container run, and it is a gate
 * the ranked candidates face in order. If the top-ranked repository cannot produce two green baselines
 * it fails eligibility and the next one is taken - a consequence of the rule, not a later choice.
 *
 * Usage: npm run select:compute-proof -- --density <density-summary.json>
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

const MIN_TEST_FILES = 100;
const MIN_MAPPING_DENSITY = 0.3;
const MIN_PRODUCTION_EDGES = 100;

function main(): void {
  const args = process.argv.slice(2);
  const i = args.indexOf("--density");
  const path = resolve(i !== -1 ? args[i + 1]! : "docs/evidence/density-02/density-summary.json");
  const rows = (JSON.parse(readFileSync(path, "utf8")) as { rows: Row[] }).rows;

  // One entry per repository: the frame is packages, and typescript-eslint appears twice.
  const byRepository = new Map<string, Row>();
  for (const row of rows) {
    if (row.status !== "MEASURED" || !row.repository) continue;
    const existing = byRepository.get(row.repository);
    if (!existing || (row.testFiles ?? 0) > (existing.testFiles ?? 0)) byRepository.set(row.repository, row);
  }

  console.log(`\n  COMPUTE_PROOF_V1 SELECTION\n`);
  console.log(`  source: ${path}`);
  console.log(`  measured repositories: ${byRepository.size}\n`);
  console.log(`    ${"repository".padEnd(38)}${"tests".padStart(7)}${"mapping".padStart(10)}${"edges".padStart(8)}   verdict`);

  const qualifying: Row[] = [];
  for (const row of [...byRepository.values()].sort((a, b) => (b.mappingDensity ?? 0) - (a.mappingDensity ?? 0))) {
    const failures: string[] = [];
    if ((row.testFiles ?? 0) < MIN_TEST_FILES) failures.push(`tests<${MIN_TEST_FILES}`);
    if ((row.mappingDensity ?? 0) < MIN_MAPPING_DENSITY) failures.push(`mapping<${MIN_MAPPING_DENSITY * 100}%`);
    if ((row.testToProductionEdges ?? 0) < MIN_PRODUCTION_EDGES) failures.push(`edges<${MIN_PRODUCTION_EDGES}`);
    if (failures.length === 0) qualifying.push(row);
    console.log(
      `    ${row.repository!.padEnd(38)}${String(row.testFiles ?? "-").padStart(7)}` +
        `${(((row.mappingDensity ?? 0) * 100).toFixed(1) + "%").padStart(10)}${String(row.testToProductionEdges ?? "-").padStart(8)}   ` +
        (failures.length === 0 ? "QUALIFIES" : failures.join(", ")),
    );
  }

  // Highest mapping density; ties by test-file count descending, then repository name ascending.
  qualifying.sort(
    (a, b) =>
      (b.mappingDensity ?? 0) - (a.mappingDensity ?? 0) ||
      (b.testFiles ?? 0) - (a.testFiles ?? 0) ||
      a.repository!.localeCompare(b.repository!),
  );

  console.log(`\n  qualifying: ${qualifying.length}`);
  qualifying.forEach((row, index) => {
    console.log(`    ${index === 0 ? "SELECTED " : "next     "} ${row.repository}  (mapping ${((row.mappingDensity ?? 0) * 100).toFixed(1)}%, ${row.testFiles} tests, ${row.testToProductionEdges} edges)`);
  });
  console.log(
    `\n  twoGreenBaselines is NOT evaluated here - it needs a container run. If the selected repository\n` +
      `  cannot produce two green baselines it fails eligibility and the next in this order is taken.\n`,
  );
}

main();
