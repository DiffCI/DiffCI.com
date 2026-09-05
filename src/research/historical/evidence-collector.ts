/**
 * Historical CI evidence collection for the Stage 0 research pipeline. Reuses the existing, already-
 * working shadow-mode GitHub Actions fetcher (src/shadow/github-baseline.ts) rather than reimplementing
 * run/job fetching - see the gap analysis and architecture docs (diffci/docs/research/2026-08-20-*).
 *
 * Deltas are paced under a per-run GitHub REST rate budget (rate-budget.ts). Once the budget for the
 * current rolling hour is exhausted, remaining deltas are marked UNAVAILABLE with an explicit reason
 * rather than silently skipped - the Stage 0 spec requires every delta's evidence status be honestly
 * classified as MEASURABLE / PARTIALLY_MEASURABLE / UNAVAILABLE, never left ambiguous.
 *
 * IMPORTANT: only task-level failure recall is computed here. GitHub Actions job-level evidence tells
 * us which CI jobs failed, but not which individual tests failed within them - that would require
 * parsing test-report artifacts (JUnit XML etc.), which no part of this codebase currently does. Test-
 * level failure recall must be reported as NOT MEASURABLE until that capability exists; do not infer it
 * from job-level data.
 *
 * NOT reused: src/shadow/failure-recall.ts's buildFailureRecallRecords() and its underlying
 * src/shadow/task-mapping.ts's failedTaskIds(). Both are hardcoded to DentalPresence's own step-name
 * vocabulary (literal keywords like "typecheck", "lint:wordpress", "validate:aws-staging-drift") and
 * would silently match nothing against the research corpus's arbitrary external-repo task ids -
 * exactly the kind of systematic false-negative the Stage 0 spec's safety section warns about. This
 * module instead matches failed GitHub Actions job names directly against the generic task registry's
 * ids (see matchFailedTaskIds() below), which is repo-agnostic by construction.
 */
import type { ExecutionPlan } from "../../planner/types.js";
import type { BaselineEvidence, ReconcilePendingReason } from "../../shadow/types.js";
import { fetchBaselineEvidence } from "../../shadow/github-baseline.js";
import type { HistoricalEvidenceStatus } from "../types.js";
import { chargeBudget, hasBudgetFor, type RateBudget } from "./rate-budget.js";
import { checkJobFlakiness } from "./flakiness-check.js";

function normalizeJobName(name: string): string {
  return name.trim().toLowerCase();
}

/** Best-effort match of failed GitHub Actions jobs to generic research task ids. The generic task
 * registry's ids are shaped "<workflowPathWithoutExt>::<jobId>" (src/research/baseline/workflow-
 * parser.ts); GitHub's Jobs API returns each job's display name, which is normally either the job's
 * YAML `name:` field or (if unset) its YAML key - i.e. usually resembles the id segment after "::".
 * This compares job names against that segment (and the full id) case-insensitively, exact-or-
 * substring. This is inherently approximate: a repository whose workflow job names don't resemble
 * either their YAML key or a recognizable label will not match well, and a delta's historical evidence
 * status only reflects whether GitHub data was successfully FETCHED, not match confidence - a genuine
 * limitation, stated here rather than silently assumed away. This heuristic only affects WHICH failed
 * job maps to which task id; it never fabricates a failure that didn't actually occur in the baseline. */
/** Same matching as matchFailedTaskIds() but preserves which real (non-normalized) GitHub job name
 * matched each task id - needed by the Stage 1B flakiness check, which must query GitHub's check-runs
 * API using the job's actual display name, not DiffCI's internal task id. */
export function matchFailedTaskIdsWithJobNames(baseline: BaselineEvidence, plan: ExecutionPlan): Map<string, string> {
  const failedJobs = new Map<string, string>(); // normalized -> original display name
  for (const name of baseline.failedJobNames) failedJobs.set(normalizeJobName(name), name);
  for (const job of baseline.jobs) {
    if (job.conclusion === "failure" || job.status === "failed") failedJobs.set(normalizeJobName(job.jobName), job.jobName);
  }
  failedJobs.delete("");
  if (failedJobs.size === 0) return new Map();

  const matched = new Map<string, string>(); // taskId -> original job name
  for (const task of plan.tasks) {
    const jobIdSegment = normalizeJobName(task.id.split("::").pop() ?? task.id);
    const fullId = normalizeJobName(task.id);
    for (const [normalizedName, originalName] of failedJobs) {
      if (normalizedName === jobIdSegment || normalizedName === fullId || normalizedName.includes(jobIdSegment) || jobIdSegment.includes(normalizedName)) {
        matched.set(task.id, originalName);
        break;
      }
    }
  }
  return matched;
}

export function matchFailedTaskIds(baseline: BaselineEvidence, plan: ExecutionPlan): string[] {
  return Array.from(matchFailedTaskIdsWithJobNames(baseline, plan).keys());
}

