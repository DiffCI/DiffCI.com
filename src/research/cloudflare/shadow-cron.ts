/**
 * Stage 2 autonomous polling (2026-08-21) - the Cron Trigger decision logic that removes the "a human
 * session must drive every poll" dependency the Stage 2 final report flagged. The shadow_repositories
 * schema comment always anticipated this ("REST polling from a Cron Trigger"); until now every
 * /v1/shadow/poll call needed a caller uploading the diffci source tarball per-request, so observation
 * volume only accumulated while someone was babysitting the pipeline. Now the source lives in R2
 * (uploaded once via POST /v1/shadow/source, see validation-worker.ts) and the Worker's scheduled()
 * handler drives poll + reconcile on its own.
 *
 * This module is the DECISION layer only, dependency-injected and unit-testable in plain Node against
 * fakes (tests/research/cloudflare/shadow-cron.test.ts) - the same split resumable-batch.ts and
 * orchestrator-plan.ts use. validation-worker.ts wires the real D1/R2/Sandbox implementations.
 *
 * Cost/latency design: a container poll costs ~2-6 minutes of wall clock (npm ci + clone + analysis)
 * even when nothing new landed, so before spending a container the runner asks the GitHub REST API for
 * the repository's current default-branch head (one cheap request) and skips repositories whose head
 * still equals last_polled_sha. An API failure polls anyway (conservative: observation must not stop
 * because a pre-check flaked) - except 404/451, which mean the repository itself is gone/blocked.
 * A repository's FIRST poll always runs the container: there is no last_polled_sha to compare against,
 * and the poll script itself records the baseline without backfilling history (see
 * cloudflare-shadow-poll.ts's prospectiveness comment).
 */

export interface PollableRepository {
  repository: string; // "owner/name"
  state: string;
  language: string;
  lastPolledSha?: string;
  lastPolledAt?: string;
}

export interface ShadowCronRunRecord {
  startedAt: string;
  finishedAt: string;
  trigger: "cron" | "manual";
  reposConsidered: number;
  headChecksSkipped: number; // repositories skipped because remote head == last_polled_sha
  reposPolled: string[];
  predictionsRecorded: number;
  reposReconciled: number;
  groundTruthReconciled: number;
  stillPending: number;
  errors: string[];
}

export interface ShadowCronDeps {
  /** Enrolled cloudflare-poll repositories in a pollable state, oldest-polled first (store-side order
   * is advisory; selection re-sorts defensively). */
  listPollableRepositories(): Promise<PollableRepository[]>;
  /** Repositories eligible for the reconcile sweep - a SUPERSET of the pollable list: webhook-enrolled
   * ('github-app-webhook') repositories reconcile event-driven when workflow_run deliveries arrive, but
   * this cron sweep is their safety net against missed deliveries. */
  listReconcilableRepositories(): Promise<PollableRepository[]>;
  /** Current default-branch head SHA via the GitHub REST API, or undefined when it cannot be
   * determined (rate limit, network) - undefined means "poll anyway". A "gone" result means the
   * repository no longer exists / is blocked and must not consume a container. */
  fetchRemoteHead(repository: string): Promise<{ sha: string } | { gone: string } | undefined>;
  /** The diffci source tarball from R2, or undefined if none has been uploaded yet. */
  getSourceArchive(): Promise<File | undefined>;
  pollRepository(repo: PollableRepository, source: File): Promise<{ predictionsRecorded: number; errors: string[] }>;
  reconcileRepository(repository: string): Promise<{ reconciled: number; stillPending: number; errors: string[] }>;
  recordCronRun(run: ShadowCronRunRecord): Promise<void>;
  now(): Date;
  log(message: string): void;
}

export interface ShadowCronConfig {
  /** Containers dispatched per invocation. Must stay comfortably inside the scheduled handler's
   * wall-clock allowance (polls run concurrently, worst-case one poll ~6min) AND below the sandbox
   * max_instances gap - see wrangler.research-sandbox.jsonc's max_instances comment. */
  maxPollsPerRun: number;
  /** Reconciles per invocation - cheap (GitHub API + D1/R2 only, no container), so this cap is about
   * bounding API usage, not time. */
  maxReconcilesPerRun: number;
  /** Pending-prediction rows attempted per reconciled repository (the existing /v1/shadow/reconcile
   * limit semantics). */
  reconcileLimitPerRepo: number;
}

export const DEFAULT_SHADOW_CRON_CONFIG: ShadowCronConfig = {
  maxPollsPerRun: 3,
  maxReconcilesPerRun: 10,
  reconcileLimitPerRepo: 10,
};

const POLLABLE_STATES = new Set(["VALIDATING", "SHADOW_ACTIVE", "SHADOW_LIMITED"]);

/** Oldest-polled first (never-polled repositories at the very front), states filtered defensively even
 * though the store query already filters - a store regression must not make the cron poll a PAUSED or
 * REMOVED repository. */
export function selectRepositoriesToPoll(repos: PollableRepository[]): PollableRepository[] {
  return repos
    .filter((r) => POLLABLE_STATES.has(r.state))
    .sort((a, b) => {
      if (!a.lastPolledAt && !b.lastPolledAt) return a.repository.localeCompare(b.repository);
      if (!a.lastPolledAt) return -1;
      if (!b.lastPolledAt) return 1;
      return a.lastPolledAt.localeCompare(b.lastPolledAt) || a.repository.localeCompare(b.repository);
    });
}

