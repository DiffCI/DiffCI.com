/**
 * Billing-provider-agnostic domain types. Nothing in this file (or in entitlements.ts/plans.ts) may
 * import from lemonsqueezy.ts - that dependency direction only ever goes the other way (Part 4: "do not
 * expose Lemon Squeezy-specific types outside the billing module unless unavoidable").
 */

/** DiffCI's own subscription state machine (Part 8), not a raw provider status string. */
export type SubscriptionStatus = "trialing" | "active" | "past_due" | "cancelled" | "expired" | "unpaid" | "paused";

export type BillingProviderName = "lemonsqueezy";

export interface BillingCustomer {
  id: string;
  organizationId: string;
  provider: BillingProviderName;
  providerCustomerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface Subscription {
  id: string;
  organizationId: string;
  provider: BillingProviderName;
  providerSubscriptionId: string;
  status: SubscriptionStatus;
  rawProviderStatus: string;
  planId: string;
  providerVariantId: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface BillingEvent {
  id: string;
  idempotencyKey: string;
  provider: BillingProviderName;
  providerEventId?: string;
  eventType: string;
  organizationId?: string;
  receivedAt: string;
  processedAt?: string;
  processingStatus: "received" | "processed" | "ignored_unrecognized_event" | "failed";
  error?: string;
  payloadHash: string;
}

/**
 * Every entitlement checkable without a Lemon-Squeezy-specific (or any provider-specific) round trip -
 * Part 3: "The application must be able to answer getEntitlements(organizationId) without needing to
 * call Lemon Squeezy on every request." `-1` on a numeric field means unlimited.
 */
export interface Entitlements {
  planId: string;
  maxRepositories: number;
  monthlyAnalysisAllowance: number;
  shadowMode: boolean;
  advancedAnalytics: boolean;
  maxTeamMembers: number;
  runnerMinutes: number;
  maxConcurrency: number;
  retentionDays: number;
  apiAccess: boolean;
  premiumSupport: boolean;
}

export interface Plan {
  id: string; // internal id - 'free' | 'developer' | 'team' | 'business', see plans.ts PLAN_IDS
  name: string;
  entitlements: Entitlements;
  /** Maps this internal plan to the provider variant that represents it, per provider. Populated from
   * config/env (Part 5) - never hardcoded provider ids in source, since variant ids differ between a
   * Lemon Squeezy test store and the production store. */
  providerVariants: Partial<Record<BillingProviderName, string>>;
}

export interface CheckoutRequest {
  organizationId: string;
  planId: string;
  /** Where the customer lands after a successful checkout - validated server-side against an allowlist
   * by the caller (Part 9 route), this module does not enforce that itself. */
  redirectUrl?: string;
  customerEmail?: string;
}

export interface CheckoutResult {
  checkoutUrl: string;
  provider: BillingProviderName;
}

export interface CustomerPortalResult {
  portalUrl: string;
  provider: BillingProviderName;
}

export interface ProviderSubscriptionSnapshot {
  providerSubscriptionId: string;
  providerCustomerId: string;
  status: SubscriptionStatus;
  rawStatus: string;
  providerVariantId: string;
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  cancelAtPeriodEnd: boolean;
}
