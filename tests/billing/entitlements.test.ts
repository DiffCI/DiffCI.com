import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getEntitlementsForOrganization, hasReachedMonthlyAnalysisAllowance, hasReachedRepositoryLimit } from "../../src/billing/entitlements.js";
import { DEFAULT_ENTITLEMENTS, getPlanEntitlements } from "../../src/billing/plans.js";

describe("getEntitlementsForOrganization - Part 3 (no provider call required) / Part 8 (billing-outage conservatism)", () => {
  it("active status grants the plan's real entitlements", () => {
    const ent = getEntitlementsForOrganization({ currentPlan: "team", billingStatus: "active" });
    assert.equal(ent.planId, "team");
    assert.equal(ent.maxRepositories, 25);
  });

  it("trialing status also grants the plan's entitlements", () => {
    const ent = getEntitlementsForOrganization({ currentPlan: "developer", billingStatus: "trialing" });
    assert.equal(ent.planId, "developer");
  });

  it("past_due keeps the paid plan's entitlements (grace period, not an instant downgrade)", () => {
    const ent = getEntitlementsForOrganization({ currentPlan: "business", billingStatus: "past_due" });
    assert.equal(ent.planId, "business");
    assert.equal(ent.maxRepositories, -1);
  });

  it("cancelled falls back to free-tier entitlements, never keeps the paid plan's", () => {
    const ent = getEntitlementsForOrganization({ currentPlan: "business", billingStatus: "cancelled" });
    assert.deepEqual(ent, DEFAULT_ENTITLEMENTS);
  });

  it("expired and none both fall back to free-tier entitlements", () => {
    assert.deepEqual(getEntitlementsForOrganization({ currentPlan: "team", billingStatus: "expired" }), DEFAULT_ENTITLEMENTS);
    assert.deepEqual(getEntitlementsForOrganization({ currentPlan: "team", billingStatus: "none" }), DEFAULT_ENTITLEMENTS);
  });
});

describe("getPlanEntitlements - fails closed on an unrecognized plan id", () => {
  it("returns free-tier entitlements for a plan id that doesn't exist (e.g. a retired plan)", () => {
    assert.deepEqual(getPlanEntitlements("enterprise-legacy-2019"), DEFAULT_ENTITLEMENTS);
  });
});

describe("hasReachedRepositoryLimit / hasReachedMonthlyAnalysisAllowance", () => {
  it("unlimited (-1) plans never report reaching the limit", () => {
    const business = getPlanEntitlements("business");
    assert.equal(hasReachedRepositoryLimit(business, 999_999), false);
    assert.equal(hasReachedMonthlyAnalysisAllowance(business, 999_999), false);
  });

  it("bounded plans correctly report at/over the limit", () => {
    const free = getPlanEntitlements("free");
    assert.equal(hasReachedRepositoryLimit(free, 0), false);
    assert.equal(hasReachedRepositoryLimit(free, 1), true, "at the limit counts as reached");
    assert.equal(hasReachedMonthlyAnalysisAllowance(free, 199), false);
    assert.equal(hasReachedMonthlyAnalysisAllowance(free, 200), true);
  });
});
