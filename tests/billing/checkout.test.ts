import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCheckoutForOrganization, type CreateCheckoutDeps } from "../../src/billing/checkout.js";
import { buildPlanCatalog } from "../../src/billing/plans.js";
import type { BillingProvider } from "../../src/billing/provider.js";

const CATALOG = buildPlanCatalog({ developer: { lemonsqueezy: "v_dev" } }); // 'free'/'team'/'business' deliberately have no variant configured here

function makeDeps(overrides: Partial<CreateCheckoutDeps> = {}): CreateCheckoutDeps {
  const provider: BillingProvider = {
    name: "lemonsqueezy",
    createCheckout: async (_req, variantId) => ({ checkoutUrl: `https://example.com/checkout/${variantId}`, provider: "lemonsqueezy" }),
    createCustomerPortal: async () => {
      throw new Error("not used");
    },
    getSubscription: async () => null,
    cancelSubscription: async () => {},
  };
  return {
    provider,
    planCatalog: CATALOG,
    getRole: async () => "owner",
    organizationExists: async () => true,
    ...overrides,
  };
}

describe("createCheckoutForOrganization - Part 9 authorization / Part 22-23 (owner/admin-only billing action)", () => {
  it("rejects a user who is not a member of the organization", async () => {
    const deps = makeDeps({ getRole: async () => null });
    const outcome = await createCheckoutForOrganization(deps, "user_outsider", { organizationId: "org_1", planId: "developer" });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("rejects a plain 'member' - checkout is owner/admin-only", async () => {
    const deps = makeDeps({ getRole: async () => "member" });
    const outcome = await createCheckoutForOrganization(deps, "user_member", { organizationId: "org_1", planId: "developer" });
    assert.equal(!outcome.ok && outcome.error, "insufficient_role");
  });

  it("allows an 'admin', not just an 'owner'", async () => {
    const deps = makeDeps({ getRole: async () => "admin" });
    const outcome = await createCheckoutForOrganization(deps, "user_admin", { organizationId: "org_1", planId: "developer" });
    assert.equal(outcome.ok, true);
  });

  it("rejects an organization that does not exist", async () => {
    const deps = makeDeps({ organizationExists: async () => false });
    const outcome = await createCheckoutForOrganization(deps, "user_1", { organizationId: "org_missing", planId: "developer" });
    assert.equal(!outcome.ok && outcome.error, "organization_not_found");
  });

  it("rejects an invalid/unknown plan id", async () => {
    const deps = makeDeps();
    const outcome = await createCheckoutForOrganization(deps, "user_1", { organizationId: "org_1", planId: "not-a-real-plan" });
    assert.equal(!outcome.ok && outcome.error, "invalid_plan");
  });

  it("rejects a plan with no configured provider variant (e.g. 'free' - nothing to check out)", async () => {
    const deps = makeDeps();
    const outcome = await createCheckoutForOrganization(deps, "user_1", { organizationId: "org_1", planId: "free" });
    assert.equal(!outcome.ok && outcome.error, "plan_not_purchasable");
  });

  it("succeeds for a member with a purchasable plan, using the server-resolved variant id", async () => {
    const deps = makeDeps();
    const outcome = await createCheckoutForOrganization(deps, "user_1", { organizationId: "org_1", planId: "developer" });
    assert.equal(outcome.ok, true);
    assert.ok(outcome.ok && outcome.result.checkoutUrl.endsWith("/v_dev"), "must use the server-side variant mapping, not a client-supplied variant id");
  });

  it("rejects a redirectUrl outside the configured allowlist", async () => {
    const deps = makeDeps({ isAllowedRedirectUrl: (url) => url.startsWith("https://app.diffci.com/") });
    const outcome = await createCheckoutForOrganization(deps, "user_1", { organizationId: "org_1", planId: "developer", redirectUrl: "https://evil.example.com/phish" });
    assert.equal(!outcome.ok && outcome.error, "unauthorized");
  });

  it("allows a redirectUrl inside the configured allowlist", async () => {
    const deps = makeDeps({ isAllowedRedirectUrl: (url) => url.startsWith("https://app.diffci.com/") });
    const outcome = await createCheckoutForOrganization(deps, "user_1", { organizationId: "org_1", planId: "developer", redirectUrl: "https://app.diffci.com/welcome" });
    assert.equal(outcome.ok, true);
  });
});
