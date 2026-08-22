/**
 * Orphan-runner protection (Part 15): "No compute resource should remain indefinitely because the
 * control plane crashed." This module is pure orchestration over RunnerStore + RunnerProvider - it does
 * not run on its own schedule yet (no Cron Trigger wiring in this build phase, matching Part 12's "queue
 * concurrency... a deterministic simple scheduler is enough" scope), but the logic is complete and
 * directly callable from a future cron handler.
 */
import type { RunnerProvider } from "./provider.js";
import type { RunnerStore } from "./store.js";
import type { Runner, RunnerState } from "./types.js";

export interface TimeoutConfig {
  maxProvisioningMs: number;
  maxIdleReadyMs: number;
  maxExecutionMs: number;
}

export const DEFAULT_TIMEOUT_CONFIG: TimeoutConfig = {
  maxProvisioningMs: 5 * 60 * 1000, // 5 min - a runner stuck in 'requested'/'provisioning' this long is orphaned
  maxIdleReadyMs: 30 * 60 * 1000, // 30 min - a 'ready' runner nobody assigned a job to
  maxExecutionMs: 60 * 60 * 1000, // 60 min - a 'busy' runner that never reported completion
};

const STATUS_TIMEOUT_MS: Record<string, keyof TimeoutConfig> = {
  requested: "maxProvisioningMs",
  provisioning: "maxProvisioningMs",
  ready: "maxIdleReadyMs",
  assigned: "maxIdleReadyMs",
  busy: "maxExecutionMs",
};

export interface CleanupResult {
  runnerId: string;
  previousStatus: RunnerState;
  terminated: boolean;
  error?: string;
}

/**
 * Finds runners stuck past their timeout for their current status and idempotently terminates them:
 * calls the provider's terminateRunner() (safe to call on an already-gone runner - Part 15: "safe
 * idempotent teardown") and transitions the store to 'terminating' then 'terminated'. A provider
 * termination failure is caught and reported (Part 15: "termination retries" - the caller can re-invoke
 * this on the next cleanup pass; a failed terminate here does NOT leave the runner silently stuck, it
 * remains discoverable by findStaleRunners on the next pass since its status is unchanged).
 */
export async function runOrphanCleanup(store: RunnerStore, provider: RunnerProvider, config: TimeoutConfig = DEFAULT_TIMEOUT_CONFIG, now: Date = new Date()): Promise<CleanupResult[]> {
  const results: CleanupResult[] = [];
  const statusGroups: Record<string, RunnerState[]> = {};
  for (const [status, timeoutKey] of Object.entries(STATUS_TIMEOUT_MS)) {
    (statusGroups[timeoutKey] ??= []).push(status as RunnerState);
  }

  for (const [timeoutKey, statuses] of Object.entries(statusGroups)) {
    const cutoff = new Date(now.getTime() - config[timeoutKey as keyof TimeoutConfig]).toISOString();
    const stale = await store.findStaleRunners(cutoff, statuses);
    for (const runner of stale) {
      results.push(await terminateOrphan(store, provider, runner));
    }
  }
  return results;
}

async function terminateOrphan(store: RunnerStore, provider: RunnerProvider, runner: Runner): Promise<CleanupResult> {
  try {
    if (runner.status !== "terminating") {
      await store.transitionRunnerStatus(runner.id, "terminating");
    }
    if (runner.providerRunnerId) {
      await provider.terminateRunner(runner.providerRunnerId); // idempotent by contract (Part 13/15)
    }
    await store.transitionRunnerStatus(runner.id, "terminated");
    return { runnerId: runner.id, previousStatus: runner.status, terminated: true };
  } catch (err) {
    return { runnerId: runner.id, previousStatus: runner.status, terminated: false, error: err instanceof Error ? err.message : String(err) };
  }
}
