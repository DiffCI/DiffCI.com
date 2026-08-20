/**
 * Pure dispatch-decision logic for the full Stage 0 multi-repository orchestrator (2026-08-21).
 * Deliberately dependency-free from @cloudflare/sandbox (same reason as retry.ts/resumable-batch.ts)
 * so "which repositories should THIS invocation dispatch" is unit-testable without touching Cloudflare.
 *
 * The orchestrator itself is stateless between invocations by design - every call re-derives this
 * decision fresh from whatever repository_runs/experiment_runs state is in D1, never from in-memory
 * state carried from a prior call. That's what makes "a new orchestrator invocation must be able to
 * reconstruct experiment state from persistent storage" true without any special recovery code path -
 * a resumed invocation and a fresh one look identical to this function.
 */

export type RepositoryStatus = "PENDING" | "RUNNING" | "COMPLETE" | "EXCLUDED" | "FAILED" | "BUDGET_STOPPED";

export interface CorpusEntry {
  owner: string;
  name: string;
  language: string;
  targetCommits: number;
}

export interface RepositoryState {
  owner: string;
  name: string;
  status: RepositoryStatus;
  orchestratorAttempts: number;
}

export type BudgetStatus = "OK" | "WARNING" | "RESERVE" | "BUDGET_STOPPED";

export interface DispatchPlan {
  toDispatch: CorpusEntry[];
  reason: string;
  /** Repositories that have exhausted their top-level attempt budget - the orchestrator should mark
   * these FAILED and never schedule them again, rather than retrying forever across invocations. */
  giveUpOn: CorpusEntry[];
}

const DONE_STATUSES: RepositoryStatus[] = ["COMPLETE", "EXCLUDED"];

function key(entry: { owner: string; name: string }): string {
  return `${entry.owner}/${entry.name}`;
}

/**
 * @param corpus The full target repository list (order defines priority for ties).
 * @param repoStates Current known state per repository, keyed by "owner/name". A repository with no
 *   entry here has never been dispatched (equivalent to PENDING with 0 attempts).
 * @param budgetStatus Current experiment-wide budget tier (see cost-model.ts's evaluateBudgetStatus).
 * @param stopRequested Explicit external stop flag (experiment_runs.stop_requested) - checked before
 *   budget, since a human-requested stop should win even if there's budget remaining.
 * @param concurrency Max repositories to dispatch in this single invocation.
 * @param maxAttemptsPerRepo Top-level (cross-invocation) attempts before giving up on a repository -
 *   distinct from withContainerRetry's in-process 3-attempt transient retry within ONE dispatch.
 */
export function planOrchestratorDispatch(
  corpus: CorpusEntry[],
  repoStates: Map<string, RepositoryState>,
  budgetStatus: BudgetStatus,
  stopRequested: boolean,
  concurrency: number,
  maxAttemptsPerRepo = 3,
): DispatchPlan {
  if (stopRequested) {
    return { toDispatch: [], reason: "stop_requested is set - no new repository work will be scheduled", giveUpOn: [] };
  }
  if (budgetStatus === "BUDGET_STOPPED") {
    return { toDispatch: [], reason: "budget hard-stop threshold reached - no new repository work will be scheduled", giveUpOn: [] };
  }

  const giveUpOn: CorpusEntry[] = [];
  const notDone: { entry: CorpusEntry; state: RepositoryState }[] = [];

  for (const entry of corpus) {
    const state = repoStates.get(key(entry)) ?? { owner: entry.owner, name: entry.name, status: "PENDING", orchestratorAttempts: 0 };
    if (DONE_STATUSES.includes(state.status)) continue;
    if (state.status === "FAILED") continue; // already given up in a prior invocation
    if (state.orchestratorAttempts >= maxAttemptsPerRepo) {
      giveUpOn.push(entry);
      continue;
    }
    notDone.push({ entry, state });
  }

  if (notDone.length === 0) {
    return { toDispatch: [], reason: giveUpOn.length > 0 ? "remaining repositories exhausted their attempt budget" : "all repositories complete or excluded", giveUpOn };
  }

  // RESERVE mode: per "do not begin low-priority/new repository work unless projected cost safely
  // fits" - prioritize continuing repositories that already have SOME progress (RUNNING, i.e. a prior
  // invocation started them) over starting brand-new PENDING ones, and cap how much new work begins.
  const sorted =
    budgetStatus === "RESERVE"
      ? [...notDone].sort((a, b) => (a.state.status === "RUNNING" ? -1 : 0) - (b.state.status === "RUNNING" ? -1 : 0))
      : notDone;

  const effectiveConcurrency = budgetStatus === "RESERVE" ? Math.min(concurrency, 1) : concurrency;
  const toDispatch = sorted.slice(0, effectiveConcurrency).map((x) => x.entry);

  return {
    toDispatch,
    reason:
      budgetStatus === "RESERVE"
        ? "RESERVE mode - continuing at most 1 repository at a time, prioritizing already-started work"
        : `dispatching up to ${concurrency} repositories concurrently`,
    giveUpOn,
  };
}

export interface ExperimentProgress {
  totalRepositories: number;
  complete: number;
  excluded: number;
  failed: number;
  running: number;
  pending: number;
  /** True once no repository will EVER be dispatched again (every one has reached a terminal state:
   * COMPLETE, EXCLUDED, or FAILED). This is "the orchestrator can stop being re-invoked", NOT "the
   * experiment succeeded" - a FAILED repository counts as terminal here but is a real failure, tracked
   * separately by hasFailures so the two questions ("should I stop polling?" vs "did everything work?")
   * are never conflated into one boolean. */
  isComplete: boolean;
  /** True if any repository was given up on (FAILED) - a caller must check this before treating
   * isComplete as "the experiment succeeded". */
  hasFailures: boolean;
}

export function computeExperimentProgress(corpus: CorpusEntry[], repoStates: Map<string, RepositoryState>): ExperimentProgress {
  let complete = 0;
  let excluded = 0;
  let failed = 0;
  let running = 0;
  let pending = 0;

  for (const entry of corpus) {
    const state = repoStates.get(key(entry));
    const status = state?.status ?? "PENDING";
    if (status === "COMPLETE") complete++;
    else if (status === "EXCLUDED") excluded++;
    else if (status === "FAILED") failed++;
    else if (status === "RUNNING") running++;
    else pending++;
  }

  return {
    totalRepositories: corpus.length,
    complete,
    excluded,
    failed,
    running,
    pending,
    isComplete: complete + excluded + failed === corpus.length,
    hasFailures: failed > 0,
  };
}
