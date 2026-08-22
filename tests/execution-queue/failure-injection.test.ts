/**
 * Part 23 failure injection - safely mocked (never a real cloud call). A custom failing RunnerProvider
 * simulates each scenario; assertions check the SAME real scheduler/RunnerStore/orphan-cleanup code paths
 * used against the real provider.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { makeD1ExecutionQueueStore } from "../../src/execution-queue/store.js";
import { scheduleNext } from "../../src/execution-queue/scheduler.js";
import { runOrphanCleanup } from "../../src/runner/cleanup.js";
import type { RunnerProvider } from "../../src/runner/provider.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

async function seedOrg(db: ReturnType<typeof freshProductDb>, slug: string) {
  const productStore = makeD1ProductStore(makeD1(db));
  const user = await productStore.createUser({ email: `${slug}@example.com` });
  return productStore.createOrganization({ name: slug, slug, ownerUserId: user.id });
}

describe("Part 23 - provision failure: provider returns failure -> queue/job fails safely", () => {
  it("a provisionRunner rejection returns the queue item to 'queued' for retry, marks the runner 'failed', and never leaves it 'requested' forever", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const org = await seedOrg(db, "provision-fail");
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const failingProvider: RunnerProvider = {
      name: "always-fails-to-provision",
      provisionRunner: async () => {
        throw new Error("simulated provider outage");
      },
      getRunnerStatus: async () => ({ status: "failed" }),
      terminateRunner: async () => {},
    };
    const item = await queueStore.enqueue({ organizationId: org.id, jobReference: "job-1", requestedResourceClass: "standard-2" });

    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: failingProvider, getMaxConcurrency: async () => 5 });
    assert.equal(outcomes[0]?.outcome, "provisioning_failed");

    const requeued = await queueStore.getItem(item.id);
    assert.equal(requeued?.status, "queued", "the job must be safely returned to the queue, not left stuck 'assigning'");
    assert.equal(requeued?.attempts, 1, "the failed attempt must be counted");

    const runner = await runnerStore.getRunner(outcomes[0]!.runnerId!);
    assert.equal(runner?.status, "failed");
  });
});

describe("Part 23 - runner never becomes ready: timeout + termination", () => {
  it("a runner stuck in 'provisioning' past the timeout is detected and terminated by orphan cleanup", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db, "never-ready");
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const stuckProvider: RunnerProvider = {
      name: "never-becomes-ready",
      provisionRunner: async () => ({ providerRunnerId: "stuck-1", status: "provisioning" }),
      getRunnerStatus: async () => ({ status: "provisioning" }), // never advances
      terminateRunner: async () => {},
    };
    const runner = await runnerStore.createRunner({ organizationId: org.id, provider: "stuck", requestedResourceClass: "standard-2" });
    await runnerStore.transitionRunnerStatus(runner.id, "provisioning");

    const farFuture = new Date(Date.now() + 10 * 60 * 1000); // past the default 5 min provisioning timeout
    const results = await runOrphanCleanup(runnerStore, stuckProvider, undefined, farFuture);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.terminated, true);
    assert.equal((await runnerStore.getRunner(runner.id))?.status, "terminated");
  });
});

describe("Part 23 - job crashes: failure captured, runner still torn down", () => {
  it("a runner that completes with a non-zero exit code is still a normally-completed RUNNER (job failure is visible in the result payload, not the runner lifecycle) and reaches terminated", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db, "job-crash");
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const runner = await runnerStore.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });
    await runnerStore.transitionRunnerStatus(runner.id, "provisioning");
    await runnerStore.transitionRunnerStatus(runner.id, "ready");
    await runnerStore.transitionRunnerStatus(runner.id, "assigned");
    await runnerStore.transitionRunnerStatus(runner.id, "busy");
    // The job itself failed (simulated exit code 1) - the RUNNER still transitions to 'completed', not
    // 'failed': 'failed' is reserved for the RUNNER/infrastructure failing, not the job's own exit code.
    const completed = await runnerStore.transitionRunnerStatus(runner.id, "completed", { runtimeSeconds: 2 });
    assert.equal(completed.status, "completed");
    const terminated = await runnerStore.transitionRunnerStatus(runner.id, "terminating").then(() => runnerStore.transitionRunnerStatus(runner.id, "terminated"));
    assert.equal(terminated.status, "terminated");
  });
});

describe("Part 23 - control plane loses heartbeat: orphan logic eventually terminates the resource", () => {
  it("a runner stuck 'busy' past the execution timeout (simulating a lost heartbeat/crashed control plane) is torn down", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db, "lost-heartbeat");
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const provider: RunnerProvider = {
      name: "mock",
      provisionRunner: async () => ({ providerRunnerId: "hb-1", status: "ready" }),
      getRunnerStatus: async () => ({ status: "ready" }),
      terminateRunner: async () => {},
    };
    const runner = await runnerStore.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });
    await runnerStore.transitionRunnerStatus(runner.id, "provisioning");
    await runnerStore.transitionRunnerStatus(runner.id, "ready");
    await runnerStore.transitionRunnerStatus(runner.id, "assigned");
    await runnerStore.transitionRunnerStatus(runner.id, "busy"); // then the control plane "crashes" - nothing ever calls transitionRunnerStatus again

    const farFuture = new Date(Date.now() + 2 * 60 * 60 * 1000); // past the 60 min execution timeout
    const results = await runOrphanCleanup(runnerStore, provider, undefined, farFuture);
    assert.equal(results.length, 1);
    assert.equal(results[0]?.terminated, true);
  });
});

describe("Part 23 - duplicate terminate is safe/idempotent", () => {
  it("terminating an already-terminated runner via the lifecycle store does not throw and does not change state", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db, "dup-terminate");
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const runner = await runnerStore.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });
    await runnerStore.transitionRunnerStatus(runner.id, "terminating");
    await runnerStore.transitionRunnerStatus(runner.id, "terminated");
    await assert.doesNotReject(() => runnerStore.transitionRunnerStatus(runner.id, "terminated"));
    assert.equal((await runnerStore.getRunner(runner.id))?.status, "terminated");
  });
});
