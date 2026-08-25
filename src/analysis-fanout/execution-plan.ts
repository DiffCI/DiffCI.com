/**
 * Effective execution plan (2026-08-25, "close the cohort execution gap" follow-up to Report 18) - unions
 * the selection engine's own AFFECTED file set with the always-run cohort's files into the set that is
 * ACTUALLY requested from the test runner, with explicit per-file provenance. Closes the gap Report 18
 * left open: the always-run cohort was computed and recorded, but never forced into what executes.
 *
 * Deliberately does NOT touch `affectedFiles` itself (the frozen selection engine's own output stays
 * exactly what it was - this module only unions it with the cohort for the purpose of what gets EXECUTED,
 * never reinterprets or narrows the engine's own selection). Pure - no clock, no I/O.
 */

export type TestProvenance = "AFFECTED" | "ALWAYS_RUN" | "BOTH";

export interface TestProvenanceEntry {
  file: string;
  provenance: TestProvenance;
}

export interface EffectiveExecutionPlan {
  /** Deduplicated, sorted copy of the selection engine's own affected-file output - unchanged in meaning
   * from `record.selectedTestPaths` elsewhere in this codebase. */
  affectedFiles: readonly string[];
  /** Deduplicated, sorted copy of the always-run cohort's own files (always-run-cohort.ts). */
  cohortFiles: readonly string[];
  /** The union - deduplicated, sorted for determinism - this is what actually gets requested from the test
   * runner. Sorted (not insertion-order) so the SAME two input sets always produce the SAME effective file
   * list regardless of which one happened to be iterated first. */
  effectiveFiles: readonly string[];
  /** One entry per effectiveFiles member, tagging WHY it's in the plan - AFFECTED (selection engine only),
   * ALWAYS_RUN (cohort only), or BOTH (the engine picked it too, independent of the cohort forcing it). */
  provenance: readonly TestProvenanceEntry[];
}

export function buildEffectiveExecutionPlan(affectedFiles: readonly string[], cohortFiles: readonly string[]): EffectiveExecutionPlan {
  const affectedSet = new Set(affectedFiles);
  const cohortSet = new Set(cohortFiles);
  const effectiveFiles = [...new Set([...affectedFiles, ...cohortFiles])].sort();
  const provenance: TestProvenanceEntry[] = effectiveFiles.map((file) => {
    const inAffected = affectedSet.has(file);
    const inCohort = cohortSet.has(file);
    const provenanceValue: TestProvenance = inAffected && inCohort ? "BOTH" : inCohort ? "ALWAYS_RUN" : "AFFECTED";
    return { file, provenance: provenanceValue };
  });
  return {
    affectedFiles: [...affectedSet].sort(),
    cohortFiles: [...cohortSet].sort(),
    effectiveFiles,
    provenance,
  };
}

/** Files whose provenance is ALWAYS_RUN only (the cohort-added-and-not-otherwise-selected subset) - the
 * files whose execution cost is genuinely attributable to the safety cohort, not the selection engine. */
export function cohortOnlyFiles(plan: EffectiveExecutionPlan): readonly string[] {
  return plan.provenance.filter((p) => p.provenance === "ALWAYS_RUN").map((p) => p.file);
}
