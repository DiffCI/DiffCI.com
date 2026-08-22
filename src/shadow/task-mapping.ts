import type { ExecutionPlan } from "../planner/types.js";
import type { BaselineEvidence, BaselineJobInfo, BaselineStepInfo, ShadowMeasuredMetrics, TaskTiming } from "./types.js";

export function taskIdsForStep(stepName: string): string[] {
  const n = stepName.toLowerCase();
  const matches: string[] = [];
  if (n.includes("typecheck") || n.includes("tsc")) matches.push("typecheck");
  if (n.includes("lint:wordpress") || n.includes("wordpress")) matches.push("lint:wordpress");
  else if (n.includes("lint")) matches.push("lint");
  if (n.includes("check:unused") || n.includes("unused source")) matches.push("check:unused");
  if (n.includes("check:links")) matches.push("check:links");
  if (n.includes("social-utm")) matches.push("check:social-utm");
  if (n.includes("check:routes") || n.includes("unused routes")) matches.push("check:routes");
  if (n.includes("cloudflare-api-shield") || n.includes("api shield")) matches.push("check:cloudflare-api-shield");
  if (n.includes("validate:aws") || n.includes("aws drift")) matches.push("validate:aws-staging-drift");
  if (n.includes("source tests") || n.includes("test:source")) matches.push("test:source");
  if (n.includes("script tests") || n.includes("test:scripts")) matches.push("test:scripts");
  if (n.includes("ops tests") || n.includes("test:ops")) matches.push("test:ops");
  if (n.includes("test:security") || n.includes("security validation")) matches.push("test:security");
  if (n.includes("api-guardrails") || n.includes("api guardrails")) matches.push("test:api-guardrails");
  if (n.includes("next build") || n.includes("build:next") || (n.includes("build") && !n.includes("dry"))) matches.push("build:next");
  if (n.includes("cloudflare") && n.includes("dry")) matches.push("build:cloudflare-dry-run");
  if (n.includes("migration") || n.includes("db:check-parity")) matches.push("check:migrations");
  return Array.from(new Set(matches));
}

export function flattenSteps(baseline: BaselineEvidence): { jobName: string; step: BaselineStepInfo; taskIds: string[] }[] {
  const out: { jobName: string; step: BaselineStepInfo; taskIds: string[] }[] = [];
  for (const job of baseline.jobs) {
    for (const step of job.steps ?? []) {
      const ids = taskIdsForStep(step.name);
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

export function failedTaskIds(baseline: BaselineEvidence): string[] {
  const failed = new Set<string>();
  for (const item of flattenSteps(baseline)) {
    if (!stepFailed(item.step)) {
      for (const id of item.taskIds) failed.add(id);
    }
  }
  return Array.from(failed);
}

function taskDuration(baseline: BaselineEvidence, taskId: string): number | undefined {
  const matches = flattenSteps(baseline).filter((i) => i.taskIds.includes(taskId));
  if (!matches.length) return undefined;
  const durations = matches.map((m) => m.step.durationMs).filter((v): v is number => typeof v === "number" && v > 0);
  if (!durations.length) return undefined;
  return durations.reduce((a, b) => a + b, 0);
}

export function buildTaskTimings(registryTaskIds: string[], baseline: BaselineEvidence): TaskTiming[] {
  return registryTaskIds.map((taskId) => {
    const ms = taskDuration(baseline, taskId);
    const matchingSteps = flattenSteps(baseline).filter((i) => i.taskIds.includes(taskId));
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
  const registryTaskIds = plan.tasks.map((t) => t.id);
  const timings = buildTaskTimings(registryTaskIds, baseline);
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
