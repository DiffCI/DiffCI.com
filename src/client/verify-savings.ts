import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface CommandMeasurement {
  command: string;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  startedAt: string;
  finishedAt: string;
  wallMs: number;
  stdoutTail: string;
  stderrTail: string;
}

export interface VerifySavingsReport {
  schema: "diffci.verifySavings.v1";
  producedAt: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  selectionSource: "manual" | "diffci-observation";
  observationReportPath?: string;
  selectedTestCount?: number;
  totalTestCount?: number;
  full: CommandMeasurement;
  selected: CommandMeasurement;
  comparison: {
    fullWallMs: number;
    selectedWallMs: number;
    netSelectedMs: number;
    deltaMs: number;
    percentChange: number;
    selectedCommandSucceeded: boolean;
    fullCommandSucceeded: boolean;
    missedFailureSignal: boolean;
  };
  notes: string[];
}

export interface VerifySavingsOptions {
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

interface ResolvedSelection {
  command: string;
  source: "manual" | "diffci-observation";
  observationReportPath?: string;
  selectedTestCount?: number;
  totalTestCount?: number;
  analysisOverheadMs?: number;
}

function tail(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  return value.slice(-bytes);
}

function readSelectionFromObservation(path: string): ResolvedSelection {
  const absolutePath = resolve(path);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8")) as {
    status?: unknown;
    result?: {
      proposedCommands?: unknown;
      selectedTests?: unknown;
      totalTestCount?: unknown;
    };
    timings?: { totalMs?: unknown };
  };
  if (parsed.status !== "OBSERVED") throw new Error(`--selected-from-report requires an OBSERVED report; got ${String(parsed.status)}`);
  const commands = parsed.result?.proposedCommands;
  if (!Array.isArray(commands) || commands.length !== 1 || typeof commands[0] !== "string" || !commands[0].trim()) {
    throw new Error("--selected-from-report requires exactly one non-empty proposed command; use --selected with an explicit command covering the complete selection for multi-command plans");
  }
  const command = commands[0];
  const selectedTests = Array.isArray(parsed.result?.selectedTests) ? parsed.result.selectedTests : undefined;
  return {
    command,
    source: "diffci-observation",
    observationReportPath: absolutePath,
    selectedTestCount: selectedTests?.length,
    totalTestCount: typeof parsed.result?.totalTestCount === "number" ? parsed.result.totalTestCount : undefined,
    analysisOverheadMs: typeof parsed.timings?.totalMs === "number" ? parsed.timings.totalMs : undefined,
  };
}

function resolveSelection(options: VerifySavingsOptions): ResolvedSelection {
  if (options.selectedFromReport) return readSelectionFromObservation(options.selectedFromReport);
  if (!options.selected) throw new Error("--selected <command> or --selected-from-report <path> is required");
  return { command: options.selected, source: "manual" };
}

function measureCommand(command: string, options: Pick<VerifySavingsOptions, "cwd" | "timeoutMs" | "tailBytes">): CommandMeasurement {
  const startedAt = new Date().toISOString();
  const started = Date.now();
  const shellCommand = process.platform === "win32" ? "powershell.exe" : "sh";
  const shellArgv = process.platform === "win32" ? ["-NoProfile", "-NonInteractive", "-Command", command] : ["-c", command];
  const result = spawnSync(shellCommand, shellArgv, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout: options.timeoutMs,
    maxBuffer: 256 * 1024 * 1024,
    shell: false,
    env: {
      ...process.env,
      CI: "1",
      FORCE_COLOR: "0",
      COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
      npm_config_yes: "true",
    },
  });
  const finishedAt = new Date().toISOString();
  return {
    command,
    exitCode: result.status,
    signal: result.signal ?? null,
    timedOut: (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
    startedAt,
    finishedAt,
    wallMs: Date.now() - started,
    stdoutTail: tail(result.stdout ?? "", options.tailBytes),
    stderrTail: tail(result.stderr ?? "", options.tailBytes),
  };
}

export function buildVerifySavingsReport(input: {
  producedAt?: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  selection: Omit<ResolvedSelection, "command" | "analysisOverheadMs">;
  full: CommandMeasurement;
  selected: CommandMeasurement;
}): VerifySavingsReport {
  const overhead = input.analysisOverheadMs ?? 0;
  const netSelectedMs = input.selected.wallMs + overhead;
  const deltaMs = input.full.wallMs - netSelectedMs;
  const percentChange = input.full.wallMs > 0 ? (deltaMs / input.full.wallMs) * 100 : 0;
  const fullCommandSucceeded = input.full.exitCode === 0 && !input.full.timedOut;
  const selectedCommandSucceeded = input.selected.exitCode === 0 && !input.selected.timedOut;
  const missedFailureSignal = !fullCommandSucceeded && selectedCommandSucceeded;

  const notes = [
    "This is paired runtime evidence, not a production-savings claim.",
    "Full and selected commands were run sequentially in the same checkout.",
    input.analysisOverheadMs === undefined
      ? "No analysis overhead was provided, so net selected runtime equals selected command runtime."
      : "Net selected runtime includes DiffCI analysis overhead.",
  ];
  if (missedFailureSignal) notes.push("Full failed while selected passed; inspect outputs before treating the selection as safe.");

  return {
    schema: "diffci.verifySavings.v1",
    producedAt: input.producedAt ?? new Date().toISOString(),
    label: input.label,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    analysisOverheadMs: input.analysisOverheadMs,
    selectionSource: input.selection.source,
    observationReportPath: input.selection.observationReportPath,
    selectedTestCount: input.selection.selectedTestCount,
    totalTestCount: input.selection.totalTestCount,
    full: input.full,
    selected: input.selected,
    comparison: {
      fullWallMs: input.full.wallMs,
      selectedWallMs: input.selected.wallMs,
      netSelectedMs,
      deltaMs,
      percentChange,
      selectedCommandSucceeded,
      fullCommandSucceeded,
      missedFailureSignal,
    },
    notes,
  };
}

