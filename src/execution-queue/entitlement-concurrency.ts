/**
 * Connects organization entitlements to the scheduler's concurrency limit (Part 25:
 * "Connect organization entitlements to queue scheduling... maxConcurrentRunnerJobs. The scheduler
 * should refuse or keep queued work beyond the allowed concurrency"). Entitlements.maxConcurrency
 * (src/billing/types.ts, already defined per-plan in src/billing/plans.ts) IS the
 * maxConcurrentRunnerJobs value - not a separate field, so a plan change takes effect on the very next
 * scheduling pass with no additional wiring.
 */
import { getEntitlementsForOrganization, type OrganizationBillingSnapshot } from "../billing/entitlements.js";
import type { SchedulerDeps } from "./scheduler.js";

/** Builds the scheduler's getMaxConcurrency callback from a live organization lookup. Deliberately does
 * NOT call the billing provider (Part 3/25: entitlements are always answerable from local state) - and
 * deliberately does NOT connect this to real paid-plan billing until Lemon Squeezy test-mode is verified
 * (Part 25's own explicit scoping) - free-tier defaults apply to every organization with no active
 * subscription regardless, so this is safe to wire now without live billing. */
export function makeEntitlementConcurrencyLookup(getOrganization: (organizationId: string) => Promise<OrganizationBillingSnapshot | null>): SchedulerDeps["getMaxConcurrency"] {
  return async (organizationId: string) => {
    const org = await getOrganization(organizationId);
    if (!org) return 0; // an unknown organization gets zero concurrency, never unlimited by default
    return getEntitlementsForOrganization(org).maxConcurrency;
  };
}
