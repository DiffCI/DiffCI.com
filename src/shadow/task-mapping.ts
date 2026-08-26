import type { ExecutionPlan } from "../planner/types.js";
import type { BaselineEvidence, BaselineJobInfo, BaselineStepInfo, ShadowMeasuredMetrics, TaskTiming } from "./types.js";

/** The subset of a registry task this mapping needs: its id, and how the repository invokes it. */
export interface MappableTask {
  id: string;
  command?: string;
  npmScript?: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Which of THIS repository's CI tasks does a given GitHub Actions step correspond to?
 *
 * Phase 01 F4 (2026-08-26). This was a hardcoded table of DentalPresence's own step names -
 * "lint:wordpress", "validate:aws", "next build", "api shield" - so for any other repository it
 * matched nothing (or, worse, matched "build" to a task id that repository has never had). Every
 * timing and failed-task attribution built on it was therefore meaningless off that one repository.
 *
 * The replacement compares each step name against the task ids and script names the repository's own
 * registry declares. It is approximate by nature - a step name is free text written by a human - and
 * the approximation is stated rather than hidden: matching is case-insensitive and substring-based in
 * both directions, and a step that resembles nothing in the registry maps to nothing rather than to a
 * default. It never invents a task, and it never reports a failure that did not occur.
 */
export function taskIdsForStep(stepName: string, tasks: readonly MappableTask[]): string[] {
  const step = normalize(stepName);
  if (step === "") return [];
  const matches: string[] = [];

  for (const task of tasks) {
    // Generic registry ids are shaped "<workflowPath>::<jobId>" (src/research/baseline/workflow-
    // parser.ts); the segment after "::" is what a job or step name usually resembles.
    const idSegment = normalize(task.id.split("::").pop() ?? task.id);
    const fullId = normalize(task.id);
    const script = task.npmScript ? normalize(task.npmScript) : undefined;

    const candidates = [fullId, idSegment, script].filter((c): c is string => c !== undefined && c !== "");
    const hit = candidates.some((candidate) => step === candidate || step.includes(candidate) || candidate.includes(step));
    if (hit) matches.push(task.id);
  }

  return Array.from(new Set(matches));
}

export function flattenSteps(
  baseline: BaselineEvidence,
  tasks: readonly MappableTask[],
): { jobName: string; step: BaselineStepInfo; taskIds: string[] }[] {
  const out: { jobName: string; step: BaselineStepInfo; taskIds: string[] }[] = [];
  for (const job of baseline.jobs) {
    for (const step of job.steps ?? []) {
      const ids = taskIdsForStep(step.name, tasks);
      if (ids.length) out.push({ jobName: job.jobName, step, taskIds: ids });
    }
  }
  return out;
}

export function jobFailed(job: BaselineJobInfo): boolean {
  return job.conclusion === "failure" || job.status === "failed";
}

export function stepFailed(step: BaselineStepInfo): boolean {
  return step.conclusion === "failure" || step.status === "failed";
}

export function failedTaskIds(baseline: BaselineEvidence, tasks: readonly MappableTask[]): string[] {
  const failed = new Set<string>();
  for (const item of flattenSteps(baseline, tasks)) {
    if (stepFailed(item.step)) {
      for (const id of item.taskIds) failed.add(id);
    }
  }
  return Array.from(failed);
}

function taskDuration(baseline: BaselineEvidence, tasks: readonly MappableTask[], taskId: string): number | undefined {
  const matches = flattenSteps(baseline, tasks).filter((i) => i.taskIds.includes(taskId));
  if (!matches.length) return undefined;
  const durations = matches.map((m) => m.step.durationMs).filter((v): v is number => typeof v === "number" && v > 0);
  if (!durations.length) return undefined;
  return durations.reduce((a, b) => a + b, 0);
}

export function buildTaskTimings(tasks: readonly MappableTask[], baseline: BaselineEvidence): TaskTiming[] {
  return tasks.map(({ id: taskId }) => {
    const ms = taskDuration(baseline, tasks, taskId);
    const matchingSteps = flattenSteps(baseline, tasks).filter((i) => i.taskIds.includes(taskId));
    const failed = matchingSteps.some((m) => stepFailed(m.step));
    const skipped = matchingSteps.some((m) => m.step.status === "skipped" || m.step.conclusion === "skipped");
    const jobName = matchingSteps[0]?.jobName;
    let status: TaskTiming["status"] = "unknown";
    if (failed) status = "failed";
    else if (skipped) status = "skipped-by-existing-ci";
    else if (matchingSteps.length) status = "passed";
    return {
      taskId,
      jobName,
      durationMs: ms,
      status,
    };
  });
}

export function computeMeasuredMetrics(
  plan: ExecutionPlan,
  baseline: BaselineEvidence,
  diffCiOverheadMs: number,
): ShadowMeasuredMetrics {
  const timings = buildTaskTimings(plan.tasks, baseline);
  const baselineDurationMs = baseline.baselineDurationMs;

  let retainedDurationMs = 0;
  let skipCandidateDurationMs = 0;
  for (const task of plan.tasks) {
    const timing = timings.find((t) => t.taskId === task.id);
    const ms = timing?.durationMs ?? 0;
    if (task.status === "SKIP_CANDIDATE") {
      skipCandidateDurationMs += ms;
    } else {
      retainedDurationMs += ms;
    }
  }

  const netPotentialTimeSavedMs = skipCandidateDurationMs > 0 ? Math.max(0, skipCandidateDurationMs - diffCiOverheadMs) : undefined;
  const netPotentialReductionPercent = baselineDurationMs && typeof netPotentialTimeSavedMs === "number"
    ? (netPotentialTimeSavedMs / baselineDurationMs) * 100
    : undefined;

  return {
    baselineDurationMs,
    retainedTaskDurationMs: retainedDurationMs || undefined,
    skipCandidateDurationMs: skipCandidateDurationMs || undefined,
    netPotentialTimeSavedMs,
    netPotentialReductionPercent,
  };
}
