/**
 * Always-run cohort (2026-08-25, "production-safe selective execution loop" follow-up to Report 17).
 *
 * Purpose: even when the selection engine picks a tiny affected set, force a small, deterministic cohort
 * of historically unstable/high-signal tests to run alongside it - not because they're expected to be
 * affected by THIS change, but to keep continuously measuring whether their behavior is still consistent
 * with the rolling fingerprint's own model of them (still just known noise, or has something changed).
 * This is part of what eventually lets NOT_MEASURED become measured for MOST runs without paying for a
 * full suite every time - see audit-sampling.ts for the other half (a small sampled fraction that DOES
 * run the full suite).
 *
 * Deliberately test-FILE granularity, not individual test IDs: the execution harness selects/skips whole
 * files, not individual tests within a file - a cohort entry is only actionable once translated back to
 * the file that contains it.
 *
 * Pure - no clock, no I/O; the caller supplies the rolling fingerprint's current state.
 */
import type { RollingFingerprint } from "./rolling-fingerprint.js";

export interface CohortPolicy {
  /** Hard cap on cohort size, independent of how many tracked tests exist - this exists specifically to
   * bound how much the cohort can erode the economic savings selective execution exists to provide; a
   * cohort that grows without bound defeats the point. */
  maxCohortSize: number;
  /** A tracked (testId, signature) entry needs at least this many observations before it's "high-signal"
   * enough to include - a single-observation entry is exactly the kind classifyStability already refuses
   * to trust as known/stable; the cohort should not be built from noise either. */
  minObservations: number;
}

export const DEFAULT_COHORT_POLICY: CohortPolicy = { maxCohortSize: 5, minObservations: 2 };

/** Extracts the file path from a testId of the "<file> :: <fullName>" shape this mission's own
 * vitest-report.ts constructs (parseVitestJsonReport). Falls back to the whole testId if the separator is
 * absent - never throws, never silently drops a candidate. */
function fileOf(testId: string): string {
  const idx = testId.indexOf(" :: ");
  return idx === -1 ? testId : testId.slice(0, idx);
}

export interface CohortSourceEntry {
  testId: string;
  file: string;
  observationCount: number;
}

export interface CohortSelection {
  /** File paths to force into the executed set, deduplicated, in descending-frequency order. */
  files: readonly string[];
  /** The tracked entries this cohort was built from, for audit - which testId/signature drove each file's
   * inclusion, not just the resulting file list. */
  sourceEntries: readonly CohortSourceEntry[];
}

const EMPTY_SELECTION: CohortSelection = { files: [], sourceEntries: [] };

/**
 * Picks up to `maxCohortSize` distinct FILES (not test entries - two tracked entries in the same file only
 * count once toward the cap) by observation count among tracked entries meeting `minObservations`. Ties
 * broken by testId for determinism (never by insertion order alone, which would make this policy's output
 * depend on incidental map-iteration order rather than anything meaningful).
 */
export function selectAlwaysRunCohort(rolling: RollingFingerprint | undefined, policy: CohortPolicy = DEFAULT_COHORT_POLICY): CohortSelection {
  if (!rolling) return EMPTY_SELECTION;

  const eligible = rolling.tracked
    .filter((t) => t.observations.length >= policy.minObservations)
    .map((t) => ({ testId: t.testId, file: fileOf(t.testId), observationCount: t.observations.length }))
    .sort((a, b) => b.observationCount - a.observationCount || a.testId.localeCompare(b.testId));

  const files: string[] = [];
  const seenFiles = new Set<string>();
  const sourceEntries: CohortSourceEntry[] = [];
  for (const e of eligible) {
    if (files.length >= policy.maxCohortSize) break;
    if (seenFiles.has(e.file)) continue; // one file may contain multiple tracked tests - counts once
    seenFiles.add(e.file);
    files.push(e.file);
    sourceEntries.push(e);
  }
  return { files, sourceEntries };
}
