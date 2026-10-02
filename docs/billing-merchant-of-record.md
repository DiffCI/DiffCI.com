# Billing Merchant of Record

Lemon Squeezy is DiffCI's exclusive Merchant of Record (MoR) for commercial subscriptions. DiffCI does
not contain a second checkout or payment-provider path. The provider interface isolates Lemon Squeezy's
API format from product code; its `name` is constrained at compile time to `lemonsqueezy`.

The implemented flow covers server-side plan-to-variant mapping, hosted checkout creation, customer
portal links, signed and idempotent webhooks, subscription state synchronization, entitlements and
billing audit records. `/health` publishes both `merchantOfRecord: "lemonsqueezy"` and
`billingProvider: "lemonsqueezy"`. `billingConfigured` separately reports whether the required runtime
credentials are present, without exposing them.

Activation requires external Lemon Squeezy setup:

1. Create the DiffCI store and commercial subscription products/variants.
2. Set `LEMONSQUEEZY_API_KEY`, `LEMONSQUEEZY_WEBHOOK_SECRET`, and `LEMONSQUEEZY_STORE_ID` as Worker secrets.
3. Set `LEMONSQUEEZY_VARIANT_IDS` to a JSON mapping from DiffCI plan ids to Lemon Squeezy variant ids.
4. Register the product Worker's billing webhook endpoint in Lemon Squeezy and enable the subscription
   and order events handled by `src/billing/webhooks.ts`.
5. Complete Lemon Squeezy's business, tax, bank/payout, and production-store verification steps, then
   verify checkout, renewal, cancellation, refund, and failed-payment behavior in test mode before
   accepting live payments.

Until steps 1-4 are complete, billing routes fail closed with `billing is not configured` and health
reports `billingConfigured: false`. Those are external activation tasks, not missing billing code.
