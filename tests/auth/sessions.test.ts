/**
 * Real-SQLite-backed tests for src/auth/sessions.ts, same idiom as tests/product/store.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ProductStore, type D1Binding } from "../../src/product/store.js";
import { generateSessionToken, hashSessionToken, makeD1SessionStore } from "../../src/auth/sessions.js";

const HERE = dirname(fileURLToPath(import.meta.url));

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(join(HERE, "../../src/product/cloudflare/schema.sql"), "utf8"));
  db.exec(readFileSync(join(HERE, "../../src/auth/cloudflare/schema.sql"), "utf8"));
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

describe("hashSessionToken / generateSessionToken", () => {
  it("hashing is deterministic and distinct tokens hash differently", async () => {
    const t1 = generateSessionToken();
    const t2 = generateSessionToken();
    assert.notEqual(t1, t2);
    assert.equal(await hashSessionToken(t1), await hashSessionToken(t1));
    assert.notEqual(await hashSessionToken(t1), await hashSessionToken(t2));
  });
});

describe("SessionStore - Part 4 (never store raw tokens) / Part 23 (expired/revoked rejected)", () => {
  it("createSession never persists the raw token - only its hash is queryable", async () => {
    const db = freshDb();
    const user = await makeD1ProductStore(makeD1(db)).createUser({ email: "a@example.com" });
    const store = makeD1SessionStore(makeD1(db));
    const { session, rawToken } = await store.createSession(user.id, 60_000);
    assert.notEqual(session.hashedToken, rawToken, "the persisted hash must never equal the raw token");
    const row = db.prepare("SELECT hashed_token FROM sessions WHERE session_id = ?").get(session.sessionId) as { hashed_token: string };
    assert.notEqual(row.hashed_token, rawToken);
  });

  it("getValidSessionByRawToken resolves a freshly created session", async () => {
    const db = freshDb();
    const user = await makeD1ProductStore(makeD1(db)).createUser({ email: "b@example.com" });
    const store = makeD1SessionStore(makeD1(db));
    const { rawToken } = await store.createSession(user.id, 60_000);
    const resolved = await store.getValidSessionByRawToken(rawToken);
    assert.equal(resolved?.userId, user.id);
  });

  it("an unknown token resolves to null", async () => {
    const store = makeD1SessionStore(makeD1(freshDb()));
    assert.equal(await store.getValidSessionByRawToken("never-issued-token"), null);
  });

  it("an expired session is rejected", async () => {
    const db = freshDb();
    const user = await makeD1ProductStore(makeD1(db)).createUser({ email: "c@example.com" });
    const store = makeD1SessionStore(makeD1(db));
    const { rawToken } = await store.createSession(user.id, -1); // already expired
    assert.equal(await store.getValidSessionByRawToken(rawToken), null);
  });

  it("a revoked session is rejected even before its natural expiry", async () => {
    const db = freshDb();
    const user = await makeD1ProductStore(makeD1(db)).createUser({ email: "d@example.com" });
    const store = makeD1SessionStore(makeD1(db));
    const { session, rawToken } = await store.createSession(user.id, 60_000);
    await store.revokeSession(session.sessionId);
    assert.equal(await store.getValidSessionByRawToken(rawToken), null);
  });

  it("revoking twice is safe (idempotent, no error)", async () => {
    const db = freshDb();
    const user = await makeD1ProductStore(makeD1(db)).createUser({ email: "e@example.com" });
    const store = makeD1SessionStore(makeD1(db));
    const { session } = await store.createSession(user.id, 60_000);
    await store.revokeSession(session.sessionId);
    await assert.doesNotReject(() => store.revokeSession(session.sessionId));
  });
});
