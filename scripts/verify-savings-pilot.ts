import { resolve } from "node:path";

export {
  buildVerifySavingsReport as buildReport,
  renderVerifySavingsMarkdown as renderMarkdown,
  runVerifySavings as runPilot,
  type CommandMeasurement,
  type VerifySavingsReport as VerifySavingsPilotReport,
} from "../src/client/verify-savings.js";
import { formatVerifySavingsSummary, runVerifySavings, writeVerifySavingsReport } from "../src/client/verify-savings.js";

interface ParsedArgs {
  full: string;
  selected?: string;
  selectedFromReport?: string;
  out: string;
  markdown?: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  tailBytes: number;
}

function flagValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
}

function numberFlag(args: string[], name: string): number | undefined {
  const raw = flagValue(args, name);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${name} must be a non-negative number`);
  return value;
}

export function parseArgs(args: string[]): ParsedArgs {
  const full = flagValue(args, "full");
  const selected = flagValue(args, "selected");
  const selectedFromReport = flagValue(args, "selected-from-report");
  const out = flagValue(args, "out");
  if (!full) throw new Error("--full <command> is required");
  if (!selected && !selectedFromReport) throw new Error("--selected <command> or --selected-from-report <path> is required");
  if (selected && selectedFromReport) throw new Error("pass only one of --selected or --selected-from-report");
  if (!out) throw new Error("--out <path> is required");

  return {
    full,
    selected,
    selectedFromReport: selectedFromReport ? resolve(selectedFromReport) : undefined,
    out: resolve(out),
    markdown: flagValue(args, "markdown") ? resolve(flagValue(args, "markdown")!) : undefined,
    label: flagValue(args, "label"),
    cwd: resolve(flagValue(args, "cwd") ?? process.cwd()),
    timeoutMs: numberFlag(args, "timeout-ms") ?? 30 * 60 * 1000,
    analysisOverheadMs: numberFlag(args, "analysis-overhead-ms"),
    tailBytes: numberFlag(args, "tail-bytes") ?? 12_000,
  };
}

function main(): void {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runVerifySavings(options);
    writeVerifySavingsReport(report, { out: options.out, markdown: options.markdown });
    console.log(formatVerifySavingsSummary(report));
    console.log(`  report: ${options.out}`);
    if (options.markdown) console.log(`  markdown: ${options.markdown}`);
    if (!report.comparison.evidenceValid) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) main();
