/**
 * Part 23 security tests for src/product/routes.ts, real-SQLite-backed (product + runner +
 * execution-queue + usage schemas together, plus a separate in-memory Stage 2F research schema for the
 * shadow read boundary - two genuinely separate databases, matching production topology).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1ShadowReadBoundary } from "../../src/product/shadow-read-boundary.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { makeD1ExecutionQueueStore } from "../../src/execution-queue/store.js";
import { makeD1UsageStore } from "../../src/usage/store.js";
import { getDashboardForOrganization, getOrganizationDetails, getQueueItemForOrganization, getRunnerStatusForOrganization, getSavingsSummaryForOrganization, getUsageSummaryForOrganization, listRecentQueueItems, listRecentRunnerJobs, listRepositoriesForOrganization, type RouteDeps } from "../../src/product/routes.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESEARCH_SCHEMA_DIR = join(HERE, "../../src/research/cloudflare");

function freshResearchDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of ["schema-migration-2026-08-21-stage2-shadow.sql", "schema-migration-2026-08-21-shadow-cron.sql", "schema-migration-2026-08-21-shadow-webhook.sql", "schema-migration-2026-08-21-shadow-source-integrity.sql", "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql", "schema-migration-2026-09-05-shadow-reconcile-terminal.sql", "schema-migration-2026-09-05-shadow-evidence-workflow.sql", "schema-migration-2026-09-05-shadow-auto-identification.sql"]) {
    db.exec(readFileSync(join(RESEARCH_SCHEMA_DIR, file), "utf8"));
  }
  return db;
}

async function setup() {
  const db = freshProductDb(["runner", "execution-queue", "usage"]);
  const researchDb = freshResearchDb();
  const productStore = makeD1ProductStore(makeD1(db));
  const shadowBoundary = makeD1ShadowReadBoundary(makeD1(researchDb));
  const runnerStore = makeD1RunnerStore(makeD1(db));
  const queueStore = makeD1ExecutionQueueStore(makeD1(db));
  const usageStore = makeD1UsageStore(makeD1(db));
  const deps: RouteDeps = { productStore, shadowBoundary, runnerStore, queueStore, usageStore };

  const userA = await productStore.createUser({ email: "a@example.com" });
  const userB = await productStore.createUser({ email: "b@example.com" });
  const orgA = await productStore.createOrganization({ name: "A", slug: "org-a", ownerUserId: userA.id });
  const orgB = await productStore.createOrganization({ name: "B", slug: "org-b", ownerUserId: userB.id });

  return { deps, productStore, runnerStore, queueStore, userA, userB, orgA, orgB };
}

describe("product routes - Part 23 (user A cannot read organization B)", () => {
  it("a member cannot query another organization's repository through their own savings endpoint", async () => {
    const { deps, productStore, userA, orgA, orgB } = await setup();
    await productStore.createRepository({ organizationId: orgB.id, providerRepositoryId: "private", ownerName: "b/private" });
    deps.shadowBoundary.listPredictions = async () => { throw new Error("foreign data must never be read"); };
    assert.deepEqual(await getSavingsSummaryForOrganization(deps, userA.id, orgA.id, "b/private"), { ok: false, error: "not_found" });
  });

  it("an empty organization's dashboard never reads global research safety", async () => {
    const { deps, userA, orgA } = await setup();
    deps.shadowBoundary.getSafetySnapshot = async () => { throw new Error("global safety leak"); };
    const result = await getDashboardForOrganization(deps, userA.id, orgA.id);
    assert.ok(result.ok);
    assert.equal(result.data.safety.verifiedGroundTruthRows, 0);
  });

  it("dashboard safety covers every connected repository and recent activity is sorted across repositories", async () => {
    const { deps, productStore, userA, orgA } = await setup();
    for (const name of ["a/older", "a/newer"]) await productStore.createRepository({ organizationId: orgA.id, providerRepositoryId: name, ownerName: name });
    const seen: string[] = [];
    deps.shadowBoundary.getSafetySnapshot = async (name) => {
      assert.ok(name); seen.push(name);
      return { evidenceBasis: "verified_ground_truth_only", evaluableFailures: 2, failuresPreserved: 1, falseNegatives: 1, verifiedGroundTruthRows: 3 };
    };
    deps.shadowBoundary.listPredictions = async (name) => [{ logicalDeltaKey: name, repository: name, headSha: "abc", planMode: "FULL", opportunityCategory: "MANDATORY_FALLBACK",
      testsSelectedDiffci: 1, testsTotalFull: 1, testsSelectedPath: 1, diffciAnalysisOverheadMs: 1,
      createdAt: name.endsWith("older") ? "2026-09-01T00:00:00Z" : "2026-09-02T00:00:00Z" }];
    const result = await getDashboardForOrganization(deps, userA.id, orgA.id);
    assert.ok(result.ok);
    assert.deepEqual(seen.sort(), ["a/newer", "a/older"]);
    assert.equal(result.data.safety.falseNegatives, 2);
    assert.equal(result.data.safety.verifiedGroundTruthRows, 6);
    assert.equal(result.data.recentActivity.recentPredictions[0]?.repository, "a/newer");
  });
  it("getOrganizationDetails: userB cannot read orgA", async () => {
    const { deps, userB, orgA } = await setup();
    const outcome = await getOrganizationDetails(deps, userB.id, orgA.id);
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("getOrganizationDetails: userA CAN read orgA (sanity)", async () => {
    const { deps, userA, orgA } = await setup();
    const outcome = await getOrganizationDetails(deps, userA.id, orgA.id);
    assert.equal(outcome.ok, true);
  });

  it("cross-org repository access blocked: listRepositoriesForOrganization", async () => {
    const { deps, productStore, userB, orgA } = await setup();
    await productStore.createRepository({ organizationId: orgA.id, providerRepositoryId: "1", ownerName: "org-a/web" });
    const outcome = await listRepositoriesForOrganization(deps, userB.id, orgA.id);
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("cross-org usage access blocked: getUsageSummaryForOrganization", async () => {
    const { deps, userB, orgA } = await setup();
    const outcome = await getUsageSummaryForOrganization(deps, userB.id, orgA.id);
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("cross-org savings access blocked: getSavingsSummaryForOrganization", async () => {
    const { deps, userB, orgA } = await setup();
    const outcome = await getSavingsSummaryForOrganization(deps, userB.id, orgA.id, "org-a/web");
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("cross-org runner access blocked: getRunnerStatusForOrganization never returns another org's runner, even by exact id", async () => {
    const { deps, runnerStore, userB, orgA } = await setup();
    const runner = await runnerStore.createRunner({ organizationId: orgA.id, provider: "mock", requestedResourceClass: "standard-2" });
    // userB is not even a member of orgA - must be rejected before the runner id is ever looked up.
    const outcome = await getRunnerStatusForOrganization(deps, userB.id, orgA.id, runner.id);
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("cross-org runner access blocked: a member of orgB querying orgA's runner ID through orgB's own scope gets not_found, never orgA's data", async () => {
    const { deps, runnerStore, userB, orgA, orgB } = await setup();
    const runnerInA = await runnerStore.createRunner({ organizationId: orgA.id, provider: "mock", requestedResourceClass: "standard-2" });
    // userB IS a member of orgB - querying orgB's scope for orgA's runner id must be not_found, not a leak.
    const outcome = await getRunnerStatusForOrganization(deps, userB.id, orgB.id, runnerInA.id);
    assert.equal(!outcome.ok && outcome.error, "not_found");
  });

  it("cross-org queue access blocked: listRecentQueueItems / getQueueItemForOrganization", async () => {
    const { deps, queueStore, userB, orgA, orgB } = await setup();
    const item = await queueStore.enqueue({ organizationId: orgA.id, jobReference: "job-1", requestedResourceClass: "standard-2" });

    const listOutcome = await listRecentQueueItems(deps, userB.id, orgA.id);
    assert.equal(!listOutcome.ok && listOutcome.error, "unauthorized");

    const itemOutcome = await getQueueItemForOrganization(deps, userB.id, orgB.id, item.id); // userB IS a member of orgB, item belongs to orgA
    assert.equal(!itemOutcome.ok && itemOutcome.error, "not_found");
  });

  it("cross-org runner list isolation: listRecentRunnerJobs for orgB never includes orgA's runners", async () => {
    const { deps, runnerStore, userB, orgA, orgB } = await setup();
    await runnerStore.createRunner({ organizationId: orgA.id, provider: "mock", requestedResourceClass: "standard-2" });
    await runnerStore.createRunner({ organizationId: orgB.id, provider: "mock", requestedResourceClass: "standard-2" });
    const outcome = await listRecentRunnerJobs(deps, userB.id, orgB.id);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.data.every((r) => r.organizationId === orgB.id));
  });

  it("getDashboardForOrganization is also membership-gated", async () => {
    const { deps, userB, orgA } = await setup();
    const outcome = await getDashboardForOrganization(deps, userB.id, orgA.id);
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("getDashboardForOrganization succeeds for a real member and never claims real CI-skipping safety", async () => {
    const { deps, userA, orgA } = await setup();
    const outcome = await getDashboardForOrganization(deps, userA.id, orgA.id);
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.data.safety.observationMode === "shadow_observation_only", "must never claim more than shadow observation");
    // 2026-09-05: the dashboard must state its evidence basis and label its savings figure as a projection.
    assert.ok(outcome.ok && outcome.data.safety.evidenceBasis === "verified_ground_truth_only");
    assert.ok(outcome.ok && outcome.data.safety.evidenceWorkflow.state === "no_repositories", "no repositories claimed yet - not identified, not awaiting");
    assert.ok(outcome.ok && outcome.data.overview.savingsBasis === "count_based_projection");
    assert.ok(outcome.ok && outcome.data.overview.savingsNotice.includes("not derived from admitted CI evidence"));
  });
});
