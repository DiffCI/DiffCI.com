import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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
  schema: "diffci.verifySavings.v2";
  producedAt: string;
  label?: string;
  cwd: string;
  timeoutMs: number;
  analysisOverheadMs?: number;
  selectionSource: "manual" | "diffci-observation";
  observationReportPath?: string;
  selectedTestCount?: number;
  totalTestCount?: number;
  provenance: SavingsProvenance;
  full: CommandMeasurement;
  selected: CommandMeasurement;
  comparison: {
    fullWallMs: number;
    selectedWallMs: number;
    netSelectedMs: number;
    deltaMs: number;
    grossPercentChange: number;
    percentChange: number;
    selectedCommandSucceeded: boolean;
    fullCommandSucceeded: boolean;
    missedFailureSignal: boolean;
    evidenceValid: boolean;
  };
  notes: string[];
}

export interface CheckoutSnapshot {
  capturedAt: string;
  headSha?: string;
  worktreeDigest?: string;
}

export interface SavingsProvenance {
  baseSha?: string;
  headSha?: string;
  observationSha256?: string;
  observerVersion?: string;
  beforeFull: CheckoutSnapshot;
  afterFull: CheckoutSnapshot;
  afterSelected: CheckoutSnapshot;
  checkoutStable: boolean;
  invalidReasons: string[];
}

export interface VerifySavingsOptions {
  full: string;
  selected?: string;
  selectedFromReport?: string;
  selectedCommandOverride?: string;
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
  baseSha?: string;
  headSha?: string;
  observationSha256?: string;
  observerVersion?: string;
}

function tail(value: string, bytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= bytes) return value;
  return value.slice(-bytes);
}

function readSelectionFromObservation(path: string): ResolvedSelection {
  const absolutePath = resolve(path);
  const bytes = readFileSync(absolutePath);
  const parsed = JSON.parse(bytes.toString("utf8")) as {
    status?: unknown;
    observer?: { version?: unknown };
    commitRange?: { baseSha?: unknown; headSha?: unknown };
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
    baseSha: typeof parsed.commitRange?.baseSha === "string" ? parsed.commitRange.baseSha : undefined,
    headSha: typeof parsed.commitRange?.headSha === "string" ? parsed.commitRange.headSha : undefined,
    observationSha256: createHash("sha256").update(bytes).digest("hex"),
    observerVersion: typeof parsed.observer?.version === "string" ? parsed.observer.version : undefined,
  };
}

function checkoutSnapshot(cwd: string): CheckoutSnapshot {
  const capturedAt = new Date().toISOString();
  try {
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    const status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all"], { cwd, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] });
    return { capturedAt, headSha, worktreeDigest: createHash("sha256").update(status).digest("hex") };
  } catch {
    return { capturedAt };
  }
}

function buildProvenance(selection: ResolvedSelection, beforeFull: CheckoutSnapshot, afterFull: CheckoutSnapshot, afterSelected: CheckoutSnapshot): SavingsProvenance {
  const invalidReasons: string[] = [];
  const snapshots = [beforeFull, afterFull, afterSelected];
  const expectedHeadSha = selection.headSha ?? (selection.source === "manual" ? beforeFull.headSha : undefined);
  if (snapshots.some(snapshot => !snapshot.headSha || !snapshot.worktreeDigest)) invalidReasons.push("checkout identity could not be captured for every execution boundary");
  if (expectedHeadSha && snapshots.some(snapshot => snapshot.headSha !== expectedHeadSha)) invalidReasons.push("executed checkout HEAD did not match the bound head SHA at every boundary");
  if (!expectedHeadSha) invalidReasons.push("no head SHA was available to bind the execution");
  if (new Set(snapshots.map(snapshot => snapshot.headSha)).size !== 1) invalidReasons.push("checkout HEAD changed during paired execution");
  if (new Set(snapshots.map(snapshot => snapshot.worktreeDigest)).size !== 1) invalidReasons.push("worktree changed during paired execution");
  return {
    baseSha: selection.baseSha,
    headSha: expectedHeadSha,
    observationSha256: selection.observationSha256,
    observerVersion: selection.observerVersion,
    beforeFull,
    afterFull,
    afterSelected,
    checkoutStable: invalidReasons.length === 0,
    invalidReasons,
  };
}

function resolveSelection(options: VerifySavingsOptions): ResolvedSelection {
  if (options.selectedFromReport) {
    const selection = readSelectionFromObservation(options.selectedFromReport);
    return options.selectedCommandOverride ? { ...selection, command: options.selectedCommandOverride } : selection;
  }
  if (!options.selected) throw new Error("--selected <command> or --selected-from-report <path> is required");
  return { command: options.selected, source: "manual" };
}

