/**
 * Is DiffCI expected to reduce incremental CPU on this repository, relative to the cheap alternative
 * the customer already has?
 *
 * This is the pre-registered predictor from docs/stabiliser-hypothesis-preregistration.md (`e12c207`),
 * made reproducible. It adds NOTHING to that rule:
 *
 *     cpuPerFile    = fullCpu(one calibration run) / test files the runner executed
 *     avoidedFiles  = SUM comparatorSelected - SUM diffciSelected
 *     predictedIncr = avoidedFiles * cpuPerFile - SUM analysisCpu
 *
 *     predictedIncr > 0  ->  POSITIVE
 *     predictedIncr < 0  ->  NEGATIVE
 *
 * NO THRESHOLDS. No minimum-percentage rule, no confidence band, no commercial floor. Introducing one
 * now would be tuning against three repositories. Those belong to external evidence, later.
 *
 * THE VERDICT IS NOT A DIRECTIVE. It says ECONOMICALLY_UNFAVOURABLE_PREDICTION, not "do not enable".
 * The rule has exactly one out-of-sample validation, which is far short of what an automated production
 * decision would require. It can become authoritative after external validation and not before.
 *
 * THE RAW INPUTS ALWAYS ACCOMPANY THE VERDICT. A one-word answer would become an opaque score, and the
 * entire value of this work is that a customer or an investor can see precisely why the prediction came
 * out the way it did - and disagree with the arithmetic if they wish.
 *
 * WHAT IT COSTS TO RUN. The inputs are one clone, one install, one full-suite execution, and N
 * observations - about five minutes of container time for vuejs/core. That is what makes this an
 * onboarding mechanism rather than a research finding: it can be answered before anything is sold.
 *
 * Usage:
 *   npm run eligibility -- --bundle <frozen run dir> --test-files <N> [--label <name>]
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

interface Row {
  repository: string;
  economics?: {
    measurable: boolean;
    full: { cpuSeconds?: number };
    comparator: { selectedCount: number };
    diffciSelected: { selectedCount: number };
    jointAnalysisCpuSeconds?: number;
  };
}

const n = (v: number, places = 2): string => v.toFixed(places);

function main(): void {
  const args = process.argv.slice(2);
  const flag = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const bundle = resolve(flag("bundle") ?? "");
  const testFiles = Number(flag("test-files") ?? 0);
  if (!existsSync(join(bundle, "results.jsonl"))) throw new Error("--bundle <frozen run directory> is required");
  if (!Number.isFinite(testFiles) || testFiles <= 0) throw new Error("--test-files <N> is required (the file count the runner executed)");

  const rows = readFileSync(join(bundle, "results.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Row);

  const measurable = rows.filter((r) => r.economics?.measurable === true);
  if (measurable.length === 0) throw new Error("no compute-measurable candidates in this bundle");

  // One calibration run, as the frozen rule specifies - not an average across candidates.
  const fullCpu = measurable[0]!.economics!.full.cpuSeconds!;
  const cpuPerFile = fullCpu / testFiles;

  const comparatorSelected = measurable.reduce((a, r) => a + r.economics!.comparator.selectedCount, 0);
  const diffciSelected = measurable.reduce((a, r) => a + r.economics!.diffciSelected.selectedCount, 0);
  const analysisCpu = measurable.reduce((a, r) => a + (r.economics!.jointAnalysisCpuSeconds ?? 0), 0);
  const avoidedFiles = comparatorSelected - diffciSelected;

  const predictedIncr = avoidedFiles * cpuPerFile - analysisCpu;
  const prediction = predictedIncr > 0 ? "POSITIVE" : "NEGATIVE";
  const verdict = predictedIncr > 0 ? "ECONOMICALLY_FAVOURABLE_PREDICTION" : "ECONOMICALLY_UNFAVOURABLE_PREDICTION";

  const label = flag("label") ?? measurable[0]!.repository;

  console.log(`\n  DIFFCI ECONOMIC ELIGIBILITY - ${label}\n`);
  console.log("  Calibration");
  console.log(`    full CPU:            ${n(fullCpu).padStart(10)} CPU-s   (one run)`);
  console.log(`    test files:          ${String(testFiles).padStart(10)}`);
  console.log(`    modelled CPU/file:   ${n(cpuPerFile, 4).padStart(10)} CPU-s`);
  console.log("\n  Observation");
  console.log(`    candidates:          ${String(measurable.length).padStart(10)}`);
  console.log(`    comparator selected: ${String(comparatorSelected).padStart(10)} files`);
  console.log(`    DiffCI selected:     ${String(diffciSelected).padStart(10)} files`);
  console.log(`    avoided files:       ${String(avoidedFiles).padStart(10)}`);
  console.log(`    analysis CPU:        ${n(analysisCpu).padStart(10)} CPU-s`);
  console.log("\n  Predicted incremental CPU");
  console.log(`    ${avoidedFiles} x ${n(cpuPerFile, 4)} - ${n(analysisCpu)}  =  ${n(predictedIncr)} CPU-s`);
  console.log(`\n  Prediction:      ${prediction}`);
  console.log(`  Verdict:         ${verdict}`);
  console.log(
    "\n  This is a PREDICTION, not a directive, and not a savings figure. The rule has one\n" +
      "  out-of-sample validation; it is not yet authoritative for an automated production decision.\n" +
      "  No threshold is applied - the sign is the whole rule.\n",
  );
}

main();
