import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createPortalForOrganization, type CreatePortalDeps } from "../../src/billing/portal.js";
import type { BillingProvider } from "../../src/billing/provider.js";
import type { BillingStore } from "../../src/billing/store.js";

function makeStore(overrides: Partial<BillingStore> = {}): BillingStore {
  return {
    upsertCustomer: async () => {
      throw new Error("not used");
    },
    getCustomerByOrganization: async () => ({ id: "c1", organizationId: "org_1", provider: "lemonsqueezy", providerCustomerId: "cust_1", createdAt: "now", updatedAt: "now" }),
    upsertSubscription: async () => {
      throw new Error("not used");
    },
    getSubscriptionByOrganization: async () => ({
      id: "s1",
      organizationId: "org_1",
      provider: "lemonsqueezy",
      providerSubscriptionId: "sub_1",
      status: "active",
      rawProviderStatus: "active",
      planId: "developer",
      providerVariantId: "v1",
      cancelAtPeriodEnd: false,
      createdAt: "now",
      updatedAt: "now",
    }),
    getSubscriptionByProviderId: async () => null,
    recordBillingEventIfNew: async () => null,
    markBillingEventProcessed: async () => {},
    ...overrides,
  };
}

function makeDeps(overrides: Partial<CreatePortalDeps> = {}): CreatePortalDeps {
  const provider: BillingProvider = {
    name: "lemonsqueezy",
    createCheckout: async () => {
      throw new Error("not used");
    },
    createCustomerPortal: async (_customerId, subscriptionId) => ({ portalUrl: `https://example.com/portal/${subscriptionId}`, provider: "lemonsqueezy" }),
    getSubscription: async () => null,
    cancelSubscription: async () => {},
  };
  return { provider, billingStore: makeStore(), isMember: async () => true, ...overrides };
}

describe("createPortalForOrganization - Part 10 authorization / cross-org isolation", () => {
  it("rejects a non-member", async () => {
    const outcome = await createPortalForOrganization(makeDeps({ isMember: async () => false }), "user_outsider", "org_1");
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("returns no_subscription when the organization has no billing customer yet", async () => {
    const deps = makeDeps({ billingStore: makeStore({ getCustomerByOrganization: async () => null }) });
    const outcome = await createPortalForOrganization(deps, "user_1", "org_1");
    assert.equal(!outcome.ok && outcome.error, "no_subscription");
  });

  it("succeeds for a member with an active subscription", async () => {
    const outcome = await createPortalForOrganization(makeDeps(), "user_1", "org_1");
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.result.portalUrl.includes("sub_1"));
  });

  it("cross-organization isolation: the subscription lookup is scoped to the REQUESTED org, so a member of org_A can never resolve org_B's portal", async () => {
    let requestedOrgId: string | undefined;
    const store = makeStore({
      getSubscriptionByOrganization: async (orgId) => {
        requestedOrgId = orgId;
        // Only org_1 has a subscription in this fake - org_2 correctly has none.
        if (orgId !== "org_1") return null;
        return {
          id: "s1", organizationId: "org_1", provider: "lemonsqueezy", providerSubscriptionId: "sub_org1",
          status: "active", rawProviderStatus: "active", planId: "developer", providerVariantId: "v1",
          cancelAtPeriodEnd: false, createdAt: "now", updatedAt: "now",
        };
      },
    });
    const deps = makeDeps({ billingStore: store, isMember: async (orgId) => orgId === "org_2" }); // user is a member of org_2, not org_1
    const outcome = await createPortalForOrganization(deps, "user_1", "org_2");
    assert.equal(requestedOrgId, "org_2", "must look up the subscription for the requested org, never a different one");
    assert.equal(!outcome.ok && outcome.error, "no_subscription", "org_2 genuinely has no subscription - must not fall through to org_1's");
  });
});
