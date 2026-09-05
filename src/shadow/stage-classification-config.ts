/**
 * Explicit, per-repository CI stage classification (2026-09-05, measurement-integrity repair step 3,
 * research note F4).
 *
 * Why the substring classifier (stage-classification.ts classifyJobStage) was not enough: DiffCI.com's
 * only CI job is named "check" and DentalPresence.in runs its tests inside a job named "Build and deploy
 * exact commit to Cloudflare". Neither contains "test", so no row for either repository could ever carry
 * a test-stage figure, and "0 estimated savings" said nothing about savings.
 *
 * Rules:
 *   - Explicit configuration wins. A repository declares job rules and step rules by EXACT name. Step
 *     rules attribute that step's own measured duration; a job rule attributes the job's duration MINUS
 *     whatever its step rules already attributed. Anything in a configured repository that no rule
 *     covers is 'other' with basis 'unclassified' - never inferred, because an explicit configuration
 *     is expected to be complete.
 *   - Conservative inference only when a repository has NO configuration at all: the legacy keyword
 *     patterns, but a job name must match exactly one stage's keywords or it is 'other'/'unclassified'.
 *   - `inseparable: true` on a rule says the measured workload contains non-stage work that cannot be
 *     separated (e.g. a single `npm run check` step that typechecks AND tests, or `npm ci && npm test`
 *     in one step). The measurement is kept and labelled; no avoidable-work estimate is derived from it.
 *
 * Pure: takes a run's jobs (with steps and durations, as github-baseline.ts parses them) and a config,
 * returns per-stage buckets with provenance. Nothing here touches D1 or GitHub.
 */
import type { BaselineJobInfo } from "./types.js";
import { STAGE_PATTERNS, type CiStage } from "./stage-classification.js";

export const STAGE_CLASSIFIER_VERSION = 1;

export const CI_STAGES: readonly CiStage[] = ["test", "build", "lint", "typecheck", "e2e", "other"];

export type ClassificationBasis =
  | "explicit_step"
  | "explicit_step_inseparable"
  | "explicit_job"
  | "explicit_job_inseparable"
  | "inferred_job"
  | "unclassified";

export interface JobRule {
  job: string;
  stage: CiStage;
  inseparable?: boolean;
}

export interface StepRule {
  job: string;
  step: string;
  stage: CiStage;
  inseparable?: boolean;
}

export interface StageClassificationConfig {
  version: 1;
  jobs: JobRule[];
  steps: StepRule[];
}

/** Validates an untrusted JSON value into a config, or returns undefined with a reason. */
export function parseStageClassificationConfig(input: unknown): { config?: StageClassificationConfig; error?: string } {
  if (!input || typeof input !== "object") return { error: "config must be an object" };
  const o = input as Record<string, unknown>;
  if (o.version !== 1) return { error: "version must be 1" };
  const jobs = Array.isArray(o.jobs) ? o.jobs : [];
  const steps = Array.isArray(o.steps) ? o.steps : [];
  const parsedJobs: JobRule[] = [];
  for (const j of jobs) {
    const r = j as Record<string, unknown>;
    if (typeof r.job !== "string" || r.job.length === 0 || r.job.length > 200) return { error: "job rule needs a non-empty job name" };
    if (!CI_STAGES.includes(r.stage as CiStage)) return { error: `job rule for '${r.job}' has an unknown stage` };
    if (r.inseparable !== undefined && typeof r.inseparable !== "boolean") return { error: "inseparable must be boolean" };
    parsedJobs.push({ job: r.job, stage: r.stage as CiStage, ...(r.inseparable ? { inseparable: true } : {}) });
  }
  const parsedSteps: StepRule[] = [];
  for (const s of steps) {
    const r = s as Record<string, unknown>;
    if (typeof r.job !== "string" || r.job.length === 0 || typeof r.step !== "string" || r.step.length === 0) return { error: "step rule needs job and step names" };
    if (!CI_STAGES.includes(r.stage as CiStage)) return { error: `step rule for '${r.job} :: ${r.step}' has an unknown stage` };
    if (r.inseparable !== undefined && typeof r.inseparable !== "boolean") return { error: "inseparable must be boolean" };
    parsedSteps.push({ job: r.job, step: r.step, stage: r.stage as CiStage, ...(r.inseparable ? { inseparable: true } : {}) });
  }
  if (parsedJobs.length === 0 && parsedSteps.length === 0) return { error: "config must contain at least one job or step rule" };
  const seenJobs = new Set<string>();
  for (const j of parsedJobs) {
    if (seenJobs.has(j.job)) return { error: `duplicate job rule for '${j.job}'` };
    seenJobs.add(j.job);
  }
  const seenSteps = new Set<string>();
  for (const s of parsedSteps) {
    const k = `${s.job} :: ${s.step}`;
    if (seenSteps.has(k)) return { error: `duplicate step rule for '${k}'` };
    seenSteps.add(k);
  }
  return { config: { version: 1, jobs: parsedJobs, steps: parsedSteps } };
}