export function measureCommand(command: string, options: Pick<VerifySavingsOptions, "cwd" | "timeoutMs" | "tailBytes">): CommandMeasurement {
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
  provenance?: SavingsProvenance;
}): VerifySavingsReport {
  const overhead = input.analysisOverheadMs ?? 0;
  const netSelectedMs = input.selected.wallMs + overhead;
  const deltaMs = input.full.wallMs - netSelectedMs;
  const grossPercentChange = input.full.wallMs > 0 ? ((input.full.wallMs - input.selected.wallMs) / input.full.wallMs) * 100 : 0;
  const percentChange = input.full.wallMs > 0 ? (deltaMs / input.full.wallMs) * 100 : 0;
  const fullCommandSucceeded = input.full.exitCode === 0 && !input.full.timedOut;
  const selectedCommandSucceeded = input.selected.exitCode === 0 && !input.selected.timedOut;
  const missedFailureSignal = !fullCommandSucceeded && selectedCommandSucceeded;
  const evidenceValid = fullCommandSucceeded && selectedCommandSucceeded && (input.provenance?.checkoutStable ?? false);

  const notes = [
    "This is paired runtime evidence, not a production-savings claim.",
    "Full and selected commands were run sequentially in the same checkout.",
    input.analysisOverheadMs === undefined
      ? "No analysis overhead was provided, so net selected runtime equals selected command runtime."
      : "Net selected runtime includes DiffCI analysis overhead.",
  ];
  if (missedFailureSignal) notes.push("Full failed while selected passed; inspect outputs before treating the selection as safe.");
  if (input.provenance && !input.provenance.checkoutStable) notes.push(`Checkout provenance invalid: ${input.provenance.invalidReasons.join("; ")}.`);

  return {
    schema: "diffci.verifySavings.v2",
    producedAt: input.producedAt ?? new Date().toISOString(),
    label: input.label,
    cwd: input.cwd,
    timeoutMs: input.timeoutMs,
    analysisOverheadMs: input.analysisOverheadMs,
    selectionSource: input.selection.source,
    observationReportPath: input.selection.observationReportPath,
    selectedTestCount: input.selection.selectedTestCount,
    totalTestCount: input.selection.totalTestCount,
    provenance: input.provenance ?? {
      beforeFull: { capturedAt: input.full.startedAt },
      afterFull: { capturedAt: input.full.finishedAt },
      afterSelected: { capturedAt: input.selected.finishedAt },
      checkoutStable: false,
      invalidReasons: ["checkout provenance was not captured"],
    },
    full: input.full,
    selected: input.selected,
    comparison: {
      fullWallMs: input.full.wallMs,
      selectedWallMs: input.selected.wallMs,
      netSelectedMs,
      deltaMs,
      grossPercentChange,
      percentChange,
      selectedCommandSucceeded,
      fullCommandSucceeded,
      missedFailureSignal,
      evidenceValid,
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
      : !report.comparison.evidenceValid
        ? `\n> WARNING: Checkout provenance validation failed: ${report.provenance.invalidReasons.join("; ")}. Timings are diagnostic only.\n`
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

${!report.comparison.fullCommandSucceeded || !report.comparison.selectedCommandSucceeded ? "Comparison invalid: command failure. Do not interpret the timing difference as savings.\n" : !report.comparison.evidenceValid ? "Comparison invalid: checkout identity changed or could not be verified. Do not interpret the timing difference as savings.\n" : ""}
| Measure | Value |
| --- | ---: |
| Full runtime | ${formatMs(report.comparison.fullWallMs)} |
| Selected runtime | ${formatMs(report.comparison.selectedWallMs)} |
| Test execution change vs full | ${formatPercent(report.comparison.grossPercentChange)} |
| DiffCI analysis overhead | ${overhead} |
| Net selected runtime | ${formatMs(report.comparison.netSelectedMs)} |
| Delta vs full | ${formatMs(report.comparison.deltaMs)} ${deltaLabel} |
| Percent change vs full | ${formatPercent(report.comparison.percentChange)} |

## Provenance

| Field | Value |
| --- | --- |
| Base SHA | \`${report.provenance.baseSha ?? "unavailable"}\` |
| Head SHA | \`${report.provenance.headSha ?? "unavailable"}\` |
| Observation SHA-256 | \`${report.provenance.observationSha256 ?? "unavailable"}\` |
| DiffCI observer version | ${report.provenance.observerVersion ?? "unavailable"} |
| Checkout stable across both arms | ${report.provenance.checkoutStable ? "yes" : "no"} |

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
  const beforeFull = checkoutSnapshot(options.cwd);
  const full = measureCommand(options.full, options);
  const afterFull = checkoutSnapshot(options.cwd);
  const selected = measureCommand(selection.command, options);
  const afterSelected = checkoutSnapshot(options.cwd);
  const provenance = buildProvenance(selection, beforeFull, afterFull, afterSelected);
  return buildVerifySavingsReport({
    label: options.label,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    analysisOverheadMs,
    selection,
    full,
    selected,
    provenance,
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
  if (!report.comparison.evidenceValid) {
    return `DiffCI verify-savings: comparison invalid because checkout provenance failed\n  ${report.provenance.invalidReasons.join("; ")}`;
  }
  const lines = [
    `DiffCI verify-savings: test execution ${Math.abs(report.comparison.grossPercentChange).toFixed(1)}% ${report.comparison.grossPercentChange >= 0 ? "faster" : "slower"} in this paired run`,
    `  full: ${formatMs(report.comparison.fullWallMs)}`,
    `  selected: ${formatMs(report.comparison.selectedWallMs)} + analysis ${formatMs(report.analysisOverheadMs ?? 0)} = ${formatMs(report.comparison.netSelectedMs)}`,
    `  net including analysis: ${Math.abs(report.comparison.percentChange).toFixed(1)}% ${report.comparison.deltaMs >= 0 ? "faster" : "slower"} (${formatMs(Math.abs(report.comparison.deltaMs))} ${report.comparison.deltaMs >= 0 ? "saved" : "added"})`,
  ];
  if (report.comparison.missedFailureSignal) {
    lines.push("  warning: full failed while selected passed; inspect outputs before claiming safety");
  }
  return lines.join("\n");
}
