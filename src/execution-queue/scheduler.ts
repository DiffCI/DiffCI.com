/**
 * A deterministic, simple scheduler (Part 17: "Do not implement an elaborate global scheduler yet. A
 * deterministic simple scheduler is enough."). Walks queued items in (priority, createdAt) order and
 * assigns each to a freshly-provisioned runner, skipping (leaving queued, untouched) any organization
 * that is already at its entitlement's maxConcurrency - tracked cumulatively across this single
 * scheduling pass, not just from a stale pre-pass DB count, so two queued items for the same
 * already-near-limit organization in the same batch cannot both slip through.
 */
import type { RunnerProvider } from "../runner/provider.js";
import type { RunnerStore } from "../runner/store.js";
import type { ExecutionQueueStore } from "./store.js";
import type { QueueItem } from "./types.js";

export interface SchedulerDeps {
  /** HTTP-triggered scheduling must stay within the authenticated organization. */
  organizationId?: string;
  queueStore: ExecutionQueueStore;
  runnerStore: RunnerStore;
  runnerProvider: RunnerProvider;
  /** Returns the organization's current max-concurrency entitlement (-1 = unlimited). */
  getMaxConcurrency: (organizationId: string) => Promise<number>;
  /** Repository workloads fail closed unless the caller proves that this exact tenant/repository job
   * is authorized for managed execution. Organization-only synthetic health jobs are unaffected. */
  authorizeRepositoryExecution?: (item: QueueItem) => Promise<boolean>;
  /** R1 (Real Runner) addition - optional. When a provider needs a real, per-runner, per-job
   * authentication credential (src/runner/agent-api.ts's register/claim/result boundary) rather than
   * running synchronously inside one control-plane-initiated call, this hook mints one AFTER the
   * Runner row exists (so runnerId is known) and BEFORE provisionRunner() is called, and its result is
   * merged into the RunnerRequest as `runnerCredential`/`jobCommand`. Providers that don't need this
   * (mock, the original synchronous Cloudflare Containers provider) are unaffected - the scheduler
   * itself stays provider-agnostic; only a caller that KNOWS it's using a credential-based provider
   * supplies this hook. */
  mintRunnerCredential?: (input: { runnerId: string; jobId: string; organizationId: string }) => Promise<{ token: string; apiBaseUrl: string; jobCommand: string }>;
}

export interface ScheduleOutcome {
  queueItemId: string;
  organizationId: string;
  outcome: "assigned" | "skipped_concurrency_limit" | "skipped_not_authorized" | "provisioning_failed";
  runnerId?: string;
  error?: string;
}

export async function scheduleNext(deps: SchedulerDeps, batchLimit = 50): Promise<ScheduleOutcome[]> {
  const queued = await deps.queueStore.listQueuedItems(batchLimit, deps.organizationId);
  const outcomes: ScheduleOutcome[] = [];

  for (const item of queued) {
    if (item.repositoryId && (!deps.authorizeRepositoryExecution || !await deps.authorizeRepositoryExecution(item))) {
      outcomes.push({ queueItemId: item.id, organizationId: item.organizationId, outcome: "skipped_not_authorized" });
      continue;
    }
    const maxConcurrency = await deps.getMaxConcurrency(item.organizationId);
    if (maxConcurrency >= 0) {
      const alreadyInFlight = await deps.queueStore.countInFlightForOrganization(item.organizationId);
      if (alreadyInFlight >= maxConcurrency) {
        outcomes.push({ queueItemId: item.id, organizationId: item.organizationId, outcome: "skipped_concurrency_limit" });
        continue;
      }
    }

    if (item.attempts >= item.maxAttempts) {
      await deps.queueStore.updateStatus(item.id, "failed");
      outcomes.push({ queueItemId: item.id, organizationId: item.organizationId, outcome: "provisioning_failed", error: "attempts_exhausted" });
      continue;
    }
    if (!await deps.queueStore.claimForAssignment(item.id, maxConcurrency)) {
      outcomes.push({ queueItemId: item.id, organizationId: item.organizationId, outcome: "skipped_concurrency_limit" });
      continue;
    }
    const result = await assignOne(deps, item);
    outcomes.push(result);
  }

  return outcomes;
}

async function assignOne(deps: SchedulerDeps, item: QueueItem): Promise<ScheduleOutcome> {
  let runner: Awaited<ReturnType<RunnerStore["createRunner"]>> | undefined;
  let allocatedId: string | undefined;
  try {
    runner = await deps.runnerStore.createRunner({ organizationId: item.organizationId, provider: deps.runnerProvider.name, requestedResourceClass: item.requestedResourceClass, repositoryId: item.repositoryId });
    await deps.runnerStore.transitionRunnerStatus(runner.id, "provisioning");
    const credential = await deps.mintRunnerCredential?.({ runnerId: runner.id, jobId: item.id, organizationId: item.organizationId });
    const instance = await deps.runnerProvider.provisionRunner({
      organizationId: item.organizationId,
      repositoryId: item.repositoryId,
      resourceClass: item.requestedResourceClass,
      ...(credential ? { runnerCredential: { runnerId: runner.id, jobId: item.id, token: credential.token, apiBaseUrl: credential.apiBaseUrl }, jobCommand: credential.jobCommand } : {}),
    });
    allocatedId = instance.providerRunnerId;
    await deps.runnerStore.setProviderRunnerId(runner.id, instance.providerRunnerId);
    await deps.runnerStore.transitionRunnerStatus(runner.id, "ready");
    await deps.runnerStore.transitionRunnerStatus(runner.id, "assigned");
    await deps.runnerStore.assignJob(runner.id, item.id);
    if (!await deps.queueStore.completeAssignment(item.id, item.attempts + 1, runner.id)) throw new Error("assignment_expired_or_repository_inactive");
    return { queueItemId: item.id, organizationId: item.organizationId, outcome: "assigned", runnerId: runner.id };
  } catch (err) {
    // A late allocation must not revive a timed-out claim. Keep failed termination discoverable.
    let terminated = !allocatedId;
    if (allocatedId) {
      try { await deps.runnerProvider.terminateRunner(allocatedId); terminated = true; } catch { /* orphan sweep retries */ }
    }
    if (runner && terminated) await deps.runnerStore.transitionRunnerStatus(runner.id, "failed").catch(() => {});
    await deps.queueStore.failAssignment(item.id, item.attempts + 1, terminated);
    return { queueItemId: item.id, organizationId: item.organizationId, outcome: "provisioning_failed", runnerId: runner?.id, error: err instanceof Error ? err.message : String(err) };
  }
}
