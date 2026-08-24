/**
 * Pure filename/path decisions for the analysis fan-out CLI's `collect` command (2026-08-23).
 *
 * Extracted from scripts/diffci-analysis-fanout-cli.ts so the overwrite-refusal and retry-naming
 * behaviour is unit-testable without invoking the CLI's network-bound `fetchJson`/`fetchText` paths.
 * This file is NOT part of the frozen engine's checksummed `engineFiles` set.
 */
import { join } from "node:path";

/** The immutable baseline date prefix used across every collect output filename. */
const DATE_PREFIX = "2026-08-23";

/** Row file name for one repository's collected rows. A retry writes a distinctly-named file. */
export function collectRowFileName(short: string, retryRunId: string, retryReason: string): string {
  const baseName = `${DATE_PREFIX}-${short}-blind-baseline-rows`;
  return retryRunId ? `${baseName}-retry-${retryReason || "unknown"}.jsonl` : `${baseName}.jsonl`;
}

/** Run-record filename (one per run, not per repository). */
export function collectRunRecordFileName(runId: string): string {
  return `${DATE_PREFIX}-${runId}-fanout-run-record.json`;
}

/**
 * Resolve the output path for a repository's rows, refusing to overwrite an existing file. The caller
 * must fail (without writing) when `exists` is true; a retry run produces a differently-named path so a
 * completed baseline file is never silently replaced.
 */
export function resolveCollectWrite(
  outDir: string,
  short: string,
  retryRunId: string,
  retryReason: string,
  pathExists: (p: string) => boolean,
): { path: string; exists: boolean } {
  const path = join(outDir, collectRowFileName(short, retryRunId, retryReason));
  return { path, exists: pathExists(path) };
}