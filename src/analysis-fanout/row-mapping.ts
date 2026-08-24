/**
 * Row-level failure mapping for the analysis fan-out (2026-08-23).
 *
 * The frozen driver emits its own rich rows on success (`ok: true` plus analysisStatus / affectedTests
 * / totalTestsInGraph / verdict fields). This module maps CONTAINER-LEVEL failures - process killed by
 * the OOM killer (exit 137), a per-step timeout, or a non-zero exit / signal - into minimal rows that
 * carry only `ok: false` + an `errorClass`, with NO DiffCI verdict. A shard that died from resource
 * exhaustion must never look like a successful analysis with "no affected tests".
 *
 * The engine's own fields are never changed or extended here beyond a `container` metrics envelope.
 */
import type { MergeRow } from "./fanout-types.js";

export interface ContainerMetrics {
  shape: string;
  memAvailableBeforeMb?: number;
  memAvailableAfterMb?: number;
  peakRssMb?: number;
  diskFreeBytes?: number;
  cloneWallMs?: number;
  cloneBytes?: number;
}

export interface ExecOutcome {
  success: boolean;
  exitCode: number;
  stdout?: string;
  stderr?: string;
  signal?: string;
  timedOut?: boolean;
}

/** exit 137 is the Linux OOM-killer / SIGKILL convention (128 + SIGKILL). */
export function isResourceKill(exitCode: number | null | undefined): boolean {
  return exitCode === 137;
}

/** Common provenance fields every emitted row carries, mirroring the frozen driver's row envelope. */
function baseRow(merge: MergeRow, repository: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    repository,
    prNumber: merge.prNumber,
    mergeSha: merge.mergeSha,
    baseSha: merge.baseSha,
    mergeTimestamp: merge.mergeTimestamp,
    subject: merge.subject,
    manifestChangedFiles: merge.changedFiles,
    ...extra,
  };
}

/** A container hit the OOM killer. `ok: false` with errorClass, no verdict fields. */
export function resourceKillRow(merge: MergeRow, repository: string, metrics: ContainerMetrics): Record<string, unknown> {
  return baseRow(merge, repository, {
    ok: false,
    errorClass: "resource-kill",
    exitCode: 137,
    container: {
      shape: metrics.shape,
      memAvailableBeforeMb: metrics.memAvailableBeforeMb,
      memAvailableAfterMb: metrics.memAvailableAfterMb,
      peakRssMb: metrics.peakRssMb,
    },
  });
}

/** A per-step wall-clock timeout (the 580 s SDK exec cap, or the frozen driver's own 30 min cap). */
export function timeoutRow(merge: MergeRow, repository: string, error: string): Record<string, unknown> {
  return baseRow(merge, repository, { ok: false, errorClass: "timeout", error });
}

/** Non-zero exit / signal that is not an OOM kill. */
export function exitFailureRow(merge: MergeRow, repository: string, outcome: ExecOutcome): Record<string, unknown> {
  const errorClass = outcome.signal ? `signal:${outcome.signal}` : `exit:${outcome.exitCode}`;
  return baseRow(merge, repository, {
    ok: false,
    errorClass,
    exitCode: outcome.exitCode,
    error: (outcome.stderr ?? "").slice(-1500),
  });
}

/** Pick the correct failure row for a given exec outcome, never inventing a verdict. */
export function mapExecFailureToRow(
  merge: MergeRow,
  repository: string,
  outcome: ExecOutcome,
  metrics: ContainerMetrics,
): Record<string, unknown> {
  if (outcome.timedOut) return timeoutRow(merge, repository, "per-step timeout exceeded");
  if (isResourceKill(outcome.exitCode)) return resourceKillRow(merge, repository, metrics);
  return exitFailureRow(merge, repository, outcome);
}

/** True when a row actually carries a DiffCI verdict (a successful analysis). Used by tests to prove
 * failure rows never do. */
export function hasVerdict(row: Record<string, unknown>): boolean {
  return (
    typeof row === "object" &&
    row !== null &&
    "analysisStatus" in row &&
    "affectedTests" in row &&
    "totalTestsInGraph" in row
  );
}