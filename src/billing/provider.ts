/**
 * The billing-provider boundary (Part 4). Every call site in the product API (checkout/portal routes)
 * depends on THIS interface, never on lemonsqueezy.ts directly. Lemon Squeezy is DiffCI's designated
 * Merchant of Record; this boundary keeps its wire format out of product code without implying that
 * another payment provider is supported.
 */
import type { BillingProviderName, CheckoutRequest, CheckoutResult, CustomerPortalResult, ProviderSubscriptionSnapshot } from "./types.js";

export interface BillingProvider {
  readonly name: BillingProviderName;
  createCheckout(request: CheckoutRequest, providerVariantId: string): Promise<CheckoutResult>;
  createCustomerPortal(providerCustomerId: string, providerSubscriptionId?: string): Promise<CustomerPortalResult>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null>;
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
}
