/**
 * Phase 03 (2026-08-26): accepting a report from somebody else's CI.
 *
 * This is DiffCI's only machine-facing write path, so the tests are written from the attacker's and the
 * confused-user's side rather than the happy path's: no credential, a revoked one, one belonging to a
 * different repository, a payload too large to accept, a schema from a future client, and the same
 * report delivered four times.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeReport } from "./report-fixture.js";
import { ingestObservation } from "../../src/ingest/ingest.js";
import { makeD1ObservationStore } from "../../src/ingest/store.js";
import { makeD1IngestTokenStore } from "../../src/ingest/token.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1UsageStore } from "../../src/usage/store.js";

async function fixture() {
  const db = freshProductDb(["ingest", "usage"]);
  const d1 = makeD1(db);
  const productStore = makeD1ProductStore(d1);
  const tokenStore = makeD1IngestTokenStore(d1);
  const observationStore = makeD1ObservationStore(d1);
  const usageStore = makeD1UsageStore(d1);

  const user = await productStore.createUser({ email: "owner@example.com" });
  const orgA = await productStore.createOrganization({ name: "Org A", slug: "org-a", ownerUserId: user.id });
  const orgB = await productStore.createOrganization({ name: "Org B", slug: "org-b", ownerUserId: user.id });
  const repoA = await productStore.createRepository({ organizationId: orgA.id, providerRepositoryId: "111", ownerName: "orga/app" });
  const repoB = await productStore.createRepository({ organizationId: orgB.id, providerRepositoryId: "222", ownerName: "orgb/app" });
  await productStore.setRepositoryStatus(repoA.id, "active");
  await productStore.setRepositoryStatus(repoB.id, "active");

  const tokenA = await tokenStore.issue({ organizationId: orgA.id, repositoryId: repoA.id });
  const deps = { tokenStore, observationStore, productStore, usageStore };
  return { db, deps, productStore, tokenStore, observationStore, usageStore, orgA, orgB, repoA, repoB, tokenA };
}

function send(body: unknown, token?: string) {
  return { authorization: token ? `Bearer ${token}` : null, body: typeof body === "string" ? body : JSON.stringify(body) };
}

describe("observation ingest", () => {
  it("accepts a well-formed report and files it under the credential's own repository", async () => {
    const { deps, orgA, repoA, tokenA, observationStore } = await fixture();
    const result = await ingestObservation(send(makeReport(), tokenA.raw), deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.duplicate, false);
    assert.equal(result.record.organizationId, orgA.id);
    assert.equal(result.record.repositoryId, repoA.id);
    assert.equal(result.record.identityVerified, true);
    assert.equal(result.record.mode, "SELECTIVE");
    assert.equal(result.record.selectedTestCount, 1);
    assert.equal(result.record.totalTestCount, 12);
    assert.equal(result.record.baselineMode, "FULL");
    assert.equal(result.record.baselineSelectedTestCount, 12);
    assert.equal(result.record.worktreeUnchanged, true);

    const stored = await observationStore.getForOrganization(orgA.id, result.record.id);
    assert.ok(stored, "the observation is readable back within its own organization");
  });

  it("refuses without a credential - there is no anonymous ingest", async () => {
    const { deps } = await fixture();
    const result = await ingestObservation(send(makeReport()), deps);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection, "missing_token");
  });

  it("refuses an unknown, revoked or expired credential, and says which", async () => {
    const { deps, tokenStore, orgA, repoA } = await fixture();

    const unknown = await ingestObservation(send(makeReport(), "dci_nonexistent_token_value_here"), deps);
    assert.equal(unknown.ok === false && unknown.rejection, "invalid_token");

    const revoked = await tokenStore.issue({ organizationId: orgA.id, repositoryId: repoA.id });
    await tokenStore.revoke(orgA.id, revoked.record.id);
    const afterRevoke = await ingestObservation(send(makeReport(), revoked.raw), deps);
    assert.equal(afterRevoke.ok === false && afterRevoke.rejection, "revoked_token");

    const expired = await tokenStore.issue({ organizationId: orgA.id, repositoryId: repoA.id, ttlMs: -1 });
    const afterExpiry = await ingestObservation(send(makeReport(), expired.raw), deps);
    assert.equal(afterExpiry.ok === false && afterExpiry.rejection, "expired_token");
  });

  /**
   * The single most important case in this file. A token pasted into a different repository's CI - the
   * ordinary way a workflow gets copied - must not file that repository's observations under the
   * organization the token belongs to.
   */
  it("refuses a report from a different repository than the credential names", async () => {
    const { deps, tokenA } = await fixture();
    const foreign = makeReport({ repository: { provider: "github", ownerName: "orgb/app", providerRepositoryId: "222" } });
    const result = await ingestObservation(send(foreign, tokenA.raw), deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection, "repository_mismatch");
    assert.match(result.message, /valid for exactly one repository/);
  });

  it("accepts a report that makes no repository claim, but records that the claim was unverified", async () => {
    const { deps, tokenA } = await fixture();
    const local = makeReport({ repository: { provider: "unknown" }, ci: { provider: "local" } });
    const result = await ingestObservation(send(local, tokenA.raw), deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.identityVerified, false);
  });

  it("counts a re-delivered report exactly once, and does not re-meter or refresh the token on the repeat", async () => {
    const { deps, tokenStore, usageStore, orgA, tokenA } = await fixture();
    const report = makeReport();

    const first = await ingestObservation(send(report, tokenA.raw), deps);
    assert.equal(first.ok === true && first.duplicate, false);

    const usedAfterFirst = (await tokenStore.listForOrganization(orgA.id))[0]!.lastUsedAt;
    assert.ok(usedAfterFirst);

    for (let i = 0; i < 3; i++) {
      const again = await ingestObservation(send(report, tokenA.raw), deps);
      assert.equal(again.ok, true);
      if (!again.ok) return;
      assert.equal(again.duplicate, true);
      assert.equal(again.record.id, (first as { record: { id: string } }).record.id);
    }

    const analyzed = await usageStore.sumQuantityInRange(orgA.id, "ci_run_analyzed", "2000-01-01", "2100-01-01");
    assert.equal(analyzed, 1, "four deliveries of one observation is one analysed run");
  });

  it("treats a genuine workflow re-run (a new attempt) as a second observation", async () => {
    const { deps, tokenA, observationStore, orgA } = await fixture();
    await ingestObservation(send(makeReport(), tokenA.raw), deps);
    const attemptTwo = makeReport({ ci: { ...makeReport().ci, runAttempt: "2" } });
    const second = await ingestObservation(send(attemptTwo, tokenA.raw), deps);

    assert.equal(second.ok === true && second.duplicate, false);
    assert.equal((await observationStore.summarise(orgA.id)).total, 2);
  });

  it("meters what was analysed, so the ledger has something to be built from", async () => {
    const { deps, usageStore, orgA, tokenA } = await fixture();
    await ingestObservation(send(makeReport(), tokenA.raw), deps);

    assert.equal(await usageStore.sumQuantityInRange(orgA.id, "ci_run_analyzed", "2000-01-01", "2100-01-01"), 1);
    assert.equal(await usageStore.sumQuantityInRange(orgA.id, "tests_considered", "2000-01-01", "2100-01-01"), 12);
    assert.equal(await usageStore.sumQuantityInRange(orgA.id, "tests_selected", "2000-01-01", "2100-01-01"), 1);
  });

  it("records an audit entry that names the event but carries no paths and no credential", async () => {
    const { deps, productStore, orgA, tokenA } = await fixture();
    await ingestObservation(send(makeReport(), tokenA.raw), deps);

    const events = await productStore.listAuditEvents(orgA.id);
    const ingested = events.find((event) => event.action === "observation.ingested");
    assert.ok(ingested);
    const serialised = JSON.stringify(ingested);
    assert.equal(serialised.includes(tokenA.raw), false);
    assert.equal(serialised.includes("src/alpha.ts"), false);
  });

  it("refuses a payload larger than the cap, before parsing it", async () => {
    const { deps, tokenA } = await fixture();
    const huge = makeReport();
    huge.result!.selectedTests = Array.from({ length: 200 }, (_, i) => `test/file-${i}.test.ts`);
    const result = await ingestObservation(send(huge, tokenA.raw), { ...deps, maxReportBytes: 500 });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection, "payload_too_large");
    assert.match(result.message, /--redact-paths/);
  });

  it("refuses a body that is not JSON, and a document that is not a report", async () => {
    const { deps, tokenA } = await fixture();
    assert.equal((await ingestObservation(send("not json at all", tokenA.raw), deps)).ok, false);

    const notAReport = await ingestObservation(send({ hello: "world" }, tokenA.raw), deps);
    assert.equal(notAReport.ok === false && notAReport.rejection, "unsupported_schema");
  });

  it("refuses a schema it does not know, and says to update the action", async () => {
    const { deps, tokenA } = await fixture();
    const future = { ...makeReport(), schema: "diffci.observation.v9" };
    const result = await ingestObservation(send(future, tokenA.raw), deps);

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection, "unsupported_schema");
    assert.match(result.message, /Update the pinned DiffCI action/);
  });

  it("refuses when the repository has been paused or removed", async () => {
    const { deps, productStore, repoA, tokenA } = await fixture();
    await productStore.setRepositoryStatus(repoA.id, "paused");

    const result = await ingestObservation(send(makeReport(), tokenA.raw), deps);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.rejection, "repository_inactive");
  });

  it("stores refusals and errors too - a week of reports has to include the ones that failed", async () => {
    const { deps, tokenA, observationStore, orgA } = await fixture();
    const refused = makeReport({
      status: "REFUSED",
      stage: "context",
      reason: "pull request base is not present locally",
      result: undefined,
    });
    const result = await ingestObservation(send(refused, tokenA.raw), deps);

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.record.status, "REFUSED");
    assert.equal(result.record.stage, "context");
    assert.equal(result.record.mode, undefined);

    const summary = await observationStore.summarise(orgA.id);
    assert.deepEqual({ total: summary.total, observed: summary.observed, refused: summary.refused }, { total: 1, observed: 0, refused: 1 });
  });
});
