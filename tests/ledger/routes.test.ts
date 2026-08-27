/**
 * Phase 04 (2026-08-26): the ledger as a route, and through the real Worker.
 *
 * The end-to-end case is the one worth having: real reports posted with a real credential, then the
 * month read back as HTML and as JSON, and the same month refused to a member of another organization.
 * A savings report is the single most sensitive thing this product produces about a customer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeReport } from "../ingest/report-fixture.js";
import { getMonthlyLedgerForOrganization, currentMonth } from "../../src/ledger/routes.js";
import { makeD1ObservationStore } from "../../src/ingest/store.js";
import { makeD1IngestTokenStore } from "../../src/ingest/token.js";
import { ingestObservation } from "../../src/ingest/ingest.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import productWorker from "../../src/product/cloudflare/product-worker.js";

const ORIGIN = "https://product.example";
const ctx = { waitUntil() {} };

function buildEnv(db: ReturnType<typeof freshProductDb>) {
  const d1 = makeD1(db);
  return {
    PRODUCT_DB: d1,
    RESEARCH_DB: d1,
    DIFFCI_PRODUCT_ENABLED: "true",
    // A Worker with no pinned agent artifact refuses to issue ingest tokens, because it
    // cannot tell the customer what to do with one. Tests that exercise the onboarding path therefore
    // have to model a properly-configured deployment.
    DIFFCI_AGENT_ARTIFACT: `npm:@diffci/observer@1.4.2#sha512-${"A".repeat(86)}==`,
    DIFFCI_ENVIRONMENT: "development",
    DIFFCI_ALLOW_DEV_HEADER_AUTH: "true",
    DIFFCI_SESSION_TTL_MS: "2592000000",
    DIFFCI_API_ORIGIN: ORIGIN,
    GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
  } as unknown as Record<string, unknown>;
}

async function fixture() {
  const db = freshProductDb(["ingest", "usage"]);
  const d1 = makeD1(db);
  const productStore = makeD1ProductStore(d1);
  const tokenStore = makeD1IngestTokenStore(d1);
  const observationStore = makeD1ObservationStore(d1);

  const owner = await productStore.createUser({ email: "owner@acme.test" });
  const stranger = await productStore.createUser({ email: "stranger@other.test" });
  const organization = await productStore.createOrganization({ name: "Acme", slug: "acme", ownerUserId: owner.id });
  await productStore.createOrganization({ name: "Other", slug: "other", ownerUserId: stranger.id });
  const repository = await productStore.createRepository({ organizationId: organization.id, providerRepositoryId: "111", ownerName: "acme/checkout" });
  await productStore.setRepositoryStatus(repository.id, "active");
  const token = await tokenStore.issue({ organizationId: organization.id, repositoryId: repository.id });

  /** Posts a real report through the real ingest path, so the ledger reads what ingest actually stored. */
  async function post(options: { runId: string; selected: number; total: number; baseline: number | "FULL"; mode?: "SELECTIVE" | "FULL" }) {
    const template = makeReport();
    const result = await ingestObservation(
      {
        authorization: `Bearer ${token.raw}`,
        body: JSON.stringify(
          makeReport({
            ci: { ...template.ci, runId: options.runId },
            result: {
              ...template.result!,
              mode: options.mode ?? "SELECTIVE",
              selectedTests: Array.from({ length: options.selected }, (_, i) => `test/${i}.test.ts`),
              totalTestCount: options.total,
              pathBaseline:
                options.baseline === "FULL"
                  ? { mode: "FULL", selectedTestCount: options.total, matchedRules: ["config/dependency -> full fallback"] }
                  : { mode: "SELECTIVE", selectedTestCount: options.baseline, matchedRules: ["directory scoping"] },
            },
          }),
        ),
      },
      { tokenStore, observationStore, productStore },
    );
    assert.equal(result.ok, true, "fixture ingest should succeed");
  }

  return { db, productStore, observationStore, owner, stranger, organization, repository, post, deps: { productStore, observationStore } };
}

