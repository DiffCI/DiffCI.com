import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  computeIdempotencyKey,
  processLemonSqueezyWebhook,
  resolvePlanIdFromVariant,
  subscriptionStatusToOrganizationBillingStatus,
  verifyLemonSqueezySignature,
  type LemonSqueezyWebhookPayload,
} from "../../src/billing/webhooks.js";
import { mapProviderStatus } from "../../src/billing/lemonsqueezy.js";
import type { BillingStore } from "../../src/billing/store.js";
import type { PlanId } from "../../src/billing/plans.js";

const SECRET = "test-signing-secret";

async function sign(rawBody: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const buf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("verifyLemonSqueezySignature - Part 7 (signature verification, reject invalid)", () => {
  it("accepts a correctly-signed body", async () => {
    const body = JSON.stringify({ a: 1 });
    const sig = await sign(body, SECRET);
    assert.equal(await verifyLemonSqueezySignature(body, sig, SECRET), true);
  });

  it("rejects a tampered body (signature no longer matches)", async () => {
    const body = JSON.stringify({ a: 1 });
    const sig = await sign(body, SECRET);
    const tampered = JSON.stringify({ a: 2 });
    assert.equal(await verifyLemonSqueezySignature(tampered, sig, SECRET), false);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const body = JSON.stringify({ a: 1 });
    const sig = await sign(body, "wrong-secret");
    assert.equal(await verifyLemonSqueezySignature(body, sig, SECRET), false);
  });

  it("rejects a missing signature header", async () => {
    assert.equal(await verifyLemonSqueezySignature(JSON.stringify({ a: 1 }), null, SECRET), false);
  });
});

describe("mapProviderStatus / subscriptionStatusToOrganizationBillingStatus - Part 8 state machine", () => {
  it("maps every known Lemon Squeezy status to a DiffCI SubscriptionStatus", () => {
    assert.equal(mapProviderStatus("on_trial"), "trialing");
    assert.equal(mapProviderStatus("active"), "active");
    assert.equal(mapProviderStatus("past_due"), "past_due");
    assert.equal(mapProviderStatus("cancelled"), "cancelled");
    assert.equal(mapProviderStatus("expired"), "expired");
    assert.equal(mapProviderStatus("paused"), "paused");
    assert.equal(mapProviderStatus("unpaid"), "unpaid");
  });

  it("an unrecognized raw status falls back to past_due, never active (Part 8 conservatism)", () => {
    assert.equal(mapProviderStatus("some_future_status_we_have_never_seen"), "past_due");
  });

  it("past_due subscription status keeps the organization's billing_status as past_due, not cancelled", () => {
    assert.equal(subscriptionStatusToOrganizationBillingStatus("past_due"), "past_due");
  });

  it("cancelled and expired map straight through", () => {
    assert.equal(subscriptionStatusToOrganizationBillingStatus("cancelled"), "cancelled");
    assert.equal(subscriptionStatusToOrganizationBillingStatus("expired"), "expired");
  });
});

describe("resolvePlanIdFromVariant", () => {
  it("resolves a known variant id to its plan id", () => {
    const map = new Map<string, PlanId>([["v_dev", "developer"]]);
    assert.equal(resolvePlanIdFromVariant("v_dev", map), "developer");
  });

  it("returns undefined for an unrecognized variant id (never guesses)", () => {
    const map = new Map<string, PlanId>([["v_dev", "developer"]]);
    assert.equal(resolvePlanIdFromVariant("v_unknown", map), undefined);
  });
});

describe("computeIdempotencyKey", () => {
  it("produces the same key for byte-identical redeliveries", async () => {
    const payload: LemonSqueezyWebhookPayload = {
      meta: { event_name: "subscription_created", custom_data: { organization_id: "org_1" } },
      data: { id: "sub_1", type: "subscriptions", attributes: { status: "active", customer_id: 1, variant_id: 2, renews_at: null, ends_at: null, cancelled: false } },
    };
    const rawBody = JSON.stringify(payload);
    assert.equal(await computeIdempotencyKey(payload, rawBody), await computeIdempotencyKey(payload, rawBody));
  });

  it("produces a different key for a different event on the same subscription", async () => {
    const base = { data: { id: "sub_1", type: "subscriptions", attributes: { status: "active", customer_id: 1, variant_id: 2, renews_at: null, ends_at: null, cancelled: false } } };
    const p1: LemonSqueezyWebhookPayload = { meta: { event_name: "subscription_created" }, ...base };
    const p2: LemonSqueezyWebhookPayload = { meta: { event_name: "subscription_updated" }, ...base };
    const k1 = await computeIdempotencyKey(p1, JSON.stringify(p1));
    const k2 = await computeIdempotencyKey(p2, JSON.stringify(p2));
    assert.notEqual(k1, k2);
  });
});

/** `hasCustomData: false` omits meta.custom_data entirely, rather than relying on a defaulted param
 * (passing `undefined` explicitly for a defaulted parameter triggers the default in JS, so that
 * shortcut can't express "no custom_data at all" - this flag avoids that trap). */
function makePayload(overrides: Partial<LemonSqueezyWebhookPayload["data"]["attributes"]> = {}, eventName = "subscription_created", hasCustomData = true): LemonSqueezyWebhookPayload {
  return {
    meta: { event_name: eventName, custom_data: hasCustomData ? { organization_id: "org_1" } : undefined },
    data: {
      id: "sub_1",
      type: "subscriptions",
      attributes: { status: "active", customer_id: 42, variant_id: 100, renews_at: "2026-09-22T00:00:00Z", ends_at: null, cancelled: false, ...overrides },
    },
  };
}

function makeFakeBillingStore(): BillingStore & { events: unknown[]; subscriptions: unknown[] } {
  const seen = new Set<string>();
  const events: unknown[] = [];
  const subscriptions: unknown[] = [];
  return {
    events,
    subscriptions,
    async upsertCustomer() {
      throw new Error("not used in this test");
    },
    async getCustomerByOrganization() {
      return null;
    },
    async upsertSubscription(input) {
      subscriptions.push(input);
      return { id: "s1", createdAt: "now", updatedAt: "now", ...input } as never;
    },
    async getSubscriptionByOrganization() {
      return null;
    },
    async getSubscriptionByProviderId() {
      return null;
    },
    async recordBillingEventIfNew(input) {
      if (seen.has(input.idempotencyKey)) return null;
      seen.add(input.idempotencyKey);
      events.push(input);
      return { id: `evt-${events.length}`, receivedAt: "now", processingStatus: "received", ...input } as never;
    },
    async markBillingEventProcessed() {
      /* no-op for this fake */
    },
  };
}

describe("processLemonSqueezyWebhook - end-to-end pipeline", () => {
  const variantToPlanId = new Map<string, PlanId>([["100", "developer"]]);

  it("rejects an invalid signature before touching the store at all", async () => {
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const store = makeFakeBillingStore();
    const result = await processLemonSqueezyWebhook(rawBody, "not-a-real-signature", SECRET, {
      billingStore: store,
      updateOrganizationBilling: async () => {
        throw new Error("must not be called");
      },
      variantToPlanId,
      recordAuditEvent: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(result.status, "invalid_signature");
    assert.equal(store.events.length, 0);
  });

  it("processes a valid subscription_created event and updates organization billing state", async () => {
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const sig = await sign(rawBody, SECRET);
    const store = makeFakeBillingStore();
    let updateCalledWith: unknown;
    let auditCalledWith: unknown;
    const result = await processLemonSqueezyWebhook(rawBody, sig, SECRET, {
      billingStore: store,
      updateOrganizationBilling: async (orgId, input) => {
        updateCalledWith = { orgId, input };
      },
      variantToPlanId,
      recordAuditEvent: async (input) => {
        auditCalledWith = input;
      },
    });
    assert.equal(result.status, "processed");
    assert.equal(result.organizationId, "org_1");
    assert.equal(store.subscriptions.length, 1);
    assert.deepEqual(updateCalledWith, { orgId: "org_1", input: { billingStatus: "active", currentPlan: "developer", subscriptionStatus: "active", billingCustomerReference: "42" } });
    assert.ok(auditCalledWith);
  });

  it("a duplicate delivery (webhook retry) is recognized and does not reprocess", async () => {
    const payload = makePayload();
    const rawBody = JSON.stringify(payload);
    const sig = await sign(rawBody, SECRET);
    const store = makeFakeBillingStore();
    const deps = {
      billingStore: store,
      updateOrganizationBilling: async () => {},
      variantToPlanId,
      recordAuditEvent: async () => {},
    };
    const first = await processLemonSqueezyWebhook(rawBody, sig, SECRET, deps);
    const second = await processLemonSqueezyWebhook(rawBody, sig, SECRET, deps);
    assert.equal(first.status, "processed");
    assert.equal(second.status, "duplicate");
    assert.equal(store.subscriptions.length, 1, "must not have upserted the subscription twice");
  });

  it("an unrecognized event type is stored but not treated as a subscription change", async () => {
    const payload = makePayload({}, "license_key_created");
    const rawBody = JSON.stringify(payload);
    const sig = await sign(rawBody, SECRET);
    const store = makeFakeBillingStore();
    const result = await processLemonSqueezyWebhook(rawBody, sig, SECRET, {
      billingStore: store,
      updateOrganizationBilling: async () => {
        throw new Error("must not be called for an unrecognized event");
      },
      variantToPlanId,
      recordAuditEvent: async () => {
        throw new Error("must not be called for an unrecognized event");
      },
    });
    assert.equal(result.status, "unrecognized_event");
    assert.equal(store.events.length, 1, "still recorded for audit/troubleshooting");
  });

  it("a missing organization_id in custom_data fails visibly rather than guessing", async () => {
    const payload = makePayload({}, "subscription_created", false);
    const rawBody = JSON.stringify(payload);
    const sig = await sign(rawBody, SECRET);
    const store = makeFakeBillingStore();
    const result = await processLemonSqueezyWebhook(rawBody, sig, SECRET, {
      billingStore: store,
      updateOrganizationBilling: async () => {
        throw new Error("must not be called");
      },
      variantToPlanId,
      recordAuditEvent: async () => {
        throw new Error("must not be called");
      },
    });
    assert.equal(result.status, "unresolvable_organization");
  });
});
