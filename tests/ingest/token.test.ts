/**
 * Phase 03 (2026-08-26): ingest credentials.
 *
 * The property that matters most is not in any single assertion below: a token names one repository,
 * and nothing about a request can change which one. Everything here is about the ways that could stop
 * being true - a revoked token still working, an expired one still working, a listing that returns
 * another organization's credentials, or the raw value being recoverable from storage.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { INGEST_TOKEN_PREFIX, hashIngestToken, makeD1IngestTokenStore } from "../../src/ingest/token.js";
import { makeD1ProductStore } from "../../src/product/store.js";

async function fixture() {
  const db = freshProductDb(["ingest"]);
  const d1 = makeD1(db);
  const products = makeD1ProductStore(d1);
  const tokens = makeD1IngestTokenStore(d1);

  const user = await products.createUser({ email: "owner@example.com" });
  const orgA = await products.createOrganization({ name: "Org A", slug: "org-a", ownerUserId: user.id });
  const orgB = await products.createOrganization({ name: "Org B", slug: "org-b", ownerUserId: user.id });
  const repoA = await products.createRepository({ organizationId: orgA.id, providerRepositoryId: "111", ownerName: "orga/app" });
  const repoB = await products.createRepository({ organizationId: orgB.id, providerRepositoryId: "222", ownerName: "orgb/app" });
  return { db, d1, products, tokens, user, orgA, orgB, repoA, repoB };
}

describe("ingest tokens", () => {
  it("issues a recognisable token that verifies back to exactly one repository", async () => {
    const { tokens, orgA, repoA } = await fixture();
    const { raw, record } = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id, name: "orga/app CI" });

    assert.ok(raw.startsWith(INGEST_TOKEN_PREFIX), "token should carry its own prefix so it is recognisable when leaked");
    assert.ok(raw.length > 40);
    assert.equal(record.tokenPrefix, raw.slice(0, INGEST_TOKEN_PREFIX.length + 8));

    const verified = await tokens.verify(raw);
    assert.equal(verified.ok, true);
    if (!verified.ok) return;
    assert.equal(verified.record.repositoryId, repoA.id);
    assert.equal(verified.record.organizationId, orgA.id);
  });

  it("never stores the raw token", async () => {
    const { db, tokens, orgA, repoA } = await fixture();
    const { raw } = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id });
    const rows = db.prepare("SELECT * FROM ingest_tokens").all() as Array<Record<string, unknown>>;
    const serialised = JSON.stringify(rows);
    assert.equal(serialised.includes(raw), false, "the raw token must not be recoverable from storage");
    assert.ok(serialised.includes(await hashIngestToken(raw)), "the hash is what is stored");
  });

  it("rejects a value that is not shaped like one of ours before it becomes a lookup", async () => {
    const { tokens } = await fixture();
    for (const candidate of ["", "not-a-token", "Bearer dci_x", "ghp_0123456789"]) {
      const result = await tokens.verify(candidate);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.reason, "malformed", `expected ${candidate} to be malformed`);
    }
  });

  it("distinguishes unknown, revoked and expired", async () => {
    const { tokens, orgA, repoA } = await fixture();

    const unknown = await tokens.verify(`${INGEST_TOKEN_PREFIX}${"a".repeat(43)}`);
    assert.equal(unknown.ok === false && unknown.reason, "not_found");

    const revoked = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id });
    assert.equal(await tokens.revoke(orgA.id, revoked.record.id), true);
    const afterRevoke = await tokens.verify(revoked.raw);
    assert.equal(afterRevoke.ok === false && afterRevoke.reason, "revoked");

    const expired = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id, ttlMs: -1000 });
    const afterExpiry = await tokens.verify(expired.raw);
    assert.equal(afterExpiry.ok === false && afterExpiry.reason, "expired");
  });

  it("does not expire by default - a credential dying mid-window looks like DiffCI breaking", async () => {
    const { tokens, orgA, repoA } = await fixture();
    const { raw, record } = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id });
    assert.equal(record.expiresAt, undefined);
    assert.equal((await tokens.verify(raw)).ok, true);
  });

  it("revoking is organization-scoped: org B cannot revoke org A's token", async () => {
    const { tokens, orgA, orgB, repoA } = await fixture();
    const { raw, record } = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id });

    assert.equal(await tokens.revoke(orgB.id, record.id), false, "a foreign organization must not be able to revoke");
    assert.equal((await tokens.verify(raw)).ok, true, "and the token must still work afterwards");

    assert.equal(await tokens.revoke(orgA.id, record.id), true);
    assert.equal(await tokens.revoke(orgA.id, record.id), false, "revoking twice is not a second revocation");
  });

  it("listing never crosses organizations", async () => {
    const { tokens, orgA, orgB, repoA, repoB } = await fixture();
    await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id, name: "a" });
    await tokens.issue({ organizationId: orgB.id, repositoryId: repoB.id, name: "b" });

    const listA = await tokens.listForOrganization(orgA.id);
    assert.equal(listA.length, 1);
    assert.equal(listA[0]!.repositoryId, repoA.id);

    // Org A asking for org B's repository by id gets nothing, not org B's credential.
    assert.deepEqual(await tokens.listForRepository(orgA.id, repoB.id), []);
  });

  it("records use only when told to, so a rejected report never makes a token look live", async () => {
    const { tokens, orgA, repoA } = await fixture();
    const { raw, record } = await tokens.issue({ organizationId: orgA.id, repositoryId: repoA.id });

    await tokens.verify(raw);
    let stored = (await tokens.listForOrganization(orgA.id))[0]!;
    assert.equal(stored.lastUsedAt, undefined, "verification alone is not use");

    await tokens.markUsed(record.id);
    stored = (await tokens.listForOrganization(orgA.id))[0]!;
    assert.ok(stored.lastUsedAt, "an accepted ingest stamps last_used_at");
  });
});
