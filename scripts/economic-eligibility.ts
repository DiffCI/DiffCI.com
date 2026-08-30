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
 * TWO INPUT PATHS, ONE RULE.
 *
 *   --corpus <corpus.jsonl>   OBSERVATION ONLY. Nothing was executed to produce these numbers beyond
 *                             DiffCI's own analysis. This is the path that matters commercially: it can
 *                             be run on a prospect's repository before anything is sold, and it is how
 *                             the vuejs/core prediction was made and frozen before any economics ran.
 *
 *   --bundle <frozen run>     Reads the same quantities out of a completed economics run. Retained
 *                             because the three known repositories have frozen bundles and dropping it
 *                             would make those reproductions unverifiable. It is NOT the intended path.
 *
 * Calibration comes from `npm run calibrate` (`--calibration <json>`), which reads the test-file count
 * out of the runner's own output. `--full-cpu` / `--test-files` remain accepted for reproducing frozen
 * results whose calibration run predates that script.
 *
 * Usage:
 *   npm run eligibility -- --corpus <corpus.jsonl> --calibration <calibration.json> [--label <name>]
 *   npm run eligibility -- --bundle <frozen run dir> --full-cpu <s> --test-files <N>
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** A row of an economics run: selection counts recorded alongside what was actually executed. */
interface ResultRow {
  repository: string;
  economics?: {
    measurable: boolean;
    full: { cpuSeconds?: number };
    comparator: { selectedCount: number };
    diffciSelected: { selectedCount: number };
    jointAnalysisCpuSeconds?: number;
  };
}

/** A row of an observation run: what each side WOULD have selected, and what the analysis cost. */
interface CorpusRow {
  identity: { repository: string; headSha: string };
  decision: { mode: string; selected: number; total: number };
  counterfactual: { baselineMode: string; baselineSelected: number };
  economics?: { jointAnalysisCpuSeconds?: number };
}

interface Observation {
  repository: string;
  candidates: number;
  comparatorSelected: number;
  diffciSelected: number;
  analysisCpu: number;
  /** Candidates on which DiffCI declined to narrow at all. Reported because it drives the total. */
  diffciFullRuns: number;
  source: string;
}

const n = (v: number, places = 2): string => v.toFixed(places);

/**
 * How many files a decision actually causes to run.
 *
 * THE ONE PLACE THIS CAN GO SILENTLY AND CATASTROPHICALLY WRONG. A FULL decision records
 * `selected: 0` - it did not select a small subset, it declined to select at all and runs the whole
 * universe. Summing the raw `selected` field would record DiffCI's most expensive outcome as its
 * cheapest, and on vuejs/core (8 of 25 candidates FULL) that error alone would swing the prediction
 * from NEGATIVE to POSITIVE.
 *
 * So a FULL decision costs `total`, and this lives in a named function rather than inline precisely so
 * that the reasoning has one home.
 */
function effectiveSelection(mode: string, selected: number, total: number): number {
  return mode === "FULL" ? total : selected;
}

function fromCorpus(path: string): Observation {
  const rows = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as CorpusRow);
  if (rows.length === 0) throw new Error(`no observations in ${path}`);

  let comparatorSelected = 0;
  let diffciSelected = 0;
  let analysisCpu = 0;
  let diffciFullRuns = 0;

  for (const row of rows) {
    if (row.decision.mode === "FULL") diffciFullRuns += 1;
    diffciSelected += effectiveSelection(row.decision.mode, row.decision.selected, row.decision.total);
    // The comparator's counterfactual already resolves its own FULL case to the universe size.
    comparatorSelected += row.counterfactual.baselineSelected;
    analysisCpu += row.economics?.jointAnalysisCpuSeconds ?? 0;
  }

  if (analysisCpu === 0) {
    throw new Error(
      "no analysis CPU recorded in this corpus. Refusing to predict: charging DiffCI nothing for its " +
        "own analysis would bias every prediction in DiffCI's favour.",
    );
  }

  return {
    repository: rows[0]!.identity.repository,
    candidates: rows.length,
    comparatorSelected,
    diffciSelected,
    analysisCpu,
    diffciFullRuns,
    source: "observation only - neither the comparator nor the DiffCI arm was executed",
  };
}

