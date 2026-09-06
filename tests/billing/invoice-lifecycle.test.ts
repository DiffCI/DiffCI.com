/**
 * Phase 05 (2026-08-26): an invoice's life, and the whole loop through the Worker.
 *
 * "One invoice, paid, reconciled line by line" is the phase's criterion, and each of those four things
 * is a separate way to be wrong: invoicing a month twice, changing an invoice someone has already seen,
 * recording a payment against something that was never issued, and a reconciliation that agrees with
 * whatever it is shown.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeReport } from "../ingest/report-fixture.js";
import { makeD1InvoiceStore } from "../../src/billing/invoice-store.js";
import { buildInvoiceFromLedger } from "../../src/billing/metered.js";
import { buildMonthlyLedger } from "../../src/ledger/ledger.js";
import { currentMonth } from "../../src/ledger/routes.js";
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
    GITHUB_OAUTH_CLIENT_ID: "Ov23liTESTCLIENTID00",
    GITHUB_OAUTH_CLIENT_SECRET: "0123456789abcdef0123456789abcdef01234567",
  } as unknown as Record<string, unknown>;
}

async function call(env: Record<string, unknown>, method: string, path: string, options: { headers?: Record<string, string>; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await productWorker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
    env as never,
    ctx as never,
  );
  const text = await response.text();
  return { status: response.status, body: text.startsWith("{") ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
}

describe("the invoice state machine", () => {
  async function fixture() {
    const db = freshProductDb(["ingest", "usage", "billing"]);
    const d1 = makeD1(db);
    const productStore = makeD1ProductStore(d1);
    const invoiceStore = makeD1InvoiceStore(d1);
    const user = await productStore.createUser({ email: "owner@acme.test" });
    const organization = await productStore.createOrganization({ name: "Acme", slug: "acme", ownerUserId: user.id });
    const repository = await productStore.createRepository({ organizationId: organization.id, providerRepositoryId: "111", ownerName: "acme/checkout" });

    const draft = await buildInvoiceFromLedger(
      buildMonthlyLedger({
        organizationId: organization.id,
        month: "2026-08",
        repositoryNames: new Map([[repository.id, repository.ownerName]]),
        observations: [
          {
            id: "obs-1",
            organizationId: organization.id,
            repositoryId: repository.id,
            idempotencyKey: "k",
            schemaVersion: "diffci.observation.v1",
            status: "OBSERVED",
            stage: "complete",
            mode: "SELECTIVE",
            selectedTestCount: 2,
            totalTestCount: 40,
            baselineMode: "SELECTIVE",
            baselineSelectedTestCount: 30,
            blindSpot: false,
            worktreeUnchanged: true,
            blockingWorkflowFindings: 0,
            pathsRedacted: false,
            identityVerified: true,
            producedAt: "2026-08-10T10:00:00.000Z",
            receivedAt: "2026-08-10T10:00:01.000Z",
            reportBytes: 900,
            report: {},
          },
        ],
      }),
    );
    return { db, productStore, invoiceStore, user, organization, repository, draft };
  }

  it("invoices a month once, and returns the same invoice on every later attempt", async () => {
    const { invoiceStore, draft } = await fixture();

    const first = await invoiceStore.createDraftIfAbsent(draft);
    assert.equal(first.created, true);
    assert.equal(first.invoice.lines.length, 1);
    assert.equal(first.invoice.netTestsAvoided, 28);

    const second = await invoiceStore.createDraftIfAbsent({ ...draft, totalUsdCents: 999_999 });
    assert.equal(second.created, false);
    assert.equal(second.invoice.id, first.invoice.id);
    assert.equal(second.invoice.totalUsdCents, first.invoice.totalUsdCents, "a second attempt must not re-price a month");
  });

  it("goes draft -> issued -> paid, and refuses every step out of order", async () => {
    const { invoiceStore, organization, draft } = await fixture();
    const { invoice } = await invoiceStore.createDraftIfAbsent(draft);

    assert.equal(await invoiceStore.markPaid(organization.id, invoice.id, "ref"), false, "a draft cannot be paid");
    assert.equal(await invoiceStore.issue(organization.id, invoice.id), true);
    assert.equal(await invoiceStore.issue(organization.id, invoice.id), false, "issuing twice is not two issues");
    assert.equal(await invoiceStore.markPaid(organization.id, invoice.id, "bank-ref-9"), true);
    assert.equal(await invoiceStore.markPaid(organization.id, invoice.id, "bank-ref-9"), false, "paying twice is not two payments");

    const paid = await invoiceStore.getForPeriod(organization.id, "2026-08");
    assert.equal(paid?.status, "paid");
    assert.equal(paid?.paymentReference, "bank-ref-9");
    assert.ok(paid?.issuedAt && paid.paidAt);
  });

  it("refuses to void a paid invoice", async () => {
    const { invoiceStore, organization, draft } = await fixture();
    const { invoice } = await invoiceStore.createDraftIfAbsent(draft);
    await invoiceStore.issue(organization.id, invoice.id);
    await invoiceStore.markPaid(organization.id, invoice.id, "ref");

    assert.equal(await invoiceStore.voidInvoice(organization.id, invoice.id), false);
    assert.equal((await invoiceStore.getForPeriod(organization.id, "2026-08"))?.status, "paid");
  });

  it("is scoped to its organization at every step", async () => {
    const { productStore, invoiceStore, organization, draft } = await fixture();
    const outsider = await productStore.createUser({ email: "outsider@other.test" });
    const other = await productStore.createOrganization({ name: "Other", slug: "other", ownerUserId: outsider.id });
    const { invoice } = await invoiceStore.createDraftIfAbsent(draft);

    assert.equal(await invoiceStore.getForOrganization(other.id, invoice.id), null);
    assert.equal(await invoiceStore.getForPeriod(other.id, "2026-08"), null);
    assert.deepEqual(await invoiceStore.listForOrganization(other.id), []);
    assert.equal(await invoiceStore.issue(other.id, invoice.id), false);
    assert.equal(await invoiceStore.markPaid(other.id, invoice.id, "ref"), false);
    assert.equal(await invoiceStore.voidInvoice(other.id, invoice.id), false);
    assert.equal((await invoiceStore.getForPeriod(organization.id, "2026-08"))?.status, "draft", "and none of it changed the real one");
  });
});

describe("the whole loop through the Worker", () => {
  it("observes, prices, issues, records payment, and reconciles line by line", async () => {
    const db = freshProductDb(["ingest", "usage", "billing"]);
    const env = buildEnv(db);
    const store = makeD1ProductStore(makeD1(db));
    const owner = await store.createUser({ email: "owner@acme.test" });
    const organization = await store.createOrganization({ name: "Acme", slug: "acme", ownerUserId: owner.id });
    const headers = { "X-DiffCI-User-Id": owner.id };

    const repository = (await call(env, "POST", `/v1/organizations/${organization.id}/repositories`, { headers, body: { providerRepositoryId: "111", ownerName: "acme/checkout" } })).body
      .repository as { id: string };
    const token = (await call(env, "POST", `/v1/organizations/${organization.id}/repositories/${repository.id}/ingest-tokens`, { headers, body: {} })).body.token as string;

    const template = makeReport();
    await call(env, "POST", "/v1/ingest/observations", {
      token,
      body: makeReport({
        repository: { provider: "github", ownerName: "acme/checkout", providerRepositoryId: "111" },
        result: { ...template.result!, totalTestCount: 40, selectedTests: ["test/a.test.ts"], pathBaseline: { mode: "SELECTIVE", selectedTestCount: 25, selectedTests: Array.from({ length: 25 }, (_u, i) => `baseline/t${i}.test.ts`), matchedRules: ["directory scoping"] } },
      }),
    });

    // Prepare - idempotent.
    const prepared = await call(env, "POST", `/v1/organizations/${organization.id}/invoices`, { headers, body: {} });
    assert.equal(prepared.status, 201);
    const invoice = prepared.body.invoice as { id: string; totalUsdCents: number; netTestsAvoided: number; status: string; chargeable: boolean; notChargeableReason: string };
    assert.equal(invoice.netTestsAvoided, 24, "25 the comparator would have run, minus the 1 DiffCI would");
    assert.equal(invoice.totalUsdCents, 0, "and it charges nothing, because the money basis is not measured");
    assert.match(invoice.notChargeableReason, /never executed/);

    const again = await call(env, "POST", `/v1/organizations/${organization.id}/invoices`, { headers, body: {} });
    assert.equal(again.status, 200);
    assert.equal((again.body.invoice as { id: string }).id, invoice.id, "a month is invoiced once");

    // Issue, then pay.
    assert.equal((await call(env, "POST", `/v1/organizations/${organization.id}/invoices/${invoice.id}/issue`, { headers })).status, 200);
    const unpaid = await call(env, "POST", `/v1/organizations/${organization.id}/invoices/${invoice.id}/paid`, { headers, body: {} });
    assert.equal(unpaid.status, 400, "a payment must carry something that proves it");

    const paid = await call(env, "POST", `/v1/organizations/${organization.id}/invoices/${invoice.id}/paid`, { headers, body: { reference: "bank transfer 2026-09-01" } });
    assert.equal(paid.status, 200);

    // Reconcile, line by line.
    const reconciled = await call(env, "GET", `/v1/organizations/${organization.id}/invoices/${invoice.id}/reconcile`, { headers });
    assert.equal(reconciled.status, 200);
    const reconciliation = reconciled.body.reconciliation as { reconciled: boolean; ledgerChanged: boolean; differences: unknown[] };
    assert.equal(reconciliation.reconciled, true);
    assert.equal(reconciliation.ledgerChanged, false);
    assert.deepEqual(reconciliation.differences, []);

    // And the console renders it, zero and all.
    const page = await call(env, "GET", `/app/orgs/${organization.id}/invoices`, { headers });
    assert.equal(page.status, 200);
    assert.match(page.text, /2026-\d\d — \$0\.00/);
    assert.match(page.text, /Charges nothing/);
    assert.match(page.text, /acme\/checkout/);
    assert.match(page.text, /24/);

    // The audit trail records both financial acts.
    const events = await store.listAuditEvents(organization.id);
    assert.ok(events.some((event) => event.action === "invoice.issued"));
    assert.ok(events.some((event) => event.action === "invoice.paid"));
  });

  it("shows the bill to any member but lets only an owner or admin issue or record payment", async () => {
    const db = freshProductDb(["ingest", "usage", "billing"]);
    const env = buildEnv(db);
    const store = makeD1ProductStore(makeD1(db));
    const owner = await store.createUser({ email: "owner@acme.test" });
    const member = await store.createUser({ email: "member@acme.test" });
    const organization = await store.createOrganization({ name: "Acme", slug: "acme", ownerUserId: owner.id });
    await store.addMember(organization.id, member.id, "member");

    const ownerHeaders = { "X-DiffCI-User-Id": owner.id };
    const memberHeaders = { "X-DiffCI-User-Id": member.id };

    const invoice = (await call(env, "POST", `/v1/organizations/${organization.id}/invoices`, { headers: ownerHeaders, body: { month: currentMonth() } })).body.invoice as { id: string };

    // A member can read the bill and check it - that is the point of it existing.
    assert.equal((await call(env, "GET", `/v1/organizations/${organization.id}/invoices`, { headers: memberHeaders })).status, 200);
    assert.equal((await call(env, "GET", `/v1/organizations/${organization.id}/invoices/${invoice.id}/reconcile`, { headers: memberHeaders })).status, 200);

    // But cannot issue it or declare it paid.
    assert.equal((await call(env, "POST", `/v1/organizations/${organization.id}/invoices/${invoice.id}/issue`, { headers: memberHeaders })).status, 403);
    assert.equal((await call(env, "POST", `/v1/organizations/${organization.id}/invoices/${invoice.id}/paid`, { headers: memberHeaders, body: { reference: "x" } })).status, 403);

    // And the console does not offer them the buttons.
    const memberPage = await call(env, "GET", `/app/orgs/${organization.id}/invoices`, { headers: memberHeaders });
    assert.equal(/data-url="[^"]*\/issue"/.test(memberPage.text), false);
    const ownerPage = await call(env, "GET", `/app/orgs/${organization.id}/invoices`, { headers: ownerHeaders });
    assert.ok(/data-url="[^"]*\/issue"/.test(ownerPage.text));
  });

  it("refuses another organization's invoices entirely", async () => {
    const db = freshProductDb(["ingest", "usage", "billing"]);
    const env = buildEnv(db);
    const store = makeD1ProductStore(makeD1(db));
    const owner = await store.createUser({ email: "owner@acme.test" });
    const stranger = await store.createUser({ email: "stranger@other.test" });
    const organization = await store.createOrganization({ name: "Acme", slug: "acme", ownerUserId: owner.id });
    await store.createOrganization({ name: "Other", slug: "other", ownerUserId: stranger.id });
    const strangerHeaders = { "X-DiffCI-User-Id": stranger.id };

    const invoice = (await call(env, "POST", `/v1/organizations/${organization.id}/invoices`, { headers: { "X-DiffCI-User-Id": owner.id }, body: {} })).body.invoice as { id: string };

    assert.equal((await call(env, "GET", `/v1/organizations/${organization.id}/invoices`, { headers: strangerHeaders })).status, 403);
    assert.equal((await call(env, "GET", `/v1/organizations/${organization.id}/invoices/${invoice.id}`, { headers: strangerHeaders })).status, 403);
    assert.equal((await call(env, "POST", `/v1/organizations/${organization.id}/invoices/${invoice.id}/issue`, { headers: strangerHeaders })).status, 403);
    assert.equal((await call(env, "GET", `/app/orgs/${organization.id}/invoices`, { headers: strangerHeaders })).status, 403);
  });
});