describe("the ledger route", () => {
  it("builds this month from what ingest actually stored", async () => {
    const { deps, owner, organization, repository, post } = await fixture();
    await post({ runId: "1", selected: 2, total: 40, baseline: 18 });
    await post({ runId: "2", selected: 5, total: 40, baseline: 20 });

    const outcome = await getMonthlyLedgerForOrganization(deps, owner.id, organization.id, currentMonth());
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;

    assert.equal(outcome.data.rows.length, 1);
    const row = outcome.data.rows[0]!;
    assert.equal(row.ownerName, "acme/checkout", "the ledger names repositories, and gets the name from the product store");
    assert.equal(row.repositoryId, repository.id);
    assert.equal(row.verdict, "NET_POSITIVE");
    assert.equal(row.netTestsAvoided, 31, "(18-2) + (20-5)");
    assert.equal(row.grossTestsAvoidedVsFullSuite, 73);
    assert.equal(row.countTier, "MEASURED");
    assert.equal(row.timeTier, "UNKNOWN", "no duration observation exists for a client-observed repository");
    assert.equal(outcome.data.totals.billable, false);
  });

  it("refuses a month to somebody who is not a member", async () => {
    const { deps, stranger, organization } = await fixture();
    const outcome = await getMonthlyLedgerForOrganization(deps, stranger.id, organization.id, currentMonth());
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.error, "unauthorized");
  });

  it("refuses a month string it cannot parse", async () => {
    const { deps, owner, organization } = await fixture();
    const outcome = await getMonthlyLedgerForOrganization(deps, owner.id, organization.id, "last-august");
    assert.equal(outcome.ok === false && outcome.error, "not_found");
  });
});

describe("the ledger through the Worker", () => {
  it("serves the month as JSON and as a page, and refuses both across tenants", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const store = makeD1ProductStore(makeD1(db));
    const owner = await store.createUser({ email: "owner@acme.test" });
    const stranger = await store.createUser({ email: "stranger@other.test" });
    const organization = await store.createOrganization({ name: "Acme", slug: "acme", ownerUserId: owner.id });
    await store.createOrganization({ name: "Other", slug: "other", ownerUserId: stranger.id });

    const ownerHeaders = { "X-DiffCI-User-Id": owner.id, "Content-Type": "application/json" };
    const strangerHeaders = { "X-DiffCI-User-Id": stranger.id, "Content-Type": "application/json" };

    const created = await productWorker.fetch(
      new Request(`${ORIGIN}/v1/organizations/${organization.id}/repositories`, {
        method: "POST",
        headers: ownerHeaders,
        body: JSON.stringify({ providerRepositoryId: "111", ownerName: "acme/checkout" }),
      }),
      env as never,
      ctx as never,
    );
    const repositoryId = ((await created.json()) as { repository: { id: string } }).repository.id;

    const issued = await productWorker.fetch(
      new Request(`${ORIGIN}/v1/organizations/${organization.id}/repositories/${repositoryId}/ingest-tokens`, { method: "POST", headers: ownerHeaders, body: "{}" }),
      env as never,
      ctx as never,
    );
    const token = ((await issued.json()) as { token: string }).token;

    const template = makeReport();
    await productWorker.fetch(
      new Request(`${ORIGIN}/v1/ingest/observations`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(
          makeReport({
            repository: { provider: "github", ownerName: "acme/checkout", providerRepositoryId: "111" },
            result: { ...template.result!, totalTestCount: 30, selectedTests: ["test/a.test.ts"], pathBaseline: { mode: "SELECTIVE", selectedTestCount: 12, matchedRules: ["directory scoping"] } },
          }),
        ),
      }),
      env as never,
      ctx as never,
    );

    // JSON
    const asJson = await productWorker.fetch(new Request(`${ORIGIN}/v1/organizations/${organization.id}/ledger`, { headers: ownerHeaders }), env as never, ctx as never);
    assert.equal(asJson.status, 200);
    const ledger = ((await asJson.json()) as { ledger: { totals: { netTestsAvoided: number; billable: boolean; countTier: string; timeTier: string } } }).ledger;
    assert.equal(ledger.totals.netTestsAvoided, 11, "12 the comparator would run, minus the 1 DiffCI would");
    assert.equal(ledger.totals.countTier, "MEASURED");
    assert.equal(ledger.totals.timeTier, "UNKNOWN");
    assert.equal(ledger.totals.billable, false);

    // Page
    const asPage = await productWorker.fetch(new Request(`${ORIGIN}/app/orgs/${organization.id}/ledger`, { headers: ownerHeaders }), env as never, ctx as never);
    assert.equal(asPage.status, 200);
    const body = await asPage.text();
    assert.match(body, /Net savings/);
    assert.match(body, /acme\/checkout/);
    assert.match(body, /Not billable/);
    assert.match(body, /not against running everything/, "the flattering comparator is named and dismissed on the page itself");

    // Across tenants, both ways.
    assert.equal((await productWorker.fetch(new Request(`${ORIGIN}/v1/organizations/${organization.id}/ledger`, { headers: strangerHeaders }), env as never, ctx as never)).status, 403);
    assert.equal((await productWorker.fetch(new Request(`${ORIGIN}/app/orgs/${organization.id}/ledger`, { headers: strangerHeaders }), env as never, ctx as never)).status, 403);
  });
});
