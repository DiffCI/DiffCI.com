/**
 * Part 18 - the synthetic execution proof: end-to-end validation of the runner/queue orchestration model
 * using a deterministic local "echo" job and the mock RunnerProvider. Proves, in one real, executed test
 * (not just individually-tested units):
 *
 *   queue -> runner provision -> runner ready -> job assigned -> job completes -> telemetry recorded -> runner terminated
 *
 * No GitHub production workflow depends on or is invoked by this test - the "job" is a literal in-process
 * echo function, never a real CI run.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { makeD1ExecutionQueueStore } from "../../src/execution-queue/store.js";
import { makeD1UsageStore } from "../../src/usage/store.js";
import { createMockRunnerProvider } from "../../src/runner/mock-provider.js";
import { scheduleNext } from "../../src/execution-queue/scheduler.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

/** The "synthetic job" itself (Part 18: "Example: echo or a local deterministic test command") - a
 * trivial, fully deterministic function standing in for whatever a real runner would eventually execute.
 * Its own execution has nothing to do with GitHub Actions/DiffCI's prediction engine. */
function runSyntheticEchoJob(input: string): { output: string; durationSeconds: number } {
  return { output: `echo: ${input}`, durationSeconds: 3 }; // fixed, deterministic - no real clock/process involved
}

describe("Synthetic execution proof - Part 18", () => {
  it("queue -> provision -> ready -> assigned -> busy -> completed -> telemetry -> terminated", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "synthetic@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme-synthetic", ownerUserId: user.id });
    const repo = await productStore.createRepository({ organizationId: org.id, providerRepositoryId: "1", ownerName: "acme/web" });

    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const usageStore = makeD1UsageStore(makeD1(db));
    const provider = createMockRunnerProvider();

    // --- queue -------------------------------------------------------------------------------------
    const item = await queueStore.enqueue({ organizationId: org.id, repositoryId: repo.id, jobReference: "synthetic-echo-job-1", requestedResourceClass: "standard-2" });
    assert.equal(item.status, "queued");

    // --- runner provision -> runner ready -> job assigned (via the real scheduler) -----------------
    const [outcome] = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency: async () => 5 });
    assert.equal(outcome?.outcome, "assigned");
    const runnerId = outcome!.runnerId!;

    const assignedRunner = await runnerStore.getRunner(runnerId);
    assert.equal(assignedRunner?.status, "assigned", "runner must have passed through provisioning -> ready -> assigned");
    assert.equal(assignedRunner?.providerRunnerId?.startsWith("mock-"), true);

    const assignedItem = await queueStore.getItem(item.id);
    assert.equal(assignedItem?.status, "assigned");
    assert.equal(assignedItem?.assignedRunnerId, runnerId);

    // --- job runs (busy) -----------------------------------------------------------------------------
    await runnerStore.transitionRunnerStatus(runnerId, "busy");
    await queueStore.updateStatus(item.id, "running");

    const result = runSyntheticEchoJob("hello-diffci");
    assert.equal(result.output, "echo: hello-diffci");

    // --- job completes --------------------------------------------------------------------------------
    await runnerStore.transitionRunnerStatus(runnerId, "completed", { runtimeSeconds: result.durationSeconds });
    await queueStore.updateStatus(item.id, "completed");

    const completedRunner = await runnerStore.getRunner(runnerId);
    assert.equal(completedRunner?.status, "completed");
    assert.equal(completedRunner?.runtimeSeconds, 3);

    // --- telemetry recorded (Part 18 explicitly requires this step, and it's real usage-ledger data,
    // not a log line - see Part 5's runner_seconds/runner_job event types) ---------------------------
    const runnerSecondsEvent = await usageStore.recordUsageEventIfNew({
      organizationId: org.id, repositoryId: repo.id, eventType: "runner_seconds", quantity: result.durationSeconds, unit: "seconds",
      sourceType: "runner_completion", sourceId: runnerId, occurredAt: new Date().toISOString(),
    });
    const runnerJobEvent = await usageStore.recordUsageEventIfNew({
      organizationId: org.id, repositoryId: repo.id, eventType: "runner_job", quantity: 1, unit: "count",
      sourceType: "runner_completion", sourceId: runnerId, occurredAt: new Date().toISOString(),
    });
    assert.ok(runnerSecondsEvent, "telemetry must be durably recorded, not just held in memory");
    assert.ok(runnerJobEvent);
    const recordedSeconds = await usageStore.sumQuantityInRange(org.id, "runner_seconds", "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z");
    assert.equal(recordedSeconds, 3);

    // --- runner terminated ----------------------------------------------------------------------------
    await runnerStore.transitionRunnerStatus(runnerId, "terminating");
    await provider.terminateRunner(assignedRunner!.providerRunnerId!);
    const terminatedRunner = await runnerStore.transitionRunnerStatus(runnerId, "terminated");
    assert.equal(terminatedRunner.status, "terminated");
    assert.ok(terminatedRunner.terminatedAt);

    const providerStatus = await provider.getRunnerStatus(assignedRunner!.providerRunnerId!);
    assert.equal(providerStatus.status, "terminated", "the underlying provider-side runner must also be gone, not just the DB record");
  });
});
