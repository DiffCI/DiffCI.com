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
  queueStore: ExecutionQueueStore;
  runnerStore: RunnerStore;
  runnerProvider: RunnerProvider;
  /** Returns the organization's current max-concurrency entitlement (-1 = unlimited). */
  getMaxConcurrency: (organizationId: string) => Promise<number>;
}

export interface ScheduleOutcome {
  queueItemId: string;
  organizationId: string;
  outcome: "assigned" | "skipped_concurrency_limit" | "provisioning_failed";
  runnerId?: string;
  error?: string;
}

export async function scheduleNext(deps: SchedulerDeps, batchLimit = 50): Promise<ScheduleOutcome[]> {
  const queued = await deps.queueStore.listQueuedItems(batchLimit);
  const outcomes: ScheduleOutcome[] = [];
  const inFlightThisPass = new Map<string, number>();

  for (const item of queued) {
    const maxConcurrency = await deps.getMaxConcurrency(item.organizationId);
    if (maxConcurrency >= 0) {
      const alreadyInFlight = (await deps.queueStore.countInFlightForOrganization(item.organizationId)) + (inFlightThisPass.get(item.organizationId) ?? 0);
      if (alreadyInFlight >= maxConcurrency) {
        outcomes.push({ queueItemId: item.id, organizationId: item.organizationId, outcome: "skipped_concurrency_limit" });
        continue;
      }
    }

    const result = await assignOne(deps, item);
    outcomes.push(result);
    if (result.outcome === "assigned") {
      inFlightThisPass.set(item.organizationId, (inFlightThisPass.get(item.organizationId) ?? 0) + 1);
    }
  }

  return outcomes;
}

async function assignOne(deps: SchedulerDeps, item: QueueItem): Promise<ScheduleOutcome> {
  await deps.queueStore.updateStatus(item.id, "assigning");

  const runner = await deps.runnerStore.createRunner({ organizationId: item.organizationId, provider: deps.runnerProvider.name, requestedResourceClass: item.requestedResourceClass, repositoryId: item.repositoryId });

  try {
    await deps.runnerStore.transitionRunnerStatus(runner.id, "provisioning");
    const instance = await deps.runnerProvider.provisionRunner({ organizationId: item.organizationId, repositoryId: item.repositoryId, resourceClass: item.requestedResourceClass });
    await deps.runnerStore.setProviderRunnerId(runner.id, instance.providerRunnerId);
    await deps.runnerStore.transitionRunnerStatus(runner.id, "ready");
    await deps.runnerStore.transitionRunnerStatus(runner.id, "assigned");
    await deps.runnerStore.assignJob(runner.id, item.id);
    await deps.queueStore.updateStatus(item.id, "assigned", { assignedRunnerId: runner.id, incrementAttempts: true });
    return { queueItemId: item.id, organizationId: item.organizationId, outcome: "assigned", runnerId: runner.id };
  } catch (err) {
    await deps.runnerStore.transitionRunnerStatus(runner.id, "failed").catch(() => {}); // best-effort - do not let a status-transition failure mask the original provisioning error
    await deps.queueStore.updateStatus(item.id, "queued", { incrementAttempts: true }); // return to the queue for a retry, per Part 16's attempts/maxAttempts fields
    return { queueItemId: item.id, organizationId: item.organizationId, outcome: "provisioning_failed", runnerId: runner.id, error: err instanceof Error ? err.message : String(err) };
  }
}
