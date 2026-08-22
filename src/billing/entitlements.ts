/**
 * getEntitlements(organizationId) - Part 3's central requirement: answerable without ever calling the
 * billing provider. Reads only src/product's Organization row (current_plan, billing_status) - never
 * touches subscriptions/billing_events directly, since Organization.currentPlan is kept as the
 * authoritative, already-synced-by-webhook local copy (see src/billing/webhooks.ts, which is the only
 * writer of organizations.current_plan/billing_status).
 */
import { DEFAULT_ENTITLEMENTS, getPlanEntitlements } from "./plans.js";
import type { Entitlements } from "./types.js";

export interface OrganizationBillingSnapshot {
  currentPlan: string;
  billingStatus: "none" | "trialing" | "active" | "past_due" | "cancelled" | "expired";
}

/**
 * Billing-outage/lapsed-payment conservatism (Part 8: "Be conservative around billing outages... avoid
 * instantly deleting customer data or repository configuration when payment state changes"): `past_due`
 * still gets the plan's full entitlements (a grace period - the customer keeps working while payment is
 * retried), but `cancelled`/`expired`/`none` fall back to free-tier entitlements rather than the paid
 * plan's, and never delete/lock existing repository records - only entitlement CHECKS (e.g.
 * maxRepositories) are affected, enforced at the point a new repository is added, not retroactively.
 */
export function getEntitlementsForOrganization(org: OrganizationBillingSnapshot): Entitlements {
  if (org.billingStatus === "active" || org.billingStatus === "trialing" || org.billingStatus === "past_due") {
    return getPlanEntitlements(org.currentPlan);
  }
  return DEFAULT_ENTITLEMENTS;
}

export function hasReachedRepositoryLimit(entitlements: Entitlements, currentRepositoryCount: number): boolean {
  if (entitlements.maxRepositories < 0) return false; // unlimited
  return currentRepositoryCount >= entitlements.maxRepositories;
}

export function hasReachedMonthlyAnalysisAllowance(entitlements: Entitlements, analysesThisMonth: number): boolean {
  if (entitlements.monthlyAnalysisAllowance < 0) return false;
  return analysesThisMonth >= entitlements.monthlyAnalysisAllowance;
}