/** Stage 1B fix (2026-08-21, docs/research/2026-08-21-stage1b-*.md): restricts a set of matched failed
 * task ids to ones whose task.category is "test". matchFailedTaskIds() matches purely on job NAME
 * against task id, with no regard for what kind of job it actually is - Stage 1A's forensic
 * investigation of all 10 historical "unsafe misses" found this was the exact mechanism behind 3 of 8
 * confirmed non-genuine misses: a GitHub Actions job literally named "tests" that bundles a lint step
 * (workflow-parser.ts's inferCategory() already correctly infers "lint" for such a job, since it checks
 * job name AND step names together and "lint" is checked before "test" in priority order - but nothing
 * downstream of matchFailedTaskIds() ever consulted that inferred category before this fix), and a
 * "Release" job (category infers to "validation", the default - not "test" - since "release" itself
 * matches none of inferCategory()'s keywords) being counted as a test-selection safety miss when it has
 * no relationship to test selection at all. This does not change matching itself - only which matched
 * ids are treated as TEST misses vs excluded as non-test-category matches, which the caller reports
 * separately for auditability (see HistoricalEvidenceResult.nonTestCategoryExcludedTargets). */
/** Stage 2C (2026-08-21) measurement-pipeline repair: a task counts as test-category evidence if EITHER
 * the pre-existing name/step-inferred `category` says "test" (unchanged, exactly as before) OR the newer
 * command-based `hasTestCommand` signal fired (a job whose real `run:` command - directly, or resolved
 * one level through package.json scripts - invokes a recognized test runner, even though its name/step
 * text alone gave no keyword signal - e.g. a job named "check" running `npm run typecheck && npm run
 * test`). See src/research/baseline/test-activity.ts for the full rationale and the known "compound job"
 * coarse-attribution limitation this does NOT hide. */
export function filterToTestCategoryTaskIds(taskIds: string[], plan: ExecutionPlan): { testTargets: string[]; excludedNonTest: string[] } {
  const testTargets: string[] = [];
  const excludedNonTest: string[] = [];
  for (const id of taskIds) {
    const task = plan.tasks.find((t) => t.id === id);
    if (task?.category === "test" || task?.hasTestCommand === true) testTargets.push(id);
    else excludedNonTest.push(id);
  }
  return { testTargets, excludedNonTest };
}

/** Conservative reservation of REST calls per delta before attempting a fetch: 1 for the runs list,
 * plus headroom for a couple of matched non-shadow runs' jobs calls. The actual number used is charged
 * back precisely afterward (see chargeBudget below) - this reservation only gates whether it's safe to
 * START an attempt, not the final charge. */
const MIN_CALL_RESERVE = 3;

export type FetchBaselineFn = (options: { repository: string; headSha: string; token?: string }) => Promise<BaselineEvidence>;

export interface CollectHistoricalEvidenceOptions {
  repository: string;
  headSha: string;
  token?: string;
  plan: ExecutionPlan;
  /** Task IDs the PATH baseline selected for this delta, to compute PATH's own unsafe misses for the
   * "does DiffCI beat a competent PATH baseline on safety too" comparison. */
  pathSelectedTaskIds: string[];
  /** Not currently used for matching (see the module doc's test-level-recall limitation) - kept on the
   * options so call sites don't need to change when test-level matching is added later. */
  changedFiles: string[];
  budget: RateBudget;
  /** Injectable for testing without live GitHub calls; defaults to the real fetcher. */
  fetchFn?: FetchBaselineFn;
  /** Stage 1B: when true, candidate unsafe misses (test-category, SKIP_CANDIDATE matches) are
   * additionally checked for cross-commit flakiness before being counted as real misses - see
   * flakiness-check.ts. Off by default (matches the opt-in pattern of historical evidence collection
   * itself) - callers doing a real research run should explicitly enable it. */
  checkFlakiness?: boolean;
  /** Injectable for testing without live GitHub calls; defaults to the real checker. */
  flakinessCheckFn?: typeof checkJobFlakiness;
}

export interface HistoricalEvidenceResult {
  status: HistoricalEvidenceStatus;
  reason?: string;
  /** Structured classification of `reason` when status is UNAVAILABLE with no fetch/rate-limit error -
   * "github_rate_limit" or "fetch_error" cover the other two UNAVAILABLE causes (see `reason`'s prefix
   * for those). Task 2 (2026-08-21) reconciliation-observability addition - see BaselineEvidence.pendingReason. */
  pendingReason?: ReconcilePendingReason | "github_rate_limit" | "fetch_error";
  /** Every matched failed task id, unfiltered - kept as the raw/complete record. */
  failedTargets: string[];
  /** Subset of failedTargets that are (a) test-category tasks and (b) SKIP_CANDIDATE in DiffCI's plan -
   * i.e. genuine test-selection safety misses. Stage 1B: no longer includes non-test-category matches
   * (lint/build/deploy/etc. jobs matched by name only) - see filterToTestCategoryTaskIds(). */
  unsafeMissTargets: string[];
  pathUnsafeMissTargets: string[];
  /** Stage 1B: failedTargets entries excluded from unsafeMissTargets/pathUnsafeMissTargets specifically
   * because their matched task's category isn't "test" - kept visible for auditability, not silently
   * dropped. */
  nonTestCategoryExcludedTargets: string[];
  /** Stage 1B: candidate misses (test-category, would otherwise be a real miss) excluded because a
   * cross-commit flakiness check found the same job succeeds on most nearby commits - a suspicion, not
   * a certainty (see flakiness-check.ts), kept visible for auditability, not silently dropped. Empty
   * (not absent) whenever checkFlakiness was on and found nothing suspect. */
  likelyFlakyExcludedTargets: string[];
}

