import type { BaselineEvidence, BaselineJobInfo, BaselineRunInfo, BaselineStepInfo } from "./types.js";
import { classifyExecutionOutcome, isRepositoryOutcome, selectEvidenceRun } from "./execution-outcome.js";

const SHADOW_WORKFLOW_PATH = ".github/workflows/diffci-shadow.yml";
const API_VERSION = "2026-03-10";

export interface FetchBaselineOptions {
  repository: string;
  headSha: string;
  token?: string;
  shadowWorkflowPath?: string;
  /**
   * 2026-09-05 workflow identity (measurement-integrity repair step 2). When set, ONLY runs of these
   * workflow files can be evidence: the latest such run is selected, its execution outcome classified
   * (execution-outcome.ts), and only an EXECUTED run yields COMPLETE/PARTIAL evidence. Every other
   * workflow's run for the SHA is kept in `otherRunsObserved` as audit, never as evidence. When unset,
   * the legacy "every completed non-shadow run" behaviour is unchanged - the production reconciler
   * (validation-worker.ts executeShadowReconcile) never calls this without identity; research replay
   * tooling still may.
   */
  evidenceWorkflowPaths?: string[];
}

function duration(a?: string, b?: string): number | undefined {
  if (!a || !b) return undefined;
  const ms = new Date(b).getTime() - new Date(a).getTime();
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

async function githubFetch(url: string, token?: string) {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": API_VERSION,
    // REQUIRED - GitHub's API firewall 403s any request missing this (same bug class already fixed in
    // github-app.ts and validation-worker.ts's fetchDefaultBranchHead/shadowAppInfo; this call site was
    // missed). Live-confirmed 2026-08-21: every reconciliation attempt against a real, deployed
    // Cloudflare Worker returned "Request forbidden by administrative rules. Please make sure your
    // request has a User-Agent header" - silently swallowed into an UNAVAILABLE/STILL_PENDING result by
    // collectHistoricalEvidenceForDelta, which is exactly why zero Stage 2 predictions had ever
    // reconciled despite real completed CI existing for every one of them. Node's fetch tolerates a
    // missing User-Agent against this same endpoint; Cloudflare Workers' fetch does not - this bites in
    // the deployed runtime specifically, not in local `npm test`.
    "User-Agent": "diffci-shadow",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GitHub API ${res.status} ${url}: ${text.slice(0, 200)}`);
  }
  return res.json() as Promise<unknown>;
}

function isCompleted(run: Record<string, unknown>): boolean {
  return typeof run.status === "string" && run.status === "completed";
}

/** One extra call, made ONLY when zero completed non-shadow runs were found - see the call site's
 * comment. Never throws: a classification failure degrades to "no_matching_workflow" (the existing,
 * pre-Task-2 behavior) rather than blocking reconciliation on a diagnostic-only lookup. */
async function classifyPendingReason(
  repository: string,
  headSha: string,
  token: string | undefined,
  shadowWorkflowPath: string,
): Promise<import("./types.js").ReconcilePendingReason> {
  try {
    // No status filter this time - deliberately wide, to see anything GitHub knows about for this SHA.
    const data = (await githubFetch(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=10`, token)) as Record<string, unknown>;
    const runs = Array.isArray(data.workflow_runs) ? (data.workflow_runs as Record<string, unknown>[]) : [];
    const relevant = runs.filter((r) => typeof r.path === "string" && r.path !== shadowWorkflowPath);
    if (relevant.some((r) => r.status === "in_progress")) return "ci_in_progress";
    if (relevant.some((r) => r.status === "queued" || r.status === "requested" || r.status === "waiting" || r.status === "pending")) return "ci_queued";
    return "no_matching_workflow";
  } catch {
    return "no_matching_workflow";
  }
}

function parseSteps(steps: unknown): BaselineStepInfo[] | undefined {
  if (!Array.isArray(steps)) return undefined;
  return steps.map((s) => {
    const name = typeof s.name === "string" ? s.name : "";
    const status = typeof s.status === "string" ? s.status : "unknown";
    const conclusion = typeof s.conclusion === "string" ? s.conclusion : undefined;
    const durationMs = duration(s.started_at, s.completed_at);
    return { name, status, conclusion, durationMs };
  });
}

