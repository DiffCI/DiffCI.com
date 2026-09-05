/**
 * Workflow identity and execution outcome (2026-09-05, measurement-integrity repair step 2, F2/F3 in
 * docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md).
 *
 * Invariant: a GitHub workflow run is not ground truth merely because it is associated with the
 * predicted commit. It must first be proven to be the workflow the prediction is about (identity),
 * and then it must have actually executed (outcome). Repository outcome != execution infrastructure
 * outcome: a run cancelled after 24 h waiting for a runner, a skipped CodeQL run, and a real test
 * failure must never share a population.
 *
 * Both functions are pure so the incident shapes can be pinned in unit tests.
 */
import type { BaselineJobInfo, BaselineRunInfo, ExecutionOutcome } from "./types.js";

/** Picks THE run to reconcile against from everything GitHub returned for a SHA. Only runs of an
 * identified evidence workflow qualify; among those, the highest run id (the latest run of that
 * workflow for this SHA - a re-run reuses the id with a higher attempt, so it is the same choice). */
export function selectEvidenceRun(runs: readonly BaselineRunInfo[], evidenceWorkflowPaths: readonly string[]): BaselineRunInfo | undefined {
  const paths = new Set(evidenceWorkflowPaths);
  let chosen: BaselineRunInfo | undefined;
  for (const run of runs) {
    if (!paths.has(run.workflowPath)) continue;
    if (!chosen || run.workflowRunId > chosen.workflowRunId) chosen = run;
  }
  return chosen;
}

function jobEverStarted(job: BaselineJobInfo): boolean {
  if (job.runnerName && job.runnerName.length > 0) return true;
  if (job.steps && job.steps.length > 0) return true;
  return false;
}

/**
 * Classifies a COMPLETED run. `jobs` are that run's jobs (may be empty when the jobs fetch failed - then
 * a cancelled run is classified conservatively as CANCELLED_DURING_EXECUTION, never as infrastructure,
 * because "no job started" cannot be shown).
 */
export function classifyExecutionOutcome(run: Pick<BaselineRunInfo, "status" | "conclusion">, jobs: readonly BaselineJobInfo[]): ExecutionOutcome {
  const conclusion = (run.conclusion ?? "").toLowerCase();
  if (conclusion === "success" || conclusion === "failure") return "EXECUTED";
  if (conclusion === "skipped") return "SKIPPED";
  if (conclusion === "timed_out") return "TIMED_OUT";
  if (conclusion === "cancelled") {
    if (jobs.length > 0 && jobs.every((j) => !jobEverStarted(j))) return "NOT_EXECUTED_INFRASTRUCTURE";
    return "CANCELLED_DURING_EXECUTION";
  }
  return "NOT_EXECUTED_OTHER";
}

/** Only EXECUTED runs may become ground truth. */
export function isRepositoryOutcome(outcome: ExecutionOutcome): boolean {
  return outcome === "EXECUTED";
}

/** Shape of the explicit config: `.github/workflows/<file>.yml|yaml`, nothing else. */
export const EVIDENCE_WORKFLOW_PATH_PATTERN = /^\.github\/workflows\/[A-Za-z0-9._-]{1,120}\.ya?ml$/;

export function normaliseEvidenceWorkflowPaths(input: unknown): string[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const out: string[] = [];
  for (const v of input) {
    if (typeof v !== "string" || !EVIDENCE_WORKFLOW_PATH_PATTERN.test(v)) return undefined;
    if (!out.includes(v)) out.push(v);
  }
  return out.length > 0 ? out : undefined;
}