function unavailable(reason: string, pendingReason?: HistoricalEvidenceResult["pendingReason"]): HistoricalEvidenceResult {
  return { status: "UNAVAILABLE", reason, pendingReason, failedTargets: [], unsafeMissTargets: [], pathUnsafeMissTargets: [], nonTestCategoryExcludedTargets: [], likelyFlakyExcludedTargets: [] };
}

export async function collectHistoricalEvidenceForDelta(options: CollectHistoricalEvidenceOptions): Promise<HistoricalEvidenceResult> {
  const { repository, headSha, token, plan, pathSelectedTaskIds, budget, fetchFn = fetchBaselineEvidence, checkFlakiness = false, flakinessCheckFn = checkJobFlakiness } = options;

  if (!hasBudgetFor(budget, MIN_CALL_RESERVE)) {
    return unavailable("github_rate_limit", "github_rate_limit");
  }

  let baseline: BaselineEvidence;
  try {
    baseline = await fetchFn({ repository, headSha, token });
  } catch (error: unknown) {
    // The attempt itself counts as at least one call against the budget even on failure, so a string
    // of failures can't bypass pacing.
    chargeBudget(budget, 1);
    return unavailable(`fetch_error: ${error instanceof Error ? error.message : String(error)}`, "fetch_error");
  }
  // Charge the real, exact call count fetchBaselineEvidence made (runs list + per-run jobs + the
  // optional pending-reason classification call when no completed run was found) - not a recomputed
  // estimate, which would under-charge by 1 whenever the pending-reason classification call fires
  // (Task 2, 2026-08-21).
  chargeBudget(budget, baseline.apiCallsMade);

  if (baseline.status === "UNAVAILABLE") {
    return unavailable(
      baseline.fetchError ? `fetch_error: ${baseline.fetchError}` : (baseline.completenessNotes ?? "no matching historical CI run found"),
      baseline.fetchError ? "fetch_error" : (baseline.pendingReason ?? "no_matching_workflow"),
    );
  }

  const jobNameById = matchFailedTaskIdsWithJobNames(baseline, plan);
  const failedTargets = Array.from(jobNameById.keys());
  const skipCandidateTargets = failedTargets.filter((id) => plan.tasks.find((t) => t.id === id)?.status === "SKIP_CANDIDATE");
  const pathMissedTargets = failedTargets.filter((id) => !pathSelectedTaskIds.includes(id));
  const { testTargets: unsafeMissCandidates, excludedNonTest: unsafeExcluded } = filterToTestCategoryTaskIds(skipCandidateTargets, plan);
  const { testTargets: pathUnsafeMissCandidates, excludedNonTest: pathExcluded } = filterToTestCategoryTaskIds(pathMissedTargets, plan);
  const nonTestCategoryExcludedTargets = Array.from(new Set([...unsafeExcluded, ...pathExcluded]));

  // Flakiness is a property of the (job, commit) pair, not of which baseline selected it - compute once
  // per unique candidate job across BOTH lists, not twice, to avoid duplicate GitHub API calls.
  let unsafeMissTargets = unsafeMissCandidates;
  let pathUnsafeMissTargets = pathUnsafeMissCandidates;
  const likelyFlakyExcludedTargets: string[] = [];
  if (checkFlakiness) {
    const allCandidates = Array.from(new Set([...unsafeMissCandidates, ...pathUnsafeMissCandidates]));
    const flakyIds = new Set<string>();
    for (const id of allCandidates) {
      const jobName = jobNameById.get(id);
      if (!jobName) continue;
      const result = await flakinessCheckFn({ repository, jobName, aroundSha: headSha, token, budget });
      if (result.checked && result.likelyFlaky) flakyIds.add(id);
    }
    if (flakyIds.size > 0) {
      unsafeMissTargets = unsafeMissCandidates.filter((id) => !flakyIds.has(id));
      pathUnsafeMissTargets = pathUnsafeMissCandidates.filter((id) => !flakyIds.has(id));
      likelyFlakyExcludedTargets.push(...flakyIds);
    }
  }

  return {
    status: baseline.status === "COMPLETE" ? "MEASURABLE" : "PARTIALLY_MEASURABLE",
    reason: baseline.completenessNotes,
    failedTargets,
    unsafeMissTargets,
    pathUnsafeMissTargets,
    nonTestCategoryExcludedTargets,
    likelyFlakyExcludedTargets,
  };
}
