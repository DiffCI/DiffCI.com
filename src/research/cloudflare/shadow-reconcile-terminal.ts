/**
 * Terminalisation of pending shadow predictions whose ground truth provably cannot exist
 * (2026-09-05, docs/research/2026-09-05-shadow-telemetry-measurement-integrity.md F1).
 *
 * The only terminal reason today is NO_MATCHING_WORKFLOW: the head commit never had a workflow run.
 * This happens to every intermediate commit of a multi-commit push (GitHub runs CI for the push head
 * only), so it is a normal, permanent condition - and left as "pending" it re-occupied the reconciler's
 * 10-row window every sweep until nothing newer was ever attempted.
 *
 * Rules, all of which must hold - deliberately NOT age alone (Task 2 §11: age must never convert a
 * normal delay into a failure):
 *   1. This attempt classified the prediction `no_matching_workflow`.
 *   2. A PREVIOUS attempt also classified it `no_matching_workflow` - two independent observations,
 *      because classifyPendingReason degrades a transient GitHub error to the same label. No minimum
 *      spacing: a repository with fewer pending rows than the window is re-attempted every cron tick,
 *      so any spacing rule would silently never fire there; rule 5's strict direct confirmation is
 *      what actually rules out a transient error.
 *   3. The prediction is at least MIN_PREDICTION_AGE_MS old - a push-triggered run is created within
 *      seconds of the push; a commit still without one hours later will not get one.
 *   4. The repository's observed head has moved past this commit - a prediction for the CURRENT head
 *      with no run at all is a different situation (Actions disabled, billing, an outage) and stays
 *      pending where a human can see it.
 *   5. A fresh, direct `/actions/runs?head_sha=<sha>` query answered HTTP 200 with zero runs (of any
 *      status, any workflow) - positive evidence from GitHub, not the absence of a classification.
 *
 * The decision itself is a pure function of those facts (decideNoMatchingWorkflowTerminal) so it is
 * unit-testable with fixed clocks; the GitHub confirmation is a separate injectable step.
 */

export type ReconcileTerminalReason =
  | "NO_MATCHING_WORKFLOW"
  // Step 2 (workflow identity): the identified evidence workflow's run completed WITHOUT executing the
  // repository's code - an execution infrastructure outcome, never a repository outcome. One reason per
  // ExecutionOutcome class so reconcile-diagnostics keeps them apart (research note F2: "cancelled,
  // skipped, queued/never-executed, infrastructure failure and actual execution must not collapse into
  // the same population").
  | "EVIDENCE_RUN_NOT_EXECUTED_INFRASTRUCTURE"
  | "EVIDENCE_RUN_CANCELLED_DURING_EXECUTION"
  | "EVIDENCE_RUN_SKIPPED"
  | "EVIDENCE_RUN_TIMED_OUT"
  | "EVIDENCE_RUN_NOT_EXECUTED_OTHER";

/**
 * Step 2: a completed evidence-workflow run whose execution outcome is not EXECUTED is terminal on
 * that single, positive observation - GitHub reported the run itself, its conclusion and its jobs.
 * A later re-run of the same run id would change GitHub's answer; that is a founder action, and the
 * terminal marker is reversible by a data change (NULL the reconcile_terminal_* columns).
 */
export function decideEvidenceRunTerminal(result: {
  pendingReason?: string;
  executionOutcome?: string;
  evidenceRun?: { workflowPath: string; workflowRunId: number; runAttempt?: number; conclusion: string | null; htmlUrl: string; event?: string };
  baseline?: { jobs: readonly { jobName: string; conclusion?: string; runnerName?: string; steps?: readonly unknown[] }[] };
  groundTruthFetchedAt: string;
}): TerminalDecision {
  if (result.pendingReason !== "evidence_run_not_executed") return { terminal: false, blockedBy: "reason" };
  const outcome = result.executionOutcome;
  const run = result.evidenceRun;
  if (!run || !outcome || outcome === "EXECUTED") return { terminal: false, blockedBy: "confirmation" };
  const reason = `EVIDENCE_RUN_${outcome}` as ReconcileTerminalReason;
  if (!EVIDENCE_RUN_TERMINAL_REASONS.has(reason)) return { terminal: false, blockedBy: "confirmation" };
  return {
    terminal: true,
    reason,
    detail: {
      rule: "identified evidence workflow run completed without executing the repository's code (execution infrastructure outcome, not a repository outcome)",
      decidedAt: result.groundTruthFetchedAt,
      workflowPath: run.workflowPath,
      workflowRunId: run.workflowRunId,
      runAttempt: run.runAttempt ?? null,
      conclusion: run.conclusion,
      event: run.event ?? null,
      htmlUrl: run.htmlUrl,
      executionOutcome: outcome,
      jobs: (result.baseline?.jobs ?? []).map((j) => ({ name: j.jobName, conclusion: j.conclusion ?? null, runnerName: j.runnerName ?? null, steps: j.steps?.length ?? 0 })),
    },
  };
}

