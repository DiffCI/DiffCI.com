/**
 * Real-SQLite-backed tests for src/product/store.ts, same idiom as
 * tests/research/cloudflare/shadow-store.test.ts: node:sqlite's DatabaseSync applies the actual committed
 * schema.sql, so a typo in the schema file itself would fail here too, not just a hand-rolled fake.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ProductStore, type D1Binding } from "../../src/product/store.js";

const SCHEMA_PATH = join(dirname(fileURLToPath(import.meta.url)), "../../src/product/cloudflare/schema.sql");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

function makeD1(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const result = db.prepare(query).run(...(values as never[]));
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T = unknown>() {
              const rows = db.prepare(query).all(...(values as never[]));
              return { results: rows as T[] };
            },
            async first<T = unknown>() {
              const row = db.prepare(query).get(...(values as never[]));
              return (row ?? null) as T | null;
            },
          };
        },
      };
    },
  };
}

describe("product store - users/organizations/membership", () => {
  it("creates a user and organization, making the creator the owner", async () => {
    const store = makeD1ProductStore(makeD1(freshDb()));
    const user = await store.createUser({ email: "a@example.com", name: "Ada" });
    const org = await store.createOrganization({ name: "Acme", slug: "acme", ownerUserId: user.id });

    assert.equal(org.billingStatus, "none");
    assert.equal(org.currentPlan, "free");
    const membership = await store.getMembership(org.id, user.id);
    assert.equal(membership?.role, "owner");
    assert.equal(await store.isMember(org.id, user.id), true);
  });

  it("tenant isolation: a user with no membership is not a member", async () => {
    const store = makeD1ProductStore(makeD1(freshDb()));
    const owner = await store.createUser({ email: "owner@example.com" });
    const outsider = await store.createUser({ email: "outsider@example.com" });
    const org = await store.createOrganization({ name: "Acme", slug: "acme-2", ownerUserId: owner.id });

    assert.equal(await store.isMember(org.id, outsider.id), false);
  });

  it("updateOrganizationBilling only overwrites fields explicitly provided", async () => {
    const store = makeD1ProductStore(makeD1(freshDb()));
    const user = await store.createUser({ email: "b@example.com" });
    const org = await store.createOrganization({ name: "Acme", slug: "acme-3", ownerUserId: user.id });

    await store.updateOrganizationBilling(org.id, { billingStatus: "active", currentPlan: "team" });
    let fetched = await store.getOrganization(org.id);
    assert.equal(fetched?.billingStatus, "active");
    assert.equal(fetched?.currentPlan, "team");

    // billingStatus changes again but currentPlan is omitted - must stay "team", not reset.
    await store.updateOrganizationBilling(org.id, { billingStatus: "past_due" });
    fetched = await store.getOrganization(org.id);
    assert.equal(fetched?.billingStatus, "past_due");
    assert.equal(fetched?.currentPlan, "team", "omitted field must not be clobbered");
  });
});

describe("product store - repositories", () => {
  it("creates a repository scoped to an organization and enforces provider uniqueness", async () => {
    const store = makeD1ProductStore(makeD1(freshDb()));
    const user = await store.createUser({ email: "c@example.com" });
    const org = await store.createOrganization({ name: "Acme", slug: "acme-4", ownerUserId: user.id });

    const repo = await store.createRepository({ organizationId: org.id, providerRepositoryId: "123", ownerName: "acme/web" });
    assert.equal(repo.status, "pending");
    assert.equal(repo.shadowEnabled, false);

    const list = await store.listRepositories(org.id);
    assert.equal(list.length, 1);
    assert.equal(list[0]?.ownerName, "acme/web");

    await assert.rejects(() => store.createRepository({ organizationId: org.id, providerRepositoryId: "123", ownerName: "acme/web-renamed" }));
  });

  it("cross-organization isolation: listRepositories never returns another org's repos", async () => {
    const store = makeD1ProductStore(makeD1(freshDb()));
    const userA = await store.createUser({ email: "d@example.com" });
    const userB = await store.createUser({ email: "e@example.com" });
    const orgA = await store.createOrganization({ name: "A", slug: "org-a", ownerUserId: userA.id });
    const orgB = await store.createOrganization({ name: "B", slug: "org-b", ownerUserId: userB.id });
    await store.createRepository({ organizationId: orgA.id, providerRepositoryId: "1", ownerName: "a/repo" });
    await store.createRepository({ organizationId: orgB.id, providerRepositoryId: "2", ownerName: "b/repo" });

    const listA = await store.listRepositories(orgA.id);
    assert.equal(listA.length, 1);
    assert.equal(listA[0]?.ownerName, "a/repo");
  });
});

describe("product store - audit log", () => {
  it("records and lists audit events scoped to an organization, with metadata round-tripping through JSON", async () => {
    const store = makeD1ProductStore(makeD1(freshDb()));
    const user = await store.createUser({ email: "f@example.com" });
    const org = await store.createOrganization({ name: "Acme", slug: "acme-5", ownerUserId: user.id });

    await store.recordAuditEvent({ organizationId: org.id, actorUserId: user.id, action: "repository.enrolled", targetType: "repository", targetId: "r1", metadata: { ownerName: "acme/web" } });
    const events = await store.listAuditEvents(org.id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.action, "repository.enrolled");
    assert.deepEqual(events[0]?.metadata, { ownerName: "acme/web" });
  });
});