export interface StageAttribution {
  stage: CiStage;
  basis: ClassificationBasis;
  /** Real measured milliseconds attributed to this stage under this basis. */
  durationMs: number;
  jobIds: number[];
  /** "job name :: step name" for every step-level attribution in this bucket. */
  stepRefs: string[];
  jobNames: string[];
}

/** Conservative inference: exactly one stage's keyword set must match, otherwise 'other'. */
export function inferStageConservatively(jobName: string): CiStage | undefined {
  const matches = STAGE_PATTERNS.filter((p) => p.pattern.test(jobName)).map((p) => p.stage);
  const distinct = [...new Set(matches)];
  return distinct.length === 1 ? distinct[0] : undefined;
}

/**
 * Attributes a run's real job/step durations to stages. One bucket per (stage, basis) so a stage
 * measured both separably and inseparably is never silently summed into one number.
 */
export function classifyRunJobs(jobs: readonly BaselineJobInfo[], config: StageClassificationConfig | undefined): StageAttribution[] {
  const buckets = new Map<string, StageAttribution>();
  const add = (stage: CiStage, basis: ClassificationBasis, durationMs: number, job: BaselineJobInfo, stepRef?: string) => {
    if (!(durationMs > 0)) return;
    const key = `${stage}|${basis}`;
    const b = buckets.get(key) ?? { stage, basis, durationMs: 0, jobIds: [], stepRefs: [], jobNames: [] };
    b.durationMs += durationMs;
    if (!b.jobIds.includes(job.jobId)) b.jobIds.push(job.jobId);
    if (!b.jobNames.includes(job.jobName)) b.jobNames.push(job.jobName);
    if (stepRef) b.stepRefs.push(stepRef);
    buckets.set(key, b);
  };

  for (const job of jobs) {
    const jobMs = typeof job.durationMs === "number" && job.durationMs > 0 ? job.durationMs : 0;
    if (!config) {
      const inferred = inferStageConservatively(job.jobName);
      add(inferred ?? "other", inferred ? "inferred_job" : "unclassified", jobMs, job);
      continue;
    }
    let attributedByStepsMs = 0;
    for (const rule of config.steps) {
      if (rule.job !== job.jobName) continue;
      const step = job.steps?.find((s) => s.name === rule.step);
      if (!step || typeof step.durationMs !== "number" || step.durationMs <= 0) continue;
      attributedByStepsMs += step.durationMs;
      add(rule.stage, rule.inseparable ? "explicit_step_inseparable" : "explicit_step", step.durationMs, job, `${job.jobName} :: ${rule.step}`);
    }
    const remainderMs = Math.max(0, jobMs - attributedByStepsMs);
    const jobRule = config.jobs.find((r) => r.job === job.jobName);
    if (jobRule) add(jobRule.stage, jobRule.inseparable ? "explicit_job_inseparable" : "explicit_job", remainderMs, job);
    else add("other", "unclassified", remainderMs, job);
  }
  return [...buckets.values()];
}

export function isInseparable(basis: ClassificationBasis): boolean {
  return basis === "explicit_step_inseparable" || basis === "explicit_job_inseparable";
}
