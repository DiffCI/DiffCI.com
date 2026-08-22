/**
 * Mocks fetch (Part 20: "Mock external Lemon Squeezy calls. Do not require real billing transactions in
 * CI") - never hits the real Lemon Squeezy API.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createLemonSqueezyProvider } from "../../src/billing/lemonsqueezy.js";
import type { LemonSqueezyConfig } from "../../src/billing/config.js";

const CONFIG: LemonSqueezyConfig = { apiKey: "test-key", webhookSigningSecret: "secret", storeId: "store1", variantIdsByPlan: { developer: "v1" } };

function fakeFetch(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fn = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const key = `${init?.method ?? "GET"} ${String(url)}`;
    const match = Object.entries(responses).find(([k]) => key.includes(k));
    if (!match) throw new Error(`Unmocked request: ${key}`);
    const [, res] = match;
    return new Response(JSON.stringify(res.body), { status: res.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  (fn as unknown as { calls: typeof calls }).calls = calls;
  return fn;
}

describe("LemonSqueezyProvider.createCheckout - Part 9 (never trust client-supplied variant id)", () => {
  it("sends the server-resolved variant id and organization_id in custom_data, returns the checkout URL", async () => {
    const fetchMock = fakeFetch({
      "POST https://api.lemonsqueezy.com/v1/checkouts": { status: 201, body: { data: { id: "co_1", type: "checkouts", attributes: { url: "https://acme.lemonsqueezy.com/checkout/co_1" } } } },
    });
    const provider = createLemonSqueezyProvider(CONFIG, fetchMock);
    const result = await provider.createCheckout({ organizationId: "org_1", planId: "developer", customerEmail: "a@example.com" }, "v1");
    assert.equal(result.checkoutUrl, "https://acme.lemonsqueezy.com/checkout/co_1");
    assert.equal(result.provider, "lemonsqueezy");

    const calls = (fetchMock as unknown as { calls: Array<{ init?: RequestInit }> }).calls;
    const body = JSON.parse(String(calls[0]?.init?.body));
    assert.equal(body.data.relationships.variant.data.id, "v1");
    assert.equal(body.data.attributes.checkout_data.custom.organization_id, "org_1");
  });

  it("surfaces a clear error when the API responds with a non-2xx status", async () => {
    const fetchMock = fakeFetch({ "POST https://api.lemonsqueezy.com/v1/checkouts": { status: 422, body: { errors: [{ detail: "invalid variant" }] } } });
    const provider = createLemonSqueezyProvider(CONFIG, fetchMock);
    await assert.rejects(() => provider.createCheckout({ organizationId: "org_1", planId: "developer" }, "bad-variant"), /422/);
  });
});

describe("LemonSqueezyProvider.createCustomerPortal - Part 10", () => {
  it("fetches the subscription and returns its customer_portal URL", async () => {
    const fetchMock = fakeFetch({
      "GET https://api.lemonsqueezy.com/v1/subscriptions/sub_1": {
        status: 200,
        body: { data: { id: "sub_1", type: "subscriptions", attributes: { status: "active", customer_id: 1, variant_id: 100, renews_at: null, ends_at: null, cancelled: false, urls: { customer_portal: "https://acme.lemonsqueezy.com/billing" } } } },
      },
    });
    const provider = createLemonSqueezyProvider(CONFIG, fetchMock);
    const result = await provider.createCustomerPortal("cust_1", "sub_1");
    assert.equal(result.portalUrl, "https://acme.lemonsqueezy.com/billing");
  });

  it("throws when called without a subscription id (Lemon Squeezy has no customer-level portal)", async () => {
    const provider = createLemonSqueezyProvider(CONFIG, fakeFetch({}));
    await assert.rejects(() => provider.createCustomerPortal("cust_1"));
  });
});

describe("LemonSqueezyProvider.getSubscription", () => {
  it("returns a normalized snapshot with the internal status mapping applied", async () => {
    const fetchMock = fakeFetch({
      "GET https://api.lemonsqueezy.com/v1/subscriptions/sub_1": {
        status: 200,
        body: { data: { id: "sub_1", type: "subscriptions", attributes: { status: "on_trial", customer_id: 1, variant_id: 100, renews_at: "2026-09-22T00:00:00Z", ends_at: null, cancelled: false, urls: {} } } },
      },
    });
    const provider = createLemonSqueezyProvider(CONFIG, fetchMock);
    const snapshot = await provider.getSubscription("sub_1");
    assert.equal(snapshot?.status, "trialing");
    assert.equal(snapshot?.rawStatus, "on_trial");
    assert.equal(snapshot?.currentPeriodEnd, "2026-09-22T00:00:00Z");
  });
});
