/**
 * The billing-provider boundary (Part 4). Every call site in the product API (checkout/portal routes)
 * depends on THIS interface, never on lemonsqueezy.ts directly - swapping or adding a provider means
 * writing a new file that implements BillingProvider, not touching any call site.
 */
import type { CheckoutRequest, CheckoutResult, CustomerPortalResult, ProviderSubscriptionSnapshot } from "./types.js";

export interface BillingProvider {
  readonly name: string;
  createCheckout(request: CheckoutRequest, providerVariantId: string): Promise<CheckoutResult>;
  createCustomerPortal(providerCustomerId: string, providerSubscriptionId?: string): Promise<CustomerPortalResult>;
  getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null>;
  cancelSubscription(providerSubscriptionId: string): Promise<void>;
}
