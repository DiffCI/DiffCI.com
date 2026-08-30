/**
 * Reads the raw compute components out of a frozen run and shows the arithmetic.
 *
 * DELIBERATELY NOT A VERDICT MACHINE. There are no POSITIVE / PARITY / NEGATIVE labels here, because
 * this project has no principled noise threshold yet, and `+0.03 CPU-seconds` must not become evidence
 * of economic additionality merely by being greater than zero. The first pass prints measurements and
 * the two subtractions, and a human decides what a difference of that size means.
 *
 * IT ALSO MUTATES NOTHING. Every number below is recomputed from `results.jsonl` in the bundle, which
 * carries the full raw components - so anyone can recompute all of this without this script, and this
 * script is not the only place the equations exist.
 *
 *   grossCpu       = fullCpu       - (diffciSelectedCpu + jointAnalysisCpu)
 *   incrementalCpu = comparatorCpu - (diffciSelectedCpu + jointAnalysisCpu)
 *
 * The incremental definition is deliberately conservative: the comparator pays ZERO analysis CPU even
 * though producing its selection currently depends on the graph work DiffCI needs. A positive result
 * under this definition therefore cannot be an artefact of how shared analysis cost was allocated.
 *
 * Usage: npm run dogfood:economics -- --run <frozen bundle or run directory>
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface ArmCost {
  cpuSeconds?: number;
  wallMs: number;
  exitStatus: number | null;
  selectedCount?: number;
}

interface Row {
  repository: string;
  headSha: string;
  classification: string;
  efficiency?: string;
  economics?: {
    treeState: string;
    measurable: boolean;
    unmeasurableReason?: string;
    full: ArmCost;
    comparator: ArmCost & { selectedCount: number };
    diffciSelected: ArmCost & { selectedCount: number };
    jointAnalysisCpuSeconds?: number;
  };
}

/** The two classifications that mean the safety question was actually answered. */
const SAFETY_MEASURABLE: ReadonlySet<string> = new Set(["RECALL_CONFIRMED", "FALSE_GREEN"]);

const s = (n: number | undefined, places = 2): string => (n === undefined ? "  n/a" : n.toFixed(places));

function main(): void {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const runDir = resolve(flag("run") ?? "");
  const resultsPath = join(runDir, "results.jsonl");
  if (!existsSync(resultsPath)) throw new Error("--run <frozen bundle or run directory> is required");

  const rows = readFileSync(resultsPath, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Row);

  const repository = rows[0]?.repository ?? "(unknown)";

  // TWO DENOMINATORS, kept apart. A candidate can carry valid mutation evidence and still fail compute
  // measurement because an execution arm failed or CPU accounting was unavailable. Reporting only the
  // compute-measurable count would silently drop those rows and quietly shrink the denominator.
  const safetyMeasurable = rows.filter((r) => SAFETY_MEASURABLE.has(r.classification));
  const computeMeasurable = rows.filter((r) => r.economics?.measurable === true);
  const computeAttempted = rows.filter((r) => r.economics !== undefined);

  console.log(`\n  ${repository}   raw compute components, ${runDir}\n`);
  console.log("  DENOMINATORS");
  console.log(`    candidates                 ${rows.length}`);
  console.log(`    safety-measurable          ${safetyMeasurable.length}`);
  console.log(`    compute-attempted          ${computeAttempted.length}`);
  console.log(`    compute-MEASURABLE         ${computeMeasurable.length}`);

  const unmeasurable = computeAttempted.filter((r) => r.economics?.measurable === false);
  if (unmeasurable.length > 0) {
    console.log(`\n  COMPUTE-UNMEASURABLE (${unmeasurable.length}) - recorded, not dropped`);
    for (const r of unmeasurable) {
      console.log(`    ${r.headSha.slice(0, 9)}  ${r.economics?.unmeasurableReason ?? "(no reason recorded)"}`);
    }
  }

  if (computeMeasurable.length === 0) {
    console.log("\n  No compute-measurable candidates. No economics can be read from this run.\n");
    return;
  }

  console.log(`\n  PER-CANDIDATE  (CPU-seconds; tree state: ${computeMeasurable[0]!.economics!.treeState})\n`);
  console.log(
    `    ${"commit".padEnd(11)}${"fullCpu".padStart(9)}${"compCpu".padStart(9)}${"diffciCpu".padStart(11)}` +
      `${"analysis".padStart(10)}${"gross".padStart(9)}${"incr".padStart(9)}   sel(comp/diffci)`,
  );

  for (const r of computeMeasurable) {
    const e = r.economics!;
    const diffciTotal = e.diffciSelected.cpuSeconds! + e.jointAnalysisCpuSeconds!;
    const gross = e.full.cpuSeconds! - diffciTotal;
    const incremental = e.comparator.cpuSeconds! - diffciTotal;
    console.log(
      `    ${r.headSha.slice(0, 9).padEnd(11)}${s(e.full.cpuSeconds).padStart(9)}${s(e.comparator.cpuSeconds).padStart(9)}` +
        `${s(e.diffciSelected.cpuSeconds).padStart(11)}${s(e.jointAnalysisCpuSeconds).padStart(10)}` +
        `${s(gross).padStart(9)}${s(incremental).padStart(9)}   ${e.comparator.selectedCount}/${e.diffciSelected.selectedCount}`,
    );
  }

  console.log(`\n  WALL TIME, kept beside CPU and never instead of it (ms)\n`);
  console.log(`    ${"commit".padEnd(11)}${"full".padStart(10)}${"comparator".padStart(12)}${"diffci".padStart(10)}`);
  for (const r of computeMeasurable) {
    const e = r.economics!;
    console.log(
      `    ${r.headSha.slice(0, 9).padEnd(11)}${String(e.full.wallMs).padStart(10)}` +
        `${String(e.comparator.wallMs).padStart(12)}${String(e.diffciSelected.wallMs).padStart(10)}`,
    );
  }

  // Totals, as sums of the raw components rather than an average of per-candidate ratios: averaging
  // ratios lets one tiny cheap candidate outvote a large expensive one.
  const sum = (pick: (e: NonNullable<Row["economics"]>) => number): number =>
    computeMeasurable.reduce((acc, r) => acc + pick(r.economics!), 0);

  const fullCpu = sum((e) => e.full.cpuSeconds!);
  const compCpu = sum((e) => e.comparator.cpuSeconds!);
  const diffciCpu = sum((e) => e.diffciSelected.cpuSeconds!);
  const analysisCpu = sum((e) => e.jointAnalysisCpuSeconds!);

  console.log(`\n  TOTALS over ${computeMeasurable.length} compute-measurable candidate(s), CPU-seconds\n`);
  console.log(`    full                       ${s(fullCpu)}`);
  console.log(`    comparator selected        ${s(compCpu)}`);
  console.log(`    diffci selected            ${s(diffciCpu)}`);
  console.log(`    joint analysis             ${s(analysisCpu)}   (charged entirely to DiffCI)`);
  console.log(`    diffci total               ${s(diffciCpu + analysisCpu)}`);
  console.log(`\n    grossCpu       = ${s(fullCpu)} - (${s(diffciCpu)} + ${s(analysisCpu)}) = ${s(fullCpu - diffciCpu - analysisCpu)}`);
  console.log(`    incrementalCpu = ${s(compCpu)} - (${s(diffciCpu)} + ${s(analysisCpu)}) = ${s(compCpu - diffciCpu - analysisCpu)}`);
  console.log(
    `\n  No verdict is attached to these numbers. There is no established noise threshold for this\n` +
      `  measurement, and a small difference in either direction is not yet evidence of anything.\n`,
  );
}

main();
