import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { makeD1ExecutionQueueStore } from "../../src/execution-queue/store.js";
import { createMockRunnerProvider } from "../../src/runner/mock-provider.js";
import { scheduleNext } from "../../src/execution-queue/scheduler.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import type { RunnerRequest } from "../../src/runner/types.js";

describe("scheduleNext - Part 17 (simple, deterministic, organization-level concurrency)", () => {
  it("assigns a queued item to a freshly-provisioned runner end to end", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "a@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();

    const item = await queueStore.enqueue({ organizationId: org.id, jobReference: "job-1", requestedResourceClass: "standard-2" });
    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency: async () => 5 });

    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.outcome, "assigned");
    const updatedItem = await queueStore.getItem(item.id);
    assert.equal(updatedItem?.status, "assigned");
    assert.ok(updatedItem?.assignedRunnerId);
    const runner = await runnerStore.getRunner(updatedItem!.assignedRunnerId!);
    assert.equal(runner?.status, "assigned");
  });

  it("enforces per-organization concurrency: the 2nd item is skipped when maxConcurrency=1", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "b@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme2", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();

    await queueStore.enqueue({ organizationId: org.id, jobReference: "job-1", requestedResourceClass: "standard-2" });
    await queueStore.enqueue({ organizationId: org.id, jobReference: "job-2", requestedResourceClass: "standard-2" });

    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency: async () => 1 });
    assert.equal(outcomes.filter((o) => o.outcome === "assigned").length, 1);
    assert.equal(outcomes.filter((o) => o.outcome === "skipped_concurrency_limit").length, 1);
  });

  it("unlimited concurrency (-1) never skips for the limit", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "c@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme3", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();
    for (let i = 0; i < 5; i++) await queueStore.enqueue({ organizationId: org.id, jobReference: `job-${i}`, requestedResourceClass: "standard-2" });

    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency: async () => -1 });
    assert.equal(outcomes.filter((o) => o.outcome === "assigned").length, 5);
  });

  it("cross-organization isolation: org A's concurrency limit never affects org B's scheduling", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const userA = await productStore.createUser({ email: "d@example.com" });
    const userB = await productStore.createUser({ email: "e@example.com" });
    const orgA = await productStore.createOrganization({ name: "A", slug: "org-a", ownerUserId: userA.id });
    const orgB = await productStore.createOrganization({ name: "B", slug: "org-b", ownerUserId: userB.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();
    await queueStore.enqueue({ organizationId: orgA.id, jobReference: "a-1", requestedResourceClass: "standard-2" });
    await queueStore.enqueue({ organizationId: orgA.id, jobReference: "a-2", requestedResourceClass: "standard-2" });
    await queueStore.enqueue({ organizationId: orgB.id, jobReference: "b-1", requestedResourceClass: "standard-2" });

    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency: async (orgId) => (orgId === orgA.id ? 1 : 10) });
    const assignedForA = outcomes.filter((o) => o.organizationId === orgA.id && o.outcome === "assigned").length;
    const assignedForB = outcomes.filter((o) => o.organizationId === orgB.id && o.outcome === "assigned").length;
    assert.equal(assignedForA, 1, "org A capped at 1");
    assert.equal(assignedForB, 1, "org B's single item must still be assigned regardless of org A's limit");
  });
});

describe("scheduleNext - R1 mintRunnerCredential hook", () => {
  it("when supplied, the hook's result is merged into the RunnerRequest passed to provisionRunner()", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "c@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme-r1", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));

    const seenRequests: RunnerRequest[] = [];
    const provider = {
      name: "spy",
      async provisionRunner(request: RunnerRequest) {
        seenRequests.push(request);
        return { providerRunnerId: "spy-1", status: "provisioning" as const };
      },
      async getRunnerStatus() {
        return { status: "provisioning" as const };
      },
      async terminateRunner() {},
    };

    await queueStore.enqueue({ organizationId: org.id, jobReference: "job-1", requestedResourceClass: "lite" });
    await scheduleNext({
      queueStore,
      runnerStore,
      runnerProvider: provider,
      getMaxConcurrency: async () => 5,
      mintRunnerCredential: async ({ runnerId, jobId, organizationId }) => ({ token: `token-for-${runnerId}-${jobId}-${organizationId}`, apiBaseUrl: "https://api.example", jobCommand: "echo hi" }),
    });

    assert.equal(seenRequests.length, 1);
    const request = seenRequests[0]!;
    assert.ok(request.runnerCredential);
    assert.equal(request.jobCommand, "echo hi");
    assert.equal(request.runnerCredential!.apiBaseUrl, "https://api.example");
    assert.match(request.runnerCredential!.token, /^token-for-/);
    assert.equal(request.runnerCredential!.jobId, request.runnerCredential!.jobId); // sanity - jobId is present and self-consistent
    assert.match(request.runnerCredential!.token, new RegExp(`-${org.id}$`), "the org id passed to mintRunnerCredential must be the real enqueued item's organizationId");
  });

  it("when omitted, providers that don't need credentials are completely unaffected (backward compatible)", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "d@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme-r1b", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();

    await queueStore.enqueue({ organizationId: org.id, jobReference: "job-1", requestedResourceClass: "standard-2" });
    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency: async () => 5 });
    assert.equal(outcomes[0]?.outcome, "assigned");
  });
});
