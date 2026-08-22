import assert from "node:assert/strict";
import type { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { InvalidRunnerTransitionError } from "../../src/runner/lifecycle.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

async function seedOrg(db: DatabaseSync, slug = "acme") {
  const store = makeD1ProductStore(makeD1(db));
  const user = await store.createUser({ email: `${slug}@example.com` });
  return store.createOrganization({ name: "Acme", slug, ownerUserId: user.id });
}

describe("RunnerStore - Part 14 persistence / tenant isolation", () => {
  it("creates a runner in 'requested' status and persists requested resource class", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db);
    const store = makeD1RunnerStore(makeD1(db));
    const runner = await store.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });
    assert.equal(runner.status, "requested");
    assert.equal(runner.requestedResourceClass, "standard-2");
  });

  it("transitionRunnerStatus enforces the lifecycle - an illegal transition throws and leaves the row unchanged", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db);
    const store = makeD1RunnerStore(makeD1(db));
    const runner = await store.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });

    await assert.rejects(() => store.transitionRunnerStatus(runner.id, "busy"), InvalidRunnerTransitionError); // requested -> busy is illegal
    const stillRequested = await store.getRunner(runner.id);
    assert.equal(stillRequested?.status, "requested", "an illegal transition attempt must not change the persisted status");
  });

  it("a valid transition stamps the matching timestamp field", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db);
    const store = makeD1RunnerStore(makeD1(db));
    const runner = await store.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });
    await store.transitionRunnerStatus(runner.id, "provisioning");
    const ready = await store.transitionRunnerStatus(runner.id, "ready");
    assert.ok(ready.readyAt);
  });

  it("cross-organization isolation: getRunnerForOrganization returns null for a runner belonging to a different org", async () => {
    const db = freshProductDb(["runner"]);
    const orgA = await seedOrg(db, "org-a");
    const orgB = await seedOrg(db, "org-b");
    const store = makeD1RunnerStore(makeD1(db));
    const runner = await store.createRunner({ organizationId: orgA.id, provider: "mock", requestedResourceClass: "standard-2" });

    const ownOrgLookup = await store.getRunnerForOrganization(runner.id, orgA.id);
    assert.equal(ownOrgLookup?.id, runner.id, "sanity: org A's own lookup must succeed");
    const crossOrgLookup = await store.getRunnerForOrganization(runner.id, orgB.id);
    assert.equal(crossOrgLookup, null, "org B must never be able to fetch org A's runner");
  });

  it("listRunnersForOrganization never returns another organization's runners", async () => {
    const db = freshProductDb(["runner"]);
    const orgA = await seedOrg(db, "org-a2");
    const orgB = await seedOrg(db, "org-b2");
    const store = makeD1RunnerStore(makeD1(db));
    await store.createRunner({ organizationId: orgA.id, provider: "mock", requestedResourceClass: "standard-2" });
    await store.createRunner({ organizationId: orgB.id, provider: "mock", requestedResourceClass: "standard-2" });

    const listA = await store.listRunnersForOrganization(orgA.id);
    assert.equal(listA.length, 1);
    assert.equal(listA[0]?.organizationId, orgA.id);
  });

  it("findStaleRunners only returns runners in the requested statuses older than the cutoff", async () => {
    const db = freshProductDb(["runner"]);
    const org = await seedOrg(db);
    const store = makeD1RunnerStore(makeD1(db));
    const runner = await store.createRunner({ organizationId: org.id, provider: "mock", requestedResourceClass: "standard-2" });

    const future = new Date(Date.now() + 60_000).toISOString(); // cutoff after createdAt -> should match
    const stale = await store.findStaleRunners(future, ["requested"]);
    assert.equal(stale.length, 1);
    assert.equal(stale[0]?.id, runner.id);

    const wrongStatus = await store.findStaleRunners(future, ["busy"]);
    assert.equal(wrongStatus.length, 0);
  });
});
