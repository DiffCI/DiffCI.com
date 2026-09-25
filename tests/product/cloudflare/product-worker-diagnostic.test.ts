import assert from "node:assert/strict";
import { it } from "node:test";
import worker from "../../../src/product/cloudflare/product-worker.js";
import { freshProductDb, makeD1 } from "../../helpers/product-db.js";
import { makeD1ProductStore } from "../../../src/product/store.js";
import { makeD1SessionStore } from "../../../src/auth/sessions.js";

it("serves a consent-based diagnostic page and refuses unconfigured admission", async () => {
  const db = freshProductDb(["auth", "ingest", "usage", "runner", "execution-queue"]);
  const env = { PRODUCT_DB: makeD1(db), RESEARCH_DB: makeD1(db), DIFFCI_PRODUCT_ENABLED: "true", DIFFCI_ENVIRONMENT: "production" };
  const ctx = { waitUntil() {} };
  const page = await worker.fetch(new Request("https://test/analyzer"), env as never, ctx);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("Content-Security-Policy")!, /frame-ancestors 'none'/);
  assert.match(await page.text(), /consent/);
  assert.equal((await worker.fetch(new Request("https://test/v1/public-analyzer/jobs", { method: "POST", body: "{}" }), env as never, ctx)).status, 503);
  db.close();
});

it("session mutations fail closed without a CSRF secret", async () => {
  const db = freshProductDb(["auth", "ingest", "usage", "runner", "execution-queue"]);
  const d1 = makeD1(db);
  const product = makeD1ProductStore(d1);
  const user = await product.createUser({ email: "csrf@example.test" });
  const org = await product.createOrganization({ name: "Csrf", slug: "csrf", ownerUserId: user.id });
  const { rawToken } = await makeD1SessionStore(d1).createSession(user.id, 60000);
  const response = await worker.fetch(new Request(`https://test/v1/organizations/${org.id}/runner-jobs/synthetic`, {
    method: "POST", headers: { Cookie: `diffci_session=${rawToken}` },
  }), { PRODUCT_DB: d1, RESEARCH_DB: d1, DIFFCI_PRODUCT_ENABLED: "true", DIFFCI_ENVIRONMENT: "production" } as never, { waitUntil() {} });
  assert.equal(response.status, 403);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM execution_queue_items").get()!.n, 0);
  db.close();
});
