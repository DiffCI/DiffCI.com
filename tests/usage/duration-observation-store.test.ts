/**
 * Real-SQLite-backed tests for src/usage/duration-observation-store.ts, applied against the real
 * ci_duration_observations table (src/usage/cloudflare/schema.sql). No shadow_predictions/
 * shadow_ground_truth involved - this table stands entirely alone.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1DurationObservationStore, type D1Binding, type DurationObservation } from "../../src/usage/duration-observation-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
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

function observation(overrides: Partial<DurationObservation> = {}): DurationObservation {
  return {
    logicalDeltaKey: "k1",
    repository: "acme/web",
    headSha: "a".repeat(40),
    workflowRunIds: [123456],
    jobIds: [789012],
    testsTotalFull: 46,
    realJobDurationMs: 92_000,
    secondsPerTest: 2,
    observedAt: "2026-08-23T00:00:00Z",
    ...overrides,
  };
}

describe("DurationObservationStore", () => {
  it("recordIfNew stores a real observation and reports it as newly recorded", async () => {
    const store = makeD1DurationObservationStore(makeD1(freshDb()));
    const wasNew = await store.recordIfNew(observation());
    assert.equal(wasNew, true);
  });

  it("round-trips real workflow run/job provenance (Part A.4) through storage", async () => {
    const store = makeD1DurationObservationStore(makeD1(freshDb()));
    await store.recordIfNew(observation({ workflowRunIds: [111, 222], jobIds: [333] }));
    const rows = await store.listRecent(undefined, 10);
    assert.deepEqual(rows[0]?.workflowRunIds, [111, 222]);
    assert.deepEqual(rows[0]?.jobIds, [333]);
  });

  it("a duplicate logicalDeltaKey is idempotent - recorded once, not double-counted", async () => {
    const db = freshDb();
    const store = makeD1DurationObservationStore(makeD1(db));
    const first = await store.recordIfNew(observation());
    const second = await store.recordIfNew(observation({ secondsPerTest: 999 })); // even with different data, same key never overwrites
    assert.equal(first, true);
    assert.equal(second, false);
    const rows = await store.listRecent(undefined, 10);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.secondsPerTest, 2, "the original value is preserved, never silently overwritten by a later duplicate");
  });

  it("listRecent scopes to one repository when given, and returns newest-first", async () => {
    const store = makeD1DurationObservationStore(makeD1(freshDb()));
    await store.recordIfNew(observation({ logicalDeltaKey: "k1", repository: "acme/web", observedAt: "2026-08-20T00:00:00Z" }));
    await store.recordIfNew(observation({ logicalDeltaKey: "k2", repository: "acme/web", observedAt: "2026-08-22T00:00:00Z" }));
    await store.recordIfNew(observation({ logicalDeltaKey: "k3", repository: "acme/other", observedAt: "2026-08-23T00:00:00Z" }));

    const webOnly = await store.listRecent("acme/web", 10);
    assert.equal(webOnly.length, 2);
    assert.equal(webOnly[0]?.logicalDeltaKey, "k2", "newest first");

    const all = await store.listRecent(undefined, 10);
    assert.equal(all.length, 3);
  });

  it("listRecent respects the limit", async () => {
    const store = makeD1DurationObservationStore(makeD1(freshDb()));
    await store.recordIfNew(observation({ logicalDeltaKey: "k1" }));
    await store.recordIfNew(observation({ logicalDeltaKey: "k2" }));
    const limited = await store.listRecent(undefined, 1);
    assert.equal(limited.length, 1);
  });
});
