/**
 * Part 25: organization entitlements actually limit the scheduler's concurrency, end to end (real
 * scheduler + real RunnerStore/QueueStore + real entitlement lookup, mock RunnerProvider).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { makeD1ExecutionQueueStore } from "../../src/execution-queue/store.js";
import { createMockRunnerProvider } from "../../src/runner/mock-provider.js";
import { scheduleNext } from "../../src/execution-queue/scheduler.js";
import { makeEntitlementConcurrencyLookup } from "../../src/execution-queue/entitlement-concurrency.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

describe("makeEntitlementConcurrencyLookup + scheduleNext - Part 25", () => {
  it("free-plan organization is capped at maxConcurrency=1 (its plan's real entitlement)", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "free@example.com" });
    const org = await productStore.createOrganization({ name: "FreeOrg", slug: "free-org", ownerUserId: user.id });
    // currentPlan defaults to 'free', billingStatus defaults to 'none' -> getEntitlementsForOrganization
    // falls back to DEFAULT_ENTITLEMENTS (free-tier) regardless, so this genuinely exercises the free plan's maxConcurrency=1.

    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();
    await queueStore.enqueue({ organizationId: org.id, jobReference: "job-1", requestedResourceClass: "standard-2" });
    await queueStore.enqueue({ organizationId: org.id, jobReference: "job-2", requestedResourceClass: "standard-2" });

    const getMaxConcurrency = makeEntitlementConcurrencyLookup((id) => productStore.getOrganization(id));
    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency });
    assert.equal(outcomes.filter((o) => o.outcome === "assigned").length, 1, "free plan must cap at 1 concurrent job");
    assert.equal(outcomes.filter((o) => o.outcome === "skipped_concurrency_limit").length, 1);
  });

  it("an active 'business' plan organization gets a much higher (effectively unbounded-for-this-test) limit", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "biz@example.com" });
    const org = await productStore.createOrganization({ name: "BizOrg", slug: "biz-org", ownerUserId: user.id });
    await productStore.updateOrganizationBilling(org.id, { billingStatus: "active", currentPlan: "business" });

    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();
    for (let i = 0; i < 5; i++) await queueStore.enqueue({ organizationId: org.id, jobReference: `job-${i}`, requestedResourceClass: "standard-2" });

    const getMaxConcurrency = makeEntitlementConcurrencyLookup((id) => productStore.getOrganization(id));
    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency });
    assert.equal(outcomes.filter((o) => o.outcome === "assigned").length, 5, "business plan's maxConcurrency=20 easily covers 5 queued jobs");
  });

  it("two organizations on different plans have fully independent limits", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const userFree = await productStore.createUser({ email: "free2@example.com" });
    const userTeam = await productStore.createUser({ email: "team2@example.com" });
    const freeOrg = await productStore.createOrganization({ name: "Free2", slug: "free-org-2", ownerUserId: userFree.id });
    const teamOrg = await productStore.createOrganization({ name: "Team2", slug: "team-org-2", ownerUserId: userTeam.id });
    await productStore.updateOrganizationBilling(teamOrg.id, { billingStatus: "active", currentPlan: "team" }); // maxConcurrency=5

    const runnerStore = makeD1RunnerStore(makeD1(db));
    const queueStore = makeD1ExecutionQueueStore(makeD1(db));
    const provider = createMockRunnerProvider();
    for (let i = 0; i < 3; i++) await queueStore.enqueue({ organizationId: freeOrg.id, jobReference: `f-${i}`, requestedResourceClass: "standard-2" });
    for (let i = 0; i < 3; i++) await queueStore.enqueue({ organizationId: teamOrg.id, jobReference: `t-${i}`, requestedResourceClass: "standard-2" });

    const getMaxConcurrency = makeEntitlementConcurrencyLookup((id) => productStore.getOrganization(id));
    const outcomes = await scheduleNext({ queueStore, runnerStore, runnerProvider: provider, getMaxConcurrency });
    assert.equal(outcomes.filter((o) => o.organizationId === freeOrg.id && o.outcome === "assigned").length, 1, "free org still capped at 1 regardless of team org's activity");
    assert.equal(outcomes.filter((o) => o.organizationId === teamOrg.id && o.outcome === "assigned").length, 3, "team org's own 3 jobs all fit under its limit of 5");
  });

  it("an unknown organization id gets zero concurrency, never unlimited by default", async () => {
    const db = freshProductDb(["runner", "execution-queue"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const getMaxConcurrency = makeEntitlementConcurrencyLookup((id) => productStore.getOrganization(id));
    assert.equal(await getMaxConcurrency("never-existed"), 0);
  });
});
