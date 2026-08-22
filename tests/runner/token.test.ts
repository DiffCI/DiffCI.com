import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1RunnerTokenStore, hashRunnerToken, generateRunnerToken } from "../../src/runner/token.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

async function seedOrgAndRunner(db: ReturnType<typeof freshProductDb>) {
  const insertOrg = db.prepare(`INSERT INTO organizations (id, name, slug, current_plan, created_at, updated_at) VALUES ('org-1', 'Acme', 'acme', 'free', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  insertOrg.run();
  db.prepare(`INSERT INTO runners (id, organization_id, provider, status, requested_resource_class, created_at) VALUES ('runner-1', 'org-1', 'cloudflare-containers-async', 'provisioning', 'lite', '2026-01-01T00:00:00Z')`).run();
}

describe("generateRunnerToken/hashRunnerToken", () => {
  it("generates a real 256-bit base64url token, different every call", () => {
    const a = generateRunnerToken();
    const b = generateRunnerToken();
    assert.notEqual(a, b);
    assert.ok(a.length >= 40);
    assert.ok(!/[+/=]/.test(a), "must be base64url, not standard base64");
  });

  it("hashes deterministically - same input always produces the same hash", async () => {
    const h1 = await hashRunnerToken("abc");
    const h2 = await hashRunnerToken("abc");
    assert.equal(h1, h2);
    assert.equal(h1.length, 64); // SHA-256 hex
  });
});

describe("makeD1RunnerTokenStore - real SQLite", () => {
  it("issueToken returns the raw token once; verify() succeeds against it", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const { raw, record } = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    assert.ok(raw.length > 0);
    assert.equal(record.runnerId, "runner-1");
    assert.equal(record.jobId, "job-1");

    const verified = await store.verify(raw);
    assert.equal(verified.ok, true);
    if (verified.ok) assert.equal(verified.record.runnerId, "runner-1");
  });

  it("verify() on a never-issued token returns not_found, never throws", async () => {
    const store = makeD1RunnerTokenStore(makeD1(freshProductDb(["runner"])));
    const result = await store.verify("this-token-was-never-issued");
    assert.deepEqual(result, { ok: false, reason: "not_found" });
  });

  it("verify() on an expired token returns expired", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const { raw } = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: -1000 }); // already expired
    const result = await store.verify(raw);
    assert.deepEqual(result, { ok: false, reason: "expired" });
  });

  it("verify() on a revoked token returns revoked, even if not expired", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const { raw } = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    await store.revoke(raw);
    const result = await store.verify(raw);
    assert.deepEqual(result, { ok: false, reason: "revoked" });
  });

  it("markClaimed succeeds exactly once - a second attempt with the same token fails (Part 28: token replay)", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const { raw } = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    assert.equal(await store.markClaimed(raw), true);
    assert.equal(await store.markClaimed(raw), false, "replay must fail");
  });

  it("markClaimed fails on an expired or revoked token", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const expired = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: -1000 });
    assert.equal(await store.markClaimed(expired.raw), false);

    const revoked = await store.issueToken({ runnerId: "runner-1", jobId: "job-2", organizationId: "org-1", ttlMs: 60_000 });
    await store.revoke(revoked.raw);
    assert.equal(await store.markClaimed(revoked.raw), false);
  });

  it("markResultSubmitted succeeds exactly once - a second submission is a detectable duplicate (Part 28)", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const { raw } = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    assert.equal(await store.markResultSubmitted(raw), true);
    assert.equal(await store.markResultSubmitted(raw), false);
  });

  it("markClaimed and markResultSubmitted are independent gates - claiming does not block a later result, and vice versa is irrelevant to claim", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const { raw } = await store.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    assert.equal(await store.markClaimed(raw), true);
    assert.equal(await store.markResultSubmitted(raw), true, "result submission uses its own independent single-use gate, not blocked by claim");
  });

  it("a token issued for one job cannot be confused with a token for a different job - each has its own hash/record", async () => {
    const db = freshProductDb(["runner"]);
    await seedOrgAndRunner(db);
    const store = makeD1RunnerTokenStore(makeD1(db));
    const a = await store.issueToken({ runnerId: "runner-1", jobId: "job-A", organizationId: "org-1", ttlMs: 60_000 });
    const b = await store.issueToken({ runnerId: "runner-1", jobId: "job-B", organizationId: "org-1", ttlMs: 60_000 });
    assert.notEqual(a.raw, b.raw);
    const verifiedA = await store.verify(a.raw);
    if (verifiedA.ok) assert.equal(verifiedA.record.jobId, "job-A");
  });
});