function fromBundle(dir: string): { observation: Observation; fullCpu: number } {
  const rows = readFileSync(join(dir, "results.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as ResultRow);

  const measurable = rows.filter((r) => r.economics?.measurable === true);
  if (measurable.length === 0) throw new Error("no compute-measurable candidates in this bundle");

  return {
    fullCpu: measurable[0]!.economics!.full.cpuSeconds!,
    observation: {
      repository: measurable[0]!.repository,
      candidates: measurable.length,
      comparatorSelected: measurable.reduce((a, r) => a + r.economics!.comparator.selectedCount, 0),
      diffciSelected: measurable.reduce((a, r) => a + r.economics!.diffciSelected.selectedCount, 0),
      analysisCpu: measurable.reduce((a, r) => a + (r.economics!.jointAnalysisCpuSeconds ?? 0), 0),
      diffciFullRuns: 0,
      source: "completed economics run, compute-measurable candidates only",
    },
  };
}

function main(): void {
  const args = process.argv.slice(2);
  const flag = (k: string): string | undefined => {
    const i = args.indexOf(`--${k}`);
    return i !== -1 ? args[i + 1] : undefined;
  };

  const corpusPath = flag("corpus");
  const bundlePath = flag("bundle");
  if (!corpusPath && !bundlePath) {
    throw new Error("one of --corpus <corpus.jsonl> or --bundle <frozen run dir> is required");
  }
  if (corpusPath && bundlePath) throw new Error("--corpus and --bundle are alternatives; pass exactly one");

  let observation: Observation;
  let bundleFullCpu: number | undefined;
  if (corpusPath) {
    const p = resolve(corpusPath);
    if (!existsSync(p)) throw new Error(`no such corpus: ${p}`);
    observation = fromCorpus(p);
  } else {
    const d = resolve(bundlePath!);
    if (!existsSync(join(d, "results.jsonl"))) throw new Error("--bundle <frozen run directory> is required");
    const read = fromBundle(d);
    observation = read.observation;
    bundleFullCpu = read.fullCpu;
  }

  // Calibration: preferably measured by `npm run calibrate`, which reads the file count from the runner.
  let fullCpu: number | undefined;
  let testFiles: number | undefined;
  let calibrationSource: string;
  const calibrationPath = flag("calibration");
  if (calibrationPath) {
    const cal = JSON.parse(readFileSync(resolve(calibrationPath), "utf8")) as {
      fullCpuSeconds: number;
      testFiles: number;
      producedAt?: string;
    };
    fullCpu = cal.fullCpuSeconds;
    testFiles = cal.testFiles;
    calibrationSource = `measured by scripts/calibrate-repository.ts${cal.producedAt ? ` at ${cal.producedAt}` : ""}`;
  } else {
    fullCpu = flag("full-cpu") !== undefined ? Number(flag("full-cpu")) : bundleFullCpu;
    testFiles = flag("test-files") !== undefined ? Number(flag("test-files")) : undefined;
    calibrationSource = "supplied on the command line";
  }

  if (fullCpu === undefined || !Number.isFinite(fullCpu) || fullCpu <= 0) {
    throw new Error("full-suite CPU is required: pass --calibration <json> or --full-cpu <seconds>");
  }
  if (testFiles === undefined || !Number.isFinite(testFiles) || testFiles <= 0) {
    // Never defaulted. A guessed denominator rescales the whole prediction invisibly.
    throw new Error("test-file count is required: pass --calibration <json> or --test-files <N>");
  }

  const cpuPerFile = fullCpu / testFiles;
  const avoidedFiles = observation.comparatorSelected - observation.diffciSelected;
  const predictedIncr = avoidedFiles * cpuPerFile - observation.analysisCpu;
  const prediction = predictedIncr > 0 ? "POSITIVE" : "NEGATIVE";
  const verdict = predictedIncr > 0 ? "ECONOMICALLY_FAVOURABLE_PREDICTION" : "ECONOMICALLY_UNFAVOURABLE_PREDICTION";

  const label = flag("label") ?? observation.repository;

  console.log(`\n  DIFFCI ECONOMIC ELIGIBILITY - ${label}\n`);
  console.log(`  Inputs from: ${observation.source}`);
  console.log("\n  Calibration");
  console.log(`    full CPU:            ${n(fullCpu).padStart(10)} CPU-s   (one run)`);
  console.log(`    test files:          ${String(testFiles).padStart(10)}`);
  console.log(`    modelled CPU/file:   ${n(cpuPerFile, 4).padStart(10)} CPU-s`);
  console.log(`    source:              ${calibrationSource}`);
  console.log("\n  Observation");
  console.log(`    candidates:          ${String(observation.candidates).padStart(10)}`);
  console.log(`    comparator selected: ${String(observation.comparatorSelected).padStart(10)} files`);
  console.log(`    DiffCI selected:     ${String(observation.diffciSelected).padStart(10)} files`);
  if (corpusPath) {
    console.log(`      of which FULL:     ${String(observation.diffciFullRuns).padStart(10)} candidates counted at the full universe`);
  }
  console.log(`    avoided files:       ${String(avoidedFiles).padStart(10)}`);
  console.log(`    analysis CPU:        ${n(observation.analysisCpu).padStart(10)} CPU-s`);
  console.log("\n  Predicted incremental CPU");
  console.log(`    ${avoidedFiles} x ${n(cpuPerFile, 4)} - ${n(observation.analysisCpu)}  =  ${n(predictedIncr)} CPU-s`);
  console.log(`\n  Prediction:      ${prediction}`);
  console.log(`  Verdict:         ${verdict}`);
  console.log(
    "\n  This is a PREDICTION, not a directive, and not a savings figure. The rule has one\n" +
      "  out-of-sample validation; it is not yet authoritative for an automated production decision.\n" +
      "  No threshold is applied - the sign is the whole rule.\n",
  );
}

main();