export async function runShadowCronOnce(
  deps: ShadowCronDeps,
  config: ShadowCronConfig = DEFAULT_SHADOW_CRON_CONFIG,
  trigger: "cron" | "manual" = "cron",
): Promise<ShadowCronRunRecord> {
  const startedAt = deps.now().toISOString();
  const errors: string[] = [];
  const reposPolled: string[] = [];
  let predictionsRecorded = 0;
  let headChecksSkipped = 0;
  let reposReconciled = 0;
  let groundTruthReconciled = 0;
  let stillPending = 0;

  let candidates: PollableRepository[] = [];
  try {
    candidates = selectRepositoriesToPoll(await deps.listPollableRepositories());
  } catch (error: unknown) {
    errors.push(`list-repositories: ${error instanceof Error ? error.message : String(error)}`);
  }

  // Head pre-check walks the full ordered candidate list until maxPollsPerRun repositories actually
  // NEED a container - a repository skipped for an unchanged head must not consume a poll slot.
  const toPoll: PollableRepository[] = [];
  for (const repo of candidates) {
    if (toPoll.length >= config.maxPollsPerRun) break;
    if (repo.lastPolledSha) {
      try {
        const head = await deps.fetchRemoteHead(repo.repository);
        if (head && "gone" in head) {
          errors.push(`${repo.repository}: remote head check says repository is gone (${head.gone}) - skipped, consider PAUSED`);
          continue;
        }
        if (head && head.sha === repo.lastPolledSha) {
          headChecksSkipped++;
          continue;
        }
      } catch (error: unknown) {
        // Pre-check failure is never a reason to stop observing - fall through and poll.
        deps.log(`shadow-cron: head pre-check failed for ${repo.repository}, polling anyway: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    toPoll.push(repo);
  }

  if (toPoll.length > 0) {
    let source: File | undefined;
    try {
      source = await deps.getSourceArchive();
    } catch (error: unknown) {
      errors.push(`get-source-archive: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!source) {
      // Loud, recorded, and non-fatal for reconciliation below - reconcile needs no source archive.
      errors.push(`source-archive-missing: ${toPoll.length} repository(ies) due for polling but no source tarball is uploaded (POST /v1/shadow/source)`);
    } else {
      const results = await Promise.all(
        toPoll.map(async (repo) => {
          try {
            const result = await deps.pollRepository(repo, source);
            return { repo, result };
          } catch (error: unknown) {
            return { repo, error: error instanceof Error ? error.message : String(error) };
          }
        }),
      );
      for (const r of results) {
        if ("error" in r) {
          errors.push(`poll ${r.repo.repository}: ${r.error}`);
          continue;
        }
        reposPolled.push(r.repo.repository);
        predictionsRecorded += r.result.predictionsRecorded;
        errors.push(...r.result.errors.map((e) => `poll ${r.repo.repository}: ${e}`));
      }
    }
  }

  // Reconcile every reconcilable repository (not only the ones polled this run) - ground truth for an
  // earlier prediction can complete while the head hasn't moved since, and webhook-enrolled
  // repositories need this sweep as their missed-delivery safety net.
  let reconcilable: PollableRepository[] = [];
  try {
    reconcilable = await deps.listReconcilableRepositories();
  } catch (error: unknown) {
    errors.push(`list-reconcilable: ${error instanceof Error ? error.message : String(error)}`);
  }
  const toReconcile = reconcilable.slice(0, config.maxReconcilesPerRun);
  const reconcileResults = await Promise.all(
    toReconcile.map(async (repo) => {
      try {
        return { repo, result: await deps.reconcileRepository(repo.repository) };
      } catch (error: unknown) {
        return { repo, error: error instanceof Error ? error.message : String(error) };
      }
    }),
  );
  for (const r of reconcileResults) {
    if ("error" in r) {
      errors.push(`reconcile ${r.repo.repository}: ${r.error}`);
      continue;
    }
    reposReconciled++;
    groundTruthReconciled += r.result.reconciled;
    stillPending += r.result.stillPending;
    errors.push(...r.result.errors.map((e) => `reconcile ${r.repo.repository}: ${e}`));
  }

  const record: ShadowCronRunRecord = {
    startedAt,
    finishedAt: deps.now().toISOString(),
    trigger,
    reposConsidered: candidates.length,
    headChecksSkipped,
    reposPolled,
    predictionsRecorded,
    reposReconciled,
    groundTruthReconciled,
    stillPending,
    errors,
  };

  try {
    await deps.recordCronRun(record);
  } catch (error: unknown) {
    // The run itself succeeded - a telemetry write failure must not fail the invocation, but it must
    // be visible in logs (observability is enabled on this Worker).
    deps.log(`shadow-cron: failed to record cron run telemetry: ${error instanceof Error ? error.message : String(error)}`);
  }

  deps.log(
    `shadow-cron (${trigger}): considered=${record.reposConsidered} skipped-unchanged=${headChecksSkipped} polled=[${reposPolled.join(",")}] predictions=${predictionsRecorded} reconciled=${groundTruthReconciled} pending=${stillPending} errors=${errors.length}`,
  );
  return record;
}
