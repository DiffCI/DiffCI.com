/**
 * Cohort-attributable economics (2026-08-25, "close the cohort execution gap" follow-up to Report 18) -
 * separates the real, measured effective-plan wall time (affected selection UNION always-run cohort,
 * actually executed together) from an approximation of how much of that time is attributable to the
 * cohort specifically. Per explicit direction: `economicsBeneficial` must evaluate the ACTUAL execution
 * plan's cost, not a cheaper hypothetical without the cohort - `effectiveWallMs` below IS that real cost
 * (the selected-phase test run's own measured wallMs, once the cohort is unioned into what it invokes);
 * everything else here is additional attribution, not a replacement for that real number.
 *
 * Pure - no clock, no I/O.
 */
import type { EffectiveExecutionPlan } from "./execution-plan.js";
import { cohortOnlyFiles } from "./execution-plan.js";

export interface CohortWorkload {
  affectedFileCount: number;
  /** Files in the cohort but NOT in the engine's own affected selection - the count genuinely attributable
   * to the safety cohort forcing them in. */
  cohortAddedFileCount: number;
  effectiveFileCount: number;
  /** Real measured wall time of the effective plan's own test-run process - the ACTUAL cost, not a
   * hypothetical. Always present (the selected-phase run always produces a wall time). */
  effectiveWallMs: number;
  /** Sum of cohort-only files' own real per-file durations (from the reporter's own timing, see
   * vitest-report.ts's fileDurationsMs) - undefined when ANY cohort-only file's duration is unknown (never
   * a partial, silently-understated sum), or 0 when the cohort added no files at all (nothing to sum, not
   * "unknown"). This is real per-file data, but summing it and subtracting from one combined wall-clock
   * run is still an APPROXIMATION of the cohort's true marginal cost - it does not account for shared,
   * non-linearly-divisible overhead (process startup, module import, worker-pool scheduling) that a
   * cohort-free run would also have paid a share of. Documented as an approximation, never presented as an
   * independently-measured number. */
  cohortAddedWallMsApprox: number | undefined;
  /** effectiveWallMs minus cohortAddedWallMsApprox, only when the latter is known - the APPROXIMATE cost
   * the affected selection alone would have had. See cohortAddedWallMsApprox's own caveat; this inherits
   * it. */
  affectedOnlyWallMsApprox: number | undefined;
}

export function computeCohortWorkload(plan: EffectiveExecutionPlan, fileDurationsMs: Readonly<Record<string, number>>, effectiveWallMs: number): CohortWorkload {
  const cohortOnly = cohortOnlyFiles(plan);
  const allDurationsKnown = cohortOnly.every((f) => typeof fileDurationsMs[f] === "number");
  const cohortAddedWallMsApprox = cohortOnly.length === 0 ? 0 : allDurationsKnown ? cohortOnly.reduce((sum, f) => sum + (fileDurationsMs[f] ?? 0), 0) : undefined;
  return {
    affectedFileCount: plan.affectedFiles.length,
    cohortAddedFileCount: cohortOnly.length,
    effectiveFileCount: plan.effectiveFiles.length,
    effectiveWallMs,
    cohortAddedWallMsApprox,
    affectedOnlyWallMsApprox: cohortAddedWallMsApprox !== undefined ? Math.max(0, effectiveWallMs - cohortAddedWallMsApprox) : undefined,
  };
}
