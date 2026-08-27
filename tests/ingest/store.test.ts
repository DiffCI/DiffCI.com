/**
 * Phase 03 (2026-08-26): observation storage and retention.
 *
 * The idempotency test here is deliberately at the STORE level rather than the handler level: the
 * guarantee is supposed to come from the database's UNIQUE constraint, not from a check in application
 * code, and the only way to show that is to insert the same key twice against a real schema.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ObservationStore, type NewObservation } from "../../src/ingest/store.js";
import { countOverdueObservations, retentionCutoffIso, runRetentionSweep, RETENTION_DAYS } from "../../src/ingest/retention.js";
import { makeD1ProductStore } from "../../src/product/store.js";

async function fixture() {
  const db = freshProductDb(["ingest"]);
  const d1 = makeD1(db);
  const products = makeD1ProductStore(d1);
  const store = makeD1ObservationStore(d1);
  const user = await products.createUser({ email: "owner@example.com" });
  const org = await products.createOrganization({ name: "A", slug: "a", ownerUserId: user.id });
  const repo = await products.createRepository({ organizationId: org.id, providerRepositoryId: "111", ownerName: "a/app" });
  return { db, d1, store, org, repo };
}

function observation(overrides: Partial<NewObservation> & Pick<NewObservation, "organizationId" | "repositoryId" | "idempotencyKey">): NewObservation {
  return {
    schemaVersion: "diffci.observation.v1",
    status: "OBSERVED",
    stage: "complete",
    mode: "SELECTIVE",
    blindSpot: false,
    worktreeUnchanged: true,
    blockingWorkflowFindings: 0,
    pathsRedacted: false,
    identityVerified: true,
    producedAt: "2026-08-26T10:00:00.000Z",
    reportBytes: 1234,
    report: { schema: "diffci.observation.v1" },
    ...overrides,
  };
}

describe("observation store", () => {
  it("stores once and returns the stored row on every repeat", async () => {
    const { store, org, repo } = await fixture();
    const input = observation({ organizationId: org.id, repositoryId: repo.id, idempotencyKey: "k1", selectedTestCount: 3 });

    const first = await store.recordIfNew(input);
    assert.equal(first.duplicate, false);

    const second = await store.recordIfNew(input);
    assert.equal(second.duplicate, true);
    assert.equal(second.record.id, first.record.id);
    assert.equal(second.record.selectedTestCount, 3);
  });

  it("keeps the report as received, parsed back exactly", async () => {
    const { store, org, repo } = await fixture();
    const report = { schema: "diffci.observation.v1", nested: { list: [1, 2, 3], flag: false } };
    const { record } = await store.recordIfNew(observation({ organizationId: org.id, repositoryId: repo.id, idempotencyKey: "k2", report }));

    const read = await store.getForOrganization(org.id, record.id);
    assert.deepEqual(read?.report, report);
  });

  it("summarises what a week of reports actually contained, including the failures", async () => {
    const { store, org, repo } = await fixture();
    const base = { organizationId: org.id, repositoryId: repo.id };
    await store.recordIfNew(observation({ ...base, idempotencyKey: "s1", status: "OBSERVED", mode: "SELECTIVE" }));
    await store.recordIfNew(observation({ ...base, idempotencyKey: "s2", status: "OBSERVED", mode: "FULL" }));
    await store.recordIfNew(observation({ ...base, idempotencyKey: "s3", status: "REFUSED", stage: "context", mode: undefined }));
    await store.recordIfNew(observation({ ...base, idempotencyKey: "s4", status: "ERROR", stage: "graph", mode: undefined, worktreeUnchanged: false }));

    const summary = await store.summarise(org.id);
    assert.deepEqual(
      {
        total: summary.total,
        observed: summary.observed,
        refused: summary.refused,
        errored: summary.errored,
        selective: summary.selective,
        full: summary.full,
        worktreeUnchanged: summary.worktreeUnchanged,
        distinctRepositories: summary.distinctRepositories,
      },
      { total: 4, observed: 2, refused: 1, errored: 1, selective: 1, full: 1, worktreeUnchanged: 3, distinctRepositories: 1 },
    );
  });

  it("lists newest first and honours the limit", async () => {
    const { store, org, repo } = await fixture();
    for (let i = 0; i < 5; i++) {
      await store.recordIfNew(observation({ organizationId: org.id, repositoryId: repo.id, idempotencyKey: `l${i}` }));
    }
    const listed = await store.listForOrganization(org.id, { limit: 2 });
    assert.equal(listed.length, 2);
    assert.ok(listed[0]!.receivedAt >= listed[1]!.receivedAt);
  });
});

describe("retention", () => {
  it("removes nothing that is inside the window", async () => {
    const { store, org, repo } = await fixture();
    await store.recordIfNew(observation({ organizationId: org.id, repositoryId: repo.id, idempotencyKey: "fresh" }));

    const result = await runRetentionSweep(store);
    assert.equal(result.deleted, 0);
    assert.equal(result.retentionDays, RETENTION_DAYS);
    assert.equal((await store.summarise(org.id)).total, 1);
  });

  it("removes everything past the cap, in every organization", async () => {
    const { db, store, org, repo } = await fixture();
    const { record } = await store.recordIfNew(observation({ organizationId: org.id, repositoryId: repo.id, idempotencyKey: "old" }));
    // received_at is the server's own stamp, so an aged row is made by moving it back directly - the
    // alternative would be a clock injection that the production path does not have.
    const longAgo = new Date(Date.now() - (RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000).toISOString();
    db.prepare("UPDATE observations SET received_at = ? WHERE id = ?").run(longAgo, record.id);

    assert.equal((await countOverdueObservations(store)).overdue, 1);
    const result = await runRetentionSweep(store);
    assert.equal(result.deleted, 1);
    assert.equal((await store.summarise(org.id)).total, 0);
    assert.equal((await countOverdueObservations(store)).overdue, 0);
  });

  it("computes the cutoff from the published number of days", () => {
    const now = new Date("2026-08-26T00:00:00.000Z");
    assert.equal(retentionCutoffIso(now, 90), "2026-05-28T00:00:00.000Z");
  });
});