function formatMs(ms: number): string {
  if (Math.abs(ms) < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

export function renderVerifySavingsMarkdown(report: VerifySavingsReport): string {
  const deltaLabel = report.comparison.deltaMs >= 0 ? "faster" : "slower";
  const overhead = report.analysisOverheadMs === undefined ? "not provided" : formatMs(report.analysisOverheadMs);
  const title = report.label ? `# DiffCI Verify Savings: ${report.label}` : "# DiffCI Verify Savings";
  const warning = report.comparison.missedFailureSignal
    ? "\n> WARNING: Full failed while selected passed. Do not treat this selected command as safe until the full-run failure is understood.\n"
    : !report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded
      ? "\n> WARNING: One or both commands failed. This comparison is invalid as savings evidence; timings below are diagnostic only.\n"
      : "";
  const selectionCounts =
    report.selectedTestCount !== undefined && report.totalTestCount !== undefined
      ? `\nSelected tests: ${report.selectedTestCount} of ${report.totalTestCount}\n`
      : "";

  return `${title}

Produced at: ${report.producedAt}
Repository label: ${report.label ?? "not provided"}
Selection source: ${report.selectionSource}
${selectionCounts}${warning}

This report compares a full command with a selected command on the same checkout. It is measured pilot evidence, not a production-savings claim.

## Result

${!report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded ? "Comparison invalid: command failure. Do not interpret the timing difference as savings.\n" : ""}
| Measure | Value |
| --- | ---: |
| Full runtime | ${formatMs(report.comparison.fullWallMs)} |
| Selected runtime | ${formatMs(report.comparison.selectedWallMs)} |
| DiffCI analysis overhead | ${overhead} |
| Net selected runtime | ${formatMs(report.comparison.netSelectedMs)} |
| Delta vs full | ${formatMs(report.comparison.deltaMs)} ${deltaLabel} |
| Percent change vs full | ${formatPercent(report.comparison.percentChange)} |

## Commands

| Arm | Exit | Timed out | Command |
| --- | ---: | --- | --- |
| Full | ${report.full.exitCode ?? "signal"} | ${report.full.timedOut ? "yes" : "no"} | \`${report.full.command.replaceAll("|", "\\|")}\` |
| Selected | ${report.selected.exitCode ?? "signal"} | ${report.selected.timedOut ? "yes" : "no"} | \`${report.selected.command.replaceAll("|", "\\|")}\` |

## Interpretation Notes

${report.notes.map((note) => `- ${note}`).join("\n")}
`;
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value, "utf8");
}

export function runVerifySavings(options: VerifySavingsOptions): VerifySavingsReport {
  const selection = resolveSelection(options);
  const analysisOverheadMs = options.analysisOverheadMs ?? selection.analysisOverheadMs;
  const full = measureCommand(options.full, options);
  const selected = measureCommand(selection.command, options);
  return buildVerifySavingsReport({
    label: options.label,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    analysisOverheadMs,
    selection,
    full,
    selected,
  });
}

export function writeVerifySavingsReport(report: VerifySavingsReport, paths: { out: string; markdown?: string }): void {
  writeText(paths.out, `${JSON.stringify(report, null, 2)}\n`);
  if (paths.markdown) writeText(paths.markdown, renderVerifySavingsMarkdown(report));
}

export function formatVerifySavingsSummary(report: VerifySavingsReport): string {
  if (!report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded) {
    return "DiffCI verify-savings: comparison invalid because one or both commands failed" +
      (report.comparison.missedFailureSignal ? "\n  warning: full failed while selected passed; inspect outputs before claiming safety" : "");
  }
  const lines = [
    `DiffCI verify-savings: ${report.comparison.deltaMs >= 0 ? "faster" : "slower"} by ${formatMs(Math.abs(report.comparison.deltaMs))}`,
  ];
  if (report.comparison.missedFailureSignal) {
    lines.push("  warning: full failed while selected passed; inspect outputs before claiming safety");
  }
  return lines.join("\n");
}
