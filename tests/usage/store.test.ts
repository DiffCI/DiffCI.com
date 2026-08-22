/**
 * Real-SQLite-backed tests for src/usage/store.ts. Part 6/24 focus: idempotency under duplicate
 * delivery, and organization isolation.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ProductStore, type D1Binding } from "../../src/product/store.js";
import { deriveIdempotencyKey, makeD1UsageStore } from "../../src/usage/store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(HERE, "../../src/product/cloudflare/schema.sql"), "utf8"));
  db.exec(readFileSync(join(HERE, "../../src/usage/cloudflare/schema.sql"), "utf8"));
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

async function seedOrg(db: DatabaseSync, slug = "acme") {
  const store = makeD1ProductStore(makeD1(db));
  const user = await store.createUser({ email: `${slug}@example.com` });
  const org = await store.createOrganization({ name: "Acme", slug, ownerUserId: user.id });
  const repo = await store.createRepository({ organizationId: org.id, providerRepositoryId: slug, ownerName: `${slug}/web` });
  return { org, repo };
}

describe("deriveIdempotencyKey - Part 6", () => {
  it("is stable for the same (org, eventType, sourceId) and different for any change", () => {
    const k1 = deriveIdempotencyKey("org_1", "ci_run_analyzed", "run_42");
    assert.equal(k1, deriveIdempotencyKey("org_1", "ci_run_analyzed", "run_42"));
    assert.notEqual(k1, deriveIdempotencyKey("org_2", "ci_run_analyzed", "run_42"));
    assert.notEqual(k1, deriveIdempotencyKey("org_1", "prediction", "run_42"));
    assert.notEqual(k1, deriveIdempotencyKey("org_1", "ci_run_analyzed", "run_43"));
  });
});

describe("UsageStore - Part 6 idempotency / Part 24", () => {
  it("one event counted once", async () => {
    const db = freshDb();
    const { org, repo } = await seedOrg(db);
    const usage = makeD1UsageStore(makeD1(db));
    const recorded = await usage.recordUsageEventIfNew({
      organizationId: org.id, repositoryId: repo.id, eventType: "ci_run_analyzed", quantity: 1, unit: "count",
      sourceType: "github_webhook", sourceId: "run_1", occurredAt: "2026-08-01T00:00:00Z",
    });
    assert.ok(recorded);
    const total = await usage.sumQuantityInRange(org.id, "ci_run_analyzed", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(total, 1);
  });

  it("duplicate event (same webhook redelivered) is ignored, not double-counted", async () => {
    const db = freshDb();
    const { org, repo } = await seedOrg(db);
    const usage = makeD1UsageStore(makeD1(db));
    const input = { organizationId: org.id, repositoryId: repo.id, eventType: "ci_run_analyzed" as const, quantity: 1, unit: "count", sourceType: "github_webhook", sourceId: "run_1", occurredAt: "2026-08-01T00:00:00Z" };
    const first = await usage.recordUsageEventIfNew(input);
    const duplicate = await usage.recordUsageEventIfNew(input);
    assert.ok(first);
    assert.equal(duplicate, null);
    const total = await usage.sumQuantityInRange(org.id, "ci_run_analyzed", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(total, 1, "must still be exactly 1, not 2");
  });

  it("two distinct events (different source_id) are counted twice", async () => {
    const db = freshDb();
    const { org, repo } = await seedOrg(db);
    const usage = makeD1UsageStore(makeD1(db));
    for (const sourceId of ["run_1", "run_2"]) {
      await usage.recordUsageEventIfNew({ organizationId: org.id, repositoryId: repo.id, eventType: "ci_run_analyzed", quantity: 1, unit: "count", sourceType: "github_webhook", sourceId, occurredAt: "2026-08-01T00:00:00Z" });
    }
    const total = await usage.sumQuantityInRange(org.id, "ci_run_analyzed", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(total, 2);
  });

  it("aggregation respects month boundaries", async () => {
    const db = freshDb();
    const { org, repo } = await seedOrg(db);
    const usage = makeD1UsageStore(makeD1(db));
    await usage.recordUsageEventIfNew({ organizationId: org.id, repositoryId: repo.id, eventType: "ci_run_analyzed", quantity: 1, unit: "count", sourceType: "x", sourceId: "july_run", occurredAt: "2026-07-31T23:59:59Z" });
    await usage.recordUsageEventIfNew({ organizationId: org.id, repositoryId: repo.id, eventType: "ci_run_analyzed", quantity: 1, unit: "count", sourceType: "x", sourceId: "aug_run", occurredAt: "2026-08-01T00:00:01Z" });
    const augustTotal = await usage.sumQuantityInRange(org.id, "ci_run_analyzed", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(augustTotal, 1, "the July event must not leak into the August window");
  });

  it("organization isolation: org A's usage never appears in org B's totals", async () => {
    const db = freshDb();
    const { org: orgA, repo: repoA } = await seedOrg(db, "org-a");
    const { org: orgB, repo: repoB } = await seedOrg(db, "org-b");
    const usage = makeD1UsageStore(makeD1(db));
    await usage.recordUsageEventIfNew({ organizationId: orgA.id, repositoryId: repoA.id, eventType: "prediction", quantity: 5, unit: "count", sourceType: "x", sourceId: "a1", occurredAt: "2026-08-01T00:00:00Z" });
    await usage.recordUsageEventIfNew({ organizationId: orgB.id, repositoryId: repoB.id, eventType: "prediction", quantity: 9, unit: "count", sourceType: "x", sourceId: "b1", occurredAt: "2026-08-01T00:00:00Z" });
    assert.equal(await usage.sumQuantityInRange(orgA.id, "prediction", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"), 5);
    assert.equal(await usage.sumQuantityInRange(orgB.id, "prediction", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z"), 9);
  });

  it("countDistinctActiveRepositories counts each repository once regardless of event count", async () => {
    const db = freshDb();
    const { org, repo } = await seedOrg(db);
    const usage = makeD1UsageStore(makeD1(db));
    for (const sourceId of ["r1", "r2", "r3"]) {
      await usage.recordUsageEventIfNew({ organizationId: org.id, repositoryId: repo.id, eventType: "repository_active", quantity: 1, unit: "count", sourceType: "x", sourceId, occurredAt: "2026-08-01T00:00:00Z" });
    }
    const active = await usage.countDistinctActiveRepositories(org.id, "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(active, 1);
  });
});
