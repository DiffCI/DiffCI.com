/**
 * POST /v1/billing/portal request handling (Part 10). Same decoupled-from-Worker-HTTP-layer shape as
 * checkout.ts, for the same testability reason.
 */
import type { BillingProvider } from "./provider.js";
import type { BillingStore } from "./store.js";
import type { CustomerPortalResult } from "./types.js";

export type CreatePortalOutcome = { ok: true; result: CustomerPortalResult } | { ok: false; error: "unauthorized" | "no_subscription" };

export interface CreatePortalDeps {
  provider: BillingProvider;
  billingStore: BillingStore;
  isMember: (organizationId: string, userId: string) => Promise<boolean>;
}

/**
 * Authorization is organization-based (Part 10: "Do not expose another organization's billing portal") -
 * the portal URL is looked up strictly from THIS organization's own subscription/customer record; there
 * is no code path where one organization's request can resolve to a different organization's portal URL,
 * because the subscription is fetched by organizationId, never by a client-supplied subscription id.
 */
export async function createPortalForOrganization(deps: CreatePortalDeps, requestingUserId: string, organizationId: string): Promise<CreatePortalOutcome> {
  const member = await deps.isMember(organizationId, requestingUserId);
  if (!member) return { ok: false, error: "unauthorized" };

  const customer = await deps.billingStore.getCustomerByOrganization(organizationId, "lemonsqueezy");
  const subscription = await deps.billingStore.getSubscriptionByOrganization(organizationId, "lemonsqueezy");
  if (!customer || !subscription) return { ok: false, error: "no_subscription" };

  const result = await deps.provider.createCustomerPortal(customer.providerCustomerId, subscription.providerSubscriptionId);
  return { ok: true, result };
}
