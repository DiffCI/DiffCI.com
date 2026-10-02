import { strict as assert } from "node:assert";
import { test } from "node:test";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1OAuthStore } from "../../src/auth/oauth-store.js";
import { reconnectRepository } from "../../src/install/reconnect.js";

async function fixture() {
  const db = freshProductDb(["auth", "ingest"]);
  const productStore = makeD1ProductStore(makeD1(db));
  const oauthStore = makeD1OAuthStore(makeD1(db));
  const user = await productStore.createUser({ email: "owner@example.test" });
  await oauthStore.linkProviderIdentity(user.id, "github", "123", "owner");
  const org = await productStore.createOrganization({ name: "Org", slug: "org", ownerUserId: user.id });
  const replies = [
    { id: 77, suspended_at: null }, { token: "test-token", expires_at: "2099-01-01" },
    { permission: "admin", user: { id: 123 } },
    { id: 99, full_name: "acme/repo", default_branch: "trunk", private: true },
  ];
  const calls: string[] = [];
  const deps = { productStore, oauthStore, credentials: { appId: "1", privateKeyPkcs8Pem: "unused" },
    appJwt: async () => "test-jwt", fetchFn: (async (url: string | URL | Request) => {
      calls.push(String(url));
      const body = replies[calls.length - 1];
      return Response.json(body ?? {}, { status: body ? 200 : 500 });
    }) as typeof fetch };
  const input = { userId: user.id, organizationId: org.id, repository: "acme/repo" };
  return { db, deps, input, replies, calls };
}

test("reconnect verifies installation and immutable admin identity, connects only the named repository, and is idempotent", async () => {
  const f = await fixture();
  assert.equal((await reconnectRepository(f.deps, f.input)).ok, true);
  assert.ok(f.calls[0]!.endsWith("/repos/acme/repo/installation"));
  assert.ok(f.calls[2]!.endsWith("/collaborators/owner/permission"));
  const rows = await f.deps.productStore.listRepositories(f.input.organizationId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.providerRepositoryId, "99");
  assert.equal(rows[0]!.installationId, "77");
  assert.equal(rows[0]!.defaultBranch, "trunk");
  f.calls.length = 0;
  assert.equal((await reconnectRepository(f.deps, f.input)).ok, true);
  assert.equal((await f.deps.productStore.listRepositories(f.input.organizationId)).length, 1);
  f.db.close();
});

test("nonmembers and invalid repository names cannot trigger GitHub calls", async () => {
  const f = await fixture();
  assert.equal((await reconnectRepository(f.deps, { ...f.input, userId: "stranger" })).ok, false);
  for (const repository of ["../repo", "owner/repo/extra", "https://github.com/acme/repo", "owner/repo?token=x"])
    assert.equal((await reconnectRepository(f.deps, { ...f.input, repository })).ok, false);
  assert.equal(f.calls.length, 0);
  f.db.close();
});

test("read/write permission, recycled login, suspended installation and identity mismatch all fail closed", async () => {
  for (const change of [
    (r: any[]) => { r[2].permission = "read"; },
    (r: any[]) => { r[2].permission = "write"; },
    (r: any[]) => { r[2].user.id = 456; },
    (r: any[]) => { r[0].suspended_at = "2026-01-01"; },
    (r: any[]) => { r[3].full_name = "other/repo"; },
    (r: any[]) => { r.length = 2; },
  ]) {
    const f = await fixture(); change(f.replies);
    assert.equal((await reconnectRepository(f.deps, f.input)).ok, false);
    assert.equal((await f.deps.productStore.listRepositories(f.input.organizationId)).length, 0);
    f.db.close();
  }
});

test("reconnecting cannot move another tenant's repository", async () => {
  const f = await fixture();
  const other = await f.deps.productStore.createOrganization({ name: "Other", slug: "other", ownerUserId: f.input.userId });
  await f.deps.productStore.createRepository({ organizationId: other.id, providerRepositoryId: "99", ownerName: "acme/repo", defaultBranch: "main", installationId: "77" });
  assert.equal((await reconnectRepository(f.deps, f.input)).ok, false);
  assert.equal((await f.deps.productStore.getRepositoryByProviderId("99"))!.organizationId, other.id);
  f.db.close();
});
