/**
 * Plan definitions (Part 3). Internal identifiers are stable and never renamed once shipped (they're
 * stored in organizations.current_plan and subscriptions.plan_id) - only the entitlement VALUES attached
 * to each plan id are expected to change over time. Commercial pricing is deliberately not modeled here
 * at all (Part 3: "Do not finalize commercial pricing yet") - only entitlements and the provider-variant
 * mapping. providerVariants is populated from config (see config.ts), never hardcoded, since a variant id
 * differs between environments (test store vs. production store).
 */
import type { Plan } from "./types.js";

export const PLAN_IDS = ["free", "developer", "team", "business"] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export function isPlanId(value: string): value is PlanId {
  return (PLAN_IDS as readonly string[]).includes(value);
}

/** Entitlement values are intentionally conservative/illustrative placeholders - a product/pricing
 * decision, not an engineering one. Adjust freely; nothing else in the codebase hardcodes these numbers. */
const BASE_PLANS: Record<PlanId, Omit<Plan, "providerVariants">> = {
  free: {
    id: "free",
    name: "Free",
    entitlements: {
      planId: "free",
      maxRepositories: 1,
      monthlyAnalysisAllowance: 200,
      shadowMode: true,
      advancedAnalytics: false,
      maxTeamMembers: 1,
      runnerMinutes: 0,
      maxConcurrency: 1,
      retentionDays: 7,
      apiAccess: false,
      premiumSupport: false,
    },
  },
  developer: {
    id: "developer",
    name: "Developer",
    entitlements: {
      planId: "developer",
      maxRepositories: 5,
      monthlyAnalysisAllowance: 2000,
      shadowMode: true,
      advancedAnalytics: false,
      maxTeamMembers: 3,
      runnerMinutes: 500,
      maxConcurrency: 2,
      retentionDays: 30,
      apiAccess: true,
      premiumSupport: false,
    },
  },
  team: {
    id: "team",
    name: "Team",
    entitlements: {
      planId: "team",
      maxRepositories: 25,
      monthlyAnalysisAllowance: 20000,
      shadowMode: true,
      advancedAnalytics: true,
      maxTeamMembers: 15,
      runnerMinutes: 5000,
      maxConcurrency: 5,
      retentionDays: 90,
      apiAccess: true,
      premiumSupport: false,
    },
  },
  business: {
    id: "business",
    name: "Business",
    entitlements: {
      planId: "business",
      maxRepositories: -1,
      monthlyAnalysisAllowance: -1,
      shadowMode: true,
      advancedAnalytics: true,
      maxTeamMembers: -1,
      runnerMinutes: -1,
      maxConcurrency: 20,
      retentionDays: 365,
      apiAccess: true,
      premiumSupport: true,
    },
  },
};

/** The entitlements an organization with NO subscription row at all gets - always the free plan's
 * entitlements, never a hardcoded duplicate (Part 8: be conservative, never silently grant more). */
export const DEFAULT_ENTITLEMENTS = BASE_PLANS.free.entitlements;

export function buildPlanCatalog(providerVariantsByPlan: Partial<Record<PlanId, Partial<Record<"lemonsqueezy", string>>>>): Record<PlanId, Plan> {
  const catalog = {} as Record<PlanId, Plan>;
  for (const id of PLAN_IDS) {
    catalog[id] = { ...BASE_PLANS[id], providerVariants: providerVariantsByPlan[id] ?? {} };
  }
  return catalog;
}

export function getPlanEntitlements(planId: string): Plan["entitlements"] {
  if (isPlanId(planId)) return BASE_PLANS[planId].entitlements;
  // Unknown plan id (e.g. stale data, a plan retired after a customer subscribed to it) - fail closed to
  // free-tier entitlements rather than throwing or silently granting elevated access.
  return DEFAULT_ENTITLEMENTS;
}