function parseJob(job: Record<string, unknown>): BaselineJobInfo {
  const startedAt = typeof job.started_at === "string" ? job.started_at : undefined;
  const completedAt = typeof job.completed_at === "string" ? job.completed_at : undefined;
  return {
    jobId: typeof job.id === "number" ? job.id : 0,
    jobName: typeof job.name === "string" ? job.name : "",
    status: typeof job.status === "string" ? job.status : "unknown",
    conclusion: typeof job.conclusion === "string" ? job.conclusion : undefined,
    startedAt,
    completedAt,
    durationMs: duration(startedAt, completedAt),
    steps: parseSteps(job.steps),
    runnerName: typeof job.runner_name === "string" && job.runner_name.length > 0 ? job.runner_name : undefined,
  };
}

function parseRun(run: Record<string, unknown>): BaselineRunInfo {
  return {
    workflowPath: typeof run.path === "string" ? run.path : "",
    workflowRunId: typeof run.id === "number" ? run.id : 0,
    runNumber: typeof run.run_number === "number" ? run.run_number : 0,
    status: String(run.status ?? "unknown"),
    conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
    htmlUrl: typeof run.html_url === "string" ? run.html_url : "",
    runAttempt: typeof run.run_attempt === "number" ? run.run_attempt : undefined,
    event: typeof run.event === "string" ? run.event : undefined,
  };
}

/**
 * Identity mode (see FetchBaselineOptions.evidenceWorkflowPaths). `runs` is GitHub's unfiltered run list
 * for the SHA (every status). Exactly one further call (the evidence run's jobs) is made, and only when
 * the evidence run has completed.
 */
async function collectIdentityEvidence(
  base: BaselineEvidence,
  runs: Record<string, unknown>[],
  evidenceWorkflowPaths: string[],
  shadowWorkflowPath: string,
  token: string | undefined,
): Promise<BaselineEvidence> {
  base.evidenceWorkflowPaths = evidenceWorkflowPaths;
  const allRuns = runs.map(parseRun).filter((r) => r.workflowPath !== shadowWorkflowPath);
  const evidenceRun = selectEvidenceRun(allRuns, evidenceWorkflowPaths);
  base.otherRunsObserved = allRuns.filter((r) => r !== evidenceRun);

  if (!evidenceRun) {
    base.status = "UNAVAILABLE";
    base.pendingReason = allRuns.length === 0 ? "no_matching_workflow" : "evidence_workflow_run_missing";
    base.completenessNotes =
      allRuns.length === 0
        ? "no workflow run of any kind exists for this commit"
        : `no run of the evidence workflow (${evidenceWorkflowPaths.join(", ")}) exists for this commit; ${allRuns.length} other run(s) do`;
    return base;
  }

  base.evidenceRun = evidenceRun;
  if (evidenceRun.status !== "completed") {
    base.status = "UNAVAILABLE";
    base.pendingReason = evidenceRun.status === "in_progress" ? "ci_in_progress" : "ci_queued";
    base.completenessNotes = `the evidence workflow run ${evidenceRun.workflowRunId} is ${evidenceRun.status}`;
    return base;
  }

  const jobsUrl = `https://api.github.com/repos/${base.repository}/actions/runs/${evidenceRun.workflowRunId}/jobs`;
  let jobsFetchFailed: string | undefined;
  try {
    const jobsData = (await githubFetch(jobsUrl, token)) as Record<string, unknown>;
    base.apiCallsMade++;
    const jobs = Array.isArray(jobsData.jobs) ? (jobsData.jobs as Record<string, unknown>[]) : [];
    for (const job of jobs) base.jobs.push(parseJob(job));
  } catch (error: unknown) {
    base.apiCallsMade++;
    jobsFetchFailed = error instanceof Error ? error.message : String(error);
  }

  base.executionOutcome = classifyExecutionOutcome(evidenceRun, base.jobs);
  base.fullRunsObserved = [evidenceRun];

  if (!isRepositoryOutcome(base.executionOutcome)) {
    // Execution infrastructure outcome, not a repository outcome: terminal for the reconciler
    // (shadow-reconcile-terminal.ts), never ground truth. Jobs stay attached as the audit trail.
    base.status = "UNAVAILABLE";
    base.pendingReason = "evidence_run_not_executed";
    base.completenessNotes = `evidence workflow run ${evidenceRun.workflowRunId} concluded '${evidenceRun.conclusion}' - ${base.executionOutcome}`;
    return base;
  }

  for (const job of base.jobs) {
    if (job.conclusion === "failure" || job.status === "failed") base.failedJobNames.push(job.jobName);
  }
  if (jobsFetchFailed) {
    base.status = "PARTIAL";
    base.completenessNotes = `failed to fetch jobs for run ${evidenceRun.workflowRunId}: ${jobsFetchFailed}`;
    return base;
  }
  base.status = "COMPLETE";
  const durations = base.jobs.map((j) => j.durationMs).filter((v): v is number => typeof v === "number" && v > 0);
  base.baselineDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) : undefined;
  return base;
}

