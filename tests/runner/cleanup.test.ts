import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { createMockRunnerProvider } from "../../src/runner/mock-provider.js";
import { runOrphanCleanup } from "../../src/runner/cleanup.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

describe("runOrphanCleanup - Part 15 (no compute resource should remain indefinitely)", () => {
  it("terminates a runner stuck in 'requested' past the provisioning timeout", async () => {
    const db = freshProductDb(["runner"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "a@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const provider = createMockRunnerProvider();
    const runner = await runnerStore.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });

    const farFuture = new Date(Date.now() + 10 * 60 * 1000); // 10 min after "now" - past the 5 min default provisioning timeout
    const results = await runOrphanCleanup(runnerStore, provider, undefined, farFuture);

    assert.equal(results.length, 1);
    assert.equal(results[0]?.runnerId, runner.id);
    assert.equal(results[0]?.terminated, true);
    const updated = await runnerStore.getRunner(runner.id);
    assert.equal(updated?.status, "terminated");
  });

  it("does not touch a healthy, recently-created runner", async () => {
    const db = freshProductDb(["runner"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "b@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme2", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const provider = createMockRunnerProvider();
    await runnerStore.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });

    const results = await runOrphanCleanup(runnerStore, provider); // now === creation time, well within every timeout
    assert.equal(results.length, 0);
  });

  it("idempotently terminates the underlying provider runner via terminateRunner (safe even if called again)", async () => {
    const db = freshProductDb(["runner"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "c@example.com" });
    const org = await productStore.createOrganization({ name: "Acme", slug: "acme3", ownerUserId: user.id });
    const runnerStore = makeD1RunnerStore(makeD1(db));
    const provider = createMockRunnerProvider();
    const runner = await runnerStore.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });
    await runnerStore.transitionRunnerStatus(runner.id, "provisioning");
    const instance = await provider.provisionRunner({ organizationId: org.id, resourceClass: "standard-2" });
    await runnerStore.setProviderRunnerId(runner.id, instance.providerRunnerId);
    await runnerStore.transitionRunnerStatus(runner.id, "ready");
    await runnerStore.transitionRunnerStatus(runner.id, "assigned");
    await runnerStore.transitionRunnerStatus(runner.id, "busy");

    const farFuture = new Date(Date.now() + 2 * 60 * 60 * 1000); // past the 60 min execution timeout
    const first = await runOrphanCleanup(runnerStore, provider, undefined, farFuture);
    assert.equal(first[0]?.terminated, true);

    // Running cleanup again after the runner is already terminated must not find/re-terminate it (it's
    // no longer in a stale-eligible status).
    const second = await runOrphanCleanup(runnerStore, provider, undefined, farFuture);
    assert.equal(second.length, 0);
  });
});
