/**
 * CI-stage classification from a real GitHub Actions job name (2026-08-25, External Shadow Pilot M1).
 *
 * `fetchBaselineEvidence` (github-baseline.ts) already sums every job's real duration into one lump
 * `baselineDurationMs` - correct for its own purpose (a coarse per-commit total), but wrong to present as
 * "test time" without first separating build/lint/typecheck/e2e time out of it. DiffCI's thesis is CI/CD
 * optimization, not test selection specifically (per explicit direction) - the shadow-economics pipeline
 * must never let a single undifferentiated sum quietly stand in for "test workload."
 *
 * Heuristic, keyword-based, deliberately conservative: a job name that doesn't clearly match a known
 * stage classifies as OTHER rather than being guessed into test/build/lint - a wrong classification would
 * corrupt the very MEASURED tier this pilot's credibility depends on. Pure - no I/O.
 */

export type CiStage = "test" | "build" | "lint" | "typecheck" | "e2e" | "other";

export const STAGE_PATTERNS: readonly { stage: CiStage; pattern: RegExp }[] = [
  // Order matters: more specific patterns first, so e.g. "e2e-test" classifies as e2e, not test.
  { stage: "e2e", pattern: /\b(e2e|end-to-end|playwright|cypress|integration)\b/i },
  { stage: "typecheck", pattern: /\b(typecheck|type-check|tsc)\b/i },
  { stage: "lint", pattern: /\b(lint|eslint|prettier|format(?:ting)?)\b/i },
  { stage: "build", pattern: /\b(build|compile|bundle|package)\b/i },
  { stage: "test", pattern: /\b(test|tests|unit|spec|vitest|jest)\b/i },
];

/** Classifies one real job name into the stage it most likely represents. Never throws, never returns
 * undefined - an unrecognized name is `other`, not silently dropped from the economics picture. */
export function classifyJobStage(jobName: string): CiStage {
  for (const { stage, pattern } of STAGE_PATTERNS) {
    if (pattern.test(jobName)) return stage;
  }
  return "other";
}

export interface StageBucket {
  stage: CiStage;
  /** Real job names that classified into this bucket - audit trail, not just the resulting sum. */
  jobNames: readonly string[];
  totalDurationMs: number;
}

/** Buckets a real job list (BaselineJobInfo-shaped, structurally typed here to avoid an import cycle with
 * shadow/types.ts) by stage and sums each bucket's real durations. Jobs with no known duration (a job
 * that never completed cleanly) are excluded from the sum but still classified, so a stage's total never
 * silently understates by including a null as zero. */
export function bucketJobsByStage(jobs: readonly { jobName: string; durationMs?: number }[]): readonly StageBucket[] {
  const buckets = new Map<CiStage, { jobNames: string[]; totalDurationMs: number }>();
  for (const job of jobs) {
    const stage = classifyJobStage(job.jobName);
    const bucket = buckets.get(stage) ?? { jobNames: [], totalDurationMs: 0 };
    bucket.jobNames.push(job.jobName);
    if (typeof job.durationMs === "number" && job.durationMs > 0) bucket.totalDurationMs += job.durationMs;
    buckets.set(stage, bucket);
  }
  return [...buckets.entries()].map(([stage, b]) => ({ stage, jobNames: b.jobNames, totalDurationMs: b.totalDurationMs }));
}
