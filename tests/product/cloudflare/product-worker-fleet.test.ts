import assert from "node:assert/strict";
import { it } from "node:test";
import worker from "../../../src/product/cloudflare/product-worker.js";
import { freshProductDb, makeD1 } from "../../helpers/product-db.js";
import { makeD1ProductStore } from "../../../src/product/store.js";
import { makeD1SessionStore } from "../../../src/auth/sessions.js";
import { generateCsrfToken } from "../../../src/auth/csrf.js";
import { DEFAULT_EVIDENCE_POLICY } from "../../../src/product/evidence-policy.js";

it("real HTTP policy flow requires a session, CSRF and owner/admin role; fleet remains tenant scoped", async () => {
  const db = freshProductDb(["auth", "ingest", "usage", "runner", "execution-queue"]);
  const d1 = makeD1(db);
  const product = makeD1ProductStore(d1);
  const user = await product.createUser({ email: "owner@example.test" });
  const org = await product.createOrganization({ name: "Owner", slug: "owner", ownerUserId: user.id });
  const outsider = await product.createUser({ email: "other@example.test" });
  const other = await product.createOrganization({ name: "Other", slug: "other", ownerUserId: outsider.id });
  const { session, rawToken } = await makeD1SessionStore(d1).createSession(user.id, 60000);
  const env = { PRODUCT_DB: d1, RESEARCH_DB: d1, DIFFCI_PRODUCT_ENABLED: "true", DIFFCI_ENVIRONMENT: "production",
    DIFFCI_ALLOW_DEV_HEADER_AUTH: "false", CSRF_SECRET: "fleet-test-secret" };
  const csrf = await generateCsrfToken(env.CSRF_SECRET, session.sessionId);
  const path = `/v1/organizations/${org.id}/evidence-policy`;
  const ctx = { waitUntil() {} };
  async function call(method: string, route: string, options: { authenticated?: boolean; csrf?: boolean; body?: unknown; secret?: boolean } = {}) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.authenticated !== false) headers.Cookie = `diffci_session=${rawToken}`;
    if (options.csrf) { headers.Cookie += `; diffci_csrf=${csrf}`; headers["X-CSRF-Token"] = csrf; }
    return worker.fetch(new Request(`https://product.example${route}`, { method, headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
      { ...env, CSRF_SECRET: options.secret === false ? undefined : env.CSRF_SECRET } as never, ctx);
  }
  assert.equal((await call("GET", path, { authenticated: false })).status, 401);
  assert.equal((await call("GET", `/v1/organizations/${other.id}/fleet`)).status, 403);
  const initial = await call("GET", path);
  assert.equal(initial.status, 200);
  assert.equal(initial.headers.get("Cache-Control"), "no-store");
  const initialBody = await initial.json() as { current: { revision: number } };
  assert.equal(initialBody.current.revision, 0);
  const body = { expectedRevision: 0, policy: { ...DEFAULT_EVIDENCE_POLICY, windowDays: 14 } };
  assert.equal((await call("PUT", path, { body })).status, 403);
  assert.equal((await call("PUT", path, { body, secret: false })).status, 503);
  assert.equal((await call("PUT", path, { body, csrf: true })).status, 200);
  assert.equal((await call("PUT", path, { body, csrf: true })).status, 409);
  assert.equal((await call("PUT", path, { body: { expectedRevision: 1, policy: {} }, csrf: true })).status, 400);
  const fleet = await call("GET", `/v1/organizations/${org.id}/fleet`);
  assert.equal(fleet.status, 200);
  const fleetBody = await fleet.json() as { fleet: { policy: { revision: number }; totals: { repositories: number } } };
  assert.equal(fleetBody.fleet.policy.revision, 1);
  assert.equal(fleetBody.fleet.totals.repositories, 0);
  // A missing research schema becomes unavailable, never empty or a policy pass.
  await product.createRepository({ organizationId: org.id, providerRepositoryId: "42", ownerName: "owner/repo" });
  const degraded = await call("GET", `/v1/organizations/${org.id}/fleet`);
  const degradedBody = await degraded.json() as { fleet: { unavailable: string[] } };
  assert.deepEqual(degradedBody.fleet.unavailable, ["owner/repo"]);
  await product.addMember(org.id, user.id, "member");
  assert.equal((await call("PUT", path, { body: { ...body, expectedRevision: 1 }, csrf: true })).status, 403);
  db.close();
});