const EVIDENCE_RUN_TERMINAL_REASONS = new Set<string>([
  "EVIDENCE_RUN_NOT_EXECUTED_INFRASTRUCTURE",
  "EVIDENCE_RUN_CANCELLED_DURING_EXECUTION",
  "EVIDENCE_RUN_SKIPPED",
  "EVIDENCE_RUN_TIMED_OUT",
  "EVIDENCE_RUN_NOT_EXECUTED_OTHER",
]);

/** The prediction must be at least this old before it can be terminalised. */
export const MIN_PREDICTION_AGE_MS = 6 * 60 * 60 * 1000; // 6h

export interface TerminalCandidateFacts {
  /** This attempt's pendingReason. */
  pendingReason: string | undefined;
  predictionCreatedAt: string;
  headSha: string;
  /** From the row BEFORE this attempt's recordReconcileAttempt overwrote it. */
  previousReason: string | undefined;
  previousAttemptAt: string | undefined;
  /** The repository's most recently polled/observed head SHA, if known. */
  repositoryHeadSha: string | undefined;
  nowIso: string;
}

export interface TerminalPrecheck {
  /** True when rules 1-4 hold and the GitHub confirmation (rule 5) is worth making. */
  candidate: boolean;
  /** Which rule stopped it, for logs/tests. */
  blockedBy?: "reason" | "no_prior_observation" | "prediction_age" | "current_head";
}

export function precheckNoMatchingWorkflowTerminal(facts: TerminalCandidateFacts): TerminalPrecheck {
  if (facts.pendingReason !== "no_matching_workflow") return { candidate: false, blockedBy: "reason" };
  if (facts.previousReason !== "no_matching_workflow" || !facts.previousAttemptAt || !Number.isFinite(Date.parse(facts.previousAttemptAt))) {
    return { candidate: false, blockedBy: "no_prior_observation" };
  }
  const nowMs = Date.parse(facts.nowIso);
  const createdMs = Date.parse(facts.predictionCreatedAt);
  if (!Number.isFinite(nowMs) || !Number.isFinite(createdMs) || nowMs - createdMs < MIN_PREDICTION_AGE_MS) {
    return { candidate: false, blockedBy: "prediction_age" };
  }
  if (!facts.repositoryHeadSha || facts.repositoryHeadSha === facts.headSha) {
    return { candidate: false, blockedBy: "current_head" };
  }
  return { candidate: true };
}

export interface WorkflowRunConfirmation {
  /** True only on HTTP 200 with a well-formed body reporting zero workflow runs for the SHA. */
  confirmedNoRuns: boolean;
  totalCount?: number;
  httpStatus?: number;
  error?: string;
}

export interface TerminalDecision {
  terminal: boolean;
  reason?: ReconcileTerminalReason;
  /** Audit payload persisted to reconcile_terminal_detail. */
  detail?: Record<string, unknown>;
  blockedBy?: TerminalPrecheck["blockedBy"] | "confirmation";
}

/** Pure: combines the precheck with the GitHub confirmation. */
export function decideNoMatchingWorkflowTerminal(facts: TerminalCandidateFacts, confirmation: WorkflowRunConfirmation | undefined): TerminalDecision {
  const pre = precheckNoMatchingWorkflowTerminal(facts);
  if (!pre.candidate) return { terminal: false, blockedBy: pre.blockedBy };
  if (!confirmation || !confirmation.confirmedNoRuns) return { terminal: false, blockedBy: "confirmation" };
  return {
    terminal: true,
    reason: "NO_MATCHING_WORKFLOW",
    detail: {
      rule: "no_matching_workflow on two attempts, prediction >= 6h old, superseded by a newer head, direct runs query returned 0",
      previousAttemptAt: facts.previousAttemptAt,
      decidedAt: facts.nowIso,
      predictionCreatedAt: facts.predictionCreatedAt,
      predictionAgeMs: Date.parse(facts.nowIso) - Date.parse(facts.predictionCreatedAt),
      supersededByHeadSha: facts.repositoryHeadSha,
      workflowRunsForHeadSha: confirmation.totalCount ?? 0,
    },
  };
}

/**
 * Rule 5: asks GitHub directly. Never throws - any failure is "not confirmed", which leaves the row
 * pending (the safe direction). Same headers as github-baseline.ts's githubFetch, including the
 * User-Agent that GitHub's API firewall requires from Cloudflare Workers.
 */
export async function confirmNoWorkflowRuns(
  repository: string,
  headSha: string,
  token: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<WorkflowRunConfirmation> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2026-03-10",
    "User-Agent": "diffci-shadow",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs?head_sha=${headSha}&per_page=1`, { headers });
    if (res.status !== 200) return { confirmedNoRuns: false, httpStatus: res.status, error: `GitHub API ${res.status}` };
    const body = (await res.json()) as { total_count?: unknown; workflow_runs?: unknown };
    const totalCount = typeof body.total_count === "number" ? body.total_count : undefined;
    const runs = Array.isArray(body.workflow_runs) ? body.workflow_runs : undefined;
    if (totalCount === undefined || runs === undefined) return { confirmedNoRuns: false, httpStatus: 200, error: "malformed runs response" };
    return { confirmedNoRuns: totalCount === 0 && runs.length === 0, totalCount, httpStatus: 200 };
  } catch (error: unknown) {
    return { confirmedNoRuns: false, error: error instanceof Error ? error.message : String(error) };
  }
}