export async function fetchBaselineEvidence(options: FetchBaselineOptions): Promise<BaselineEvidence> {
  const { repository, headSha, token, shadowWorkflowPath = SHADOW_WORKFLOW_PATH, evidenceWorkflowPaths } = options;
  const base: BaselineEvidence = {
    repository,
    headSha,
    status: "UNAVAILABLE",
    fullRunsObserved: [],
    jobs: [],
    failedJobNames: [],
    failedTaskIds: [],
    apiCallsMade: 0,
  };

  // Identity mode needs every status (queued/in-progress evidence runs are classified from this one
  // list, no separate pending-reason call); the legacy path keeps its completed-only filter.
  const url = evidenceWorkflowPaths
    ? `https://api.github.com/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=30`
    : `https://api.github.com/repos/${repository}/actions/runs?head_sha=${headSha}&status=completed&per_page=30`;
  let runsList: unknown;
  try {
    runsList = await githubFetch(url, token);
    base.apiCallsMade++;
  } catch (error: unknown) {
    base.apiCallsMade++; // the attempt itself counts - see evidence-collector.ts's rate-pacing comment
    base.fetchError = error instanceof Error ? error.message : String(error);
    return base;
  }

  const runs = Array.isArray((runsList as Record<string, unknown>).workflow_runs)
    ? ((runsList as Record<string, unknown>).workflow_runs as Record<string, unknown>[])
    : [];

  if (evidenceWorkflowPaths && evidenceWorkflowPaths.length > 0) {
    return collectIdentityEvidence(base, runs, evidenceWorkflowPaths, shadowWorkflowPath, token);
  }

  const skippedPath = shadowWorkflowPath;
  const runInfos: BaselineRunInfo[] = [];
  const notes: string[] = [];

  for (const run of runs) {
    if (!isCompleted(run)) continue;
    const path = typeof run.path === "string" ? run.path : "";
    if (path === skippedPath) continue;
    const runInfo = parseRun(run);
    const runId = runInfo.workflowRunId;
    runInfos.push(runInfo);

    const jobsUrl = typeof run.jobs_url === "string" ? run.jobs_url : `https://api.github.com/repos/${repository}/actions/runs/${runId}/jobs`;
    let jobsData: unknown;
    try {
      jobsData = await githubFetch(jobsUrl, token);
      base.apiCallsMade++;
    } catch (error: unknown) {
      base.apiCallsMade++; // the attempt itself counts
      notes.push(`failed to fetch jobs for run ${runId}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    const jobs = Array.isArray((jobsData as Record<string, unknown>).jobs)
      ? ((jobsData as Record<string, unknown>).jobs as Record<string, unknown>[])
      : [];
    for (const job of jobs) {
      const parsed = parseJob(job);
      base.jobs.push(parsed);
      if (parsed.conclusion === "failure" || parsed.status === "failed") {
        base.failedJobNames.push(parsed.jobName);
      }
    }
  }

  base.fullRunsObserved = runInfos;

  if (runInfos.length === 0) {
    base.status = "UNAVAILABLE";
    // One extra, cheap call ONLY in this branch (never on the happy path) to distinguish "CI hasn't even
    // started" from "CI is running right now" from "no workflow will ever run for this SHA" - the
    // reconciliation-observability ask (Task 2 §6/§10): these are all "retryable, try again later" today
    // (same STILL_PENDING outcome, same safety methodology, unchanged), but an operator staring at a
    // pending-predictions dashboard needs to tell them apart. Never affects unsafeMissTargets/recall math.
    base.pendingReason = await classifyPendingReason(repository, headSha, token, skippedPath);
    base.apiCallsMade++;
    base.completenessNotes =
      base.pendingReason === "ci_in_progress"
        ? "a non-shadow CI run for this commit is currently in progress"
        : base.pendingReason === "ci_queued"
          ? "a non-shadow CI run for this commit is queued but has not started"
          : "no completed non-shadow CI runs found for this commit";
    return base;
  }

  base.status = notes.length ? "PARTIAL" : "COMPLETE";
  if (notes.length) {
    base.completenessNotes = notes.join("; ");
  }

  if (base.status === "COMPLETE") {
    const durations = base.jobs.map((j) => j.durationMs).filter((v): v is number => typeof v === "number" && v > 0);
    base.baselineDurationMs = durations.length ? durations.reduce((a, b) => a + b, 0) : undefined;
  }

  return base;
}
