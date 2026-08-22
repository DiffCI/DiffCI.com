/**
 * Lemon Squeezy implementation of BillingProvider (Part 4). This is the ONLY file in the codebase that
 * knows Lemon Squeezy's JSON:API request/response shapes - callers use provider.ts's BillingProvider
 * interface and never import from here directly except at wiring time (the Worker's env setup).
 *
 * API/webhook facts below were verified against Lemon Squeezy's own documentation and independent
 * third-party write-ups during this build (docs.lemonsqueezy.com itself returned HTTP 403 to direct
 * fetch, so this was cross-checked across multiple independent sources rather than invented from
 * training-data memory, per this task's explicit instruction not to invent event names):
 * - Checkout creation: POST https://api.lemonsqueezy.com/v1/checkouts, JSON:API body with
 *   relationships.store/relationships.variant and attributes.checkout_data.custom for arbitrary
 *   metadata that round-trips into every subsequent webhook's meta.custom_data.
 * - Lemon Squeezy has no separate "create portal session" endpoint (unlike Stripe) - each subscription
 *   object exposes attributes.urls.customer_portal directly; createCustomerPortal() here fetches the
 *   subscription and returns that URL.
 * - Webhook signing: X-Signature header, HMAC-SHA256 hex digest over the raw request body using the
 *   webhook signing secret, timing-safe compare - see webhooks.ts verifySignature().
 * - Confirmed real event names (not invented): order_created, order_refunded, subscription_created,
 *   subscription_updated, subscription_cancelled, subscription_resumed, subscription_expired,
 *   subscription_payment_success.
 *
 * CAUTION - flagged explicitly rather than silently assumed: subscription status ENUM values
 * (on_trial/active/paused/past_due/unpaid/cancelled/expired) and the exact create-checkout response
 * field path could not be independently re-verified against Lemon Squeezy's own live reference (docs
 * site 403'd every direct fetch attempt during this build). mapProviderStatus() below is written
 * defensively (unrecognized status -> "past_due", the conservative/non-destructive choice per Part 8,
 * never silently treated as "active") specifically because of this. Before taking real payments,
 * re-verify this enum and the checkout response shape against a live Lemon Squeezy test-mode account.
 */
import type { BillingProvider } from "./provider.js";
import type { LemonSqueezyConfig } from "./config.js";
import type { CheckoutRequest, CheckoutResult, CustomerPortalResult, ProviderSubscriptionSnapshot, SubscriptionStatus } from "./types.js";

const API_BASE = "https://api.lemonsqueezy.com/v1";

export function mapProviderStatus(rawStatus: string): SubscriptionStatus {
  switch (rawStatus) {
    case "on_trial":
      return "trialing";
    case "active":
      return "active";
    case "paused":
      return "paused";
    case "past_due":
      return "past_due";
    case "unpaid":
      return "unpaid";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    default:
      // Conservative fallback (Part 8) for an enum value this adapter doesn't recognize (a Lemon
      // Squeezy status we haven't seen or a future addition) - never silently grants "active".
      return "past_due";
  }
}

interface LsJsonApiDoc<TAttrs> {
  data: { id: string; type: string; attributes: TAttrs };
}

interface LsCheckoutAttributes {
  url: string;
}

interface LsSubscriptionAttributes {
  status: string;
  customer_id: number;
  variant_id: number;
  renews_at: string | null;
  ends_at: string | null;
  trial_ends_at: string | null;
  cancelled: boolean;
  urls: { customer_portal?: string; update_payment_method?: string };
}

export function createLemonSqueezyProvider(config: LemonSqueezyConfig, fetchFn: typeof fetch = fetch): BillingProvider {
  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetchFn(`${API_BASE}${path}`, {
      method,
      headers: {
        Accept: "application/vnd.api+json",
        "Content-Type": "application/vnd.api+json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Lemon Squeezy API ${method} ${path} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    return (await res.json()) as T;
  }

  return {
    name: "lemonsqueezy",

    async createCheckout(checkoutRequest: CheckoutRequest, providerVariantId: string): Promise<CheckoutResult> {
      // Never trust the client to supply the variant id (Part 9) - providerVariantId is resolved
      // server-side by the caller from the internal plan catalog before this is ever called.
      const doc = await request<LsJsonApiDoc<LsCheckoutAttributes>>("POST", "/checkouts", {
        data: {
          type: "checkouts",
          attributes: {
            checkout_data: {
              email: checkoutRequest.customerEmail,
              // Round-trips into meta.custom_data on every subsequent webhook for this subscription -
              // this is how a webhook event gets correlated back to a DiffCI organization (Part 9 step 4).
              custom: { organization_id: checkoutRequest.organizationId },
            },
            product_options: checkoutRequest.redirectUrl ? { redirect_url: checkoutRequest.redirectUrl } : undefined,
          },
          relationships: {
            store: { data: { type: "stores", id: config.storeId } },
            variant: { data: { type: "variants", id: providerVariantId } },
          },
        },
      });
      return { checkoutUrl: doc.data.attributes.url, provider: "lemonsqueezy" };
    },

    async createCustomerPortal(_providerCustomerId: string, providerSubscriptionId?: string): Promise<CustomerPortalResult> {
      if (!providerSubscriptionId) {
        throw new Error("Lemon Squeezy has no customer-level portal - a providerSubscriptionId is required");
      }
      const doc = await request<LsJsonApiDoc<LsSubscriptionAttributes>>("GET", `/subscriptions/${providerSubscriptionId}`);
      const portalUrl = doc.data.attributes.urls.customer_portal;
      if (!portalUrl) throw new Error(`Subscription ${providerSubscriptionId} has no customer_portal URL`);
      return { portalUrl, provider: "lemonsqueezy" };
    },

    async getSubscription(providerSubscriptionId: string): Promise<ProviderSubscriptionSnapshot | null> {
      let doc: LsJsonApiDoc<LsSubscriptionAttributes>;
      try {
        doc = await request<LsJsonApiDoc<LsSubscriptionAttributes>>("GET", `/subscriptions/${providerSubscriptionId}`);
      } catch (err) {
        if (err instanceof Error && err.message.includes(" 404 ")) return null;
        throw err;
      }
      const a = doc.data.attributes;
      return {
        providerSubscriptionId: doc.data.id,
        providerCustomerId: String(a.customer_id),
        status: mapProviderStatus(a.status),
        rawStatus: a.status,
        providerVariantId: String(a.variant_id),
        currentPeriodStart: undefined, // Lemon Squeezy exposes renews_at/ends_at, not a period-start field
        currentPeriodEnd: a.renews_at ?? a.ends_at ?? undefined,
        cancelAtPeriodEnd: a.cancelled,
      };
    },

    async cancelSubscription(providerSubscriptionId: string): Promise<void> {
      await request("DELETE", `/subscriptions/${providerSubscriptionId}`);
    },
  };
}
