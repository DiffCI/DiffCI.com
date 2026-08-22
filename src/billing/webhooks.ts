/**
 * Lemon Squeezy webhook handling (Part 7/8): signature verification, idempotency, and the mapping from
 * provider event -> local subscription state -> organization entitlement state. Defensive throughout -
 * an unrecognized event type is stored and marked ignored_unrecognized_event, never crashes the handler
 * (Part 7: "safe retry behavior" - GitHub-style webhook infra retries on any non-2xx, so an exception
 * here would just cause endless redelivery of an event we already understand we don't handle).
 */
import { mapProviderStatus } from "./lemonsqueezy.js";
import type { BillingStore } from "./store.js";
import type { PlanId } from "./plans.js";
import { isPlanId } from "./plans.js";
import type { Organization } from "../product/types.js";

const RECOGNIZED_SUBSCRIPTION_EVENTS = new Set([
  "subscription_created",
  "subscription_updated",
  "subscription_cancelled",
  "subscription_resumed",
  "subscription_expired",
  "subscription_payment_success",
]);

export interface LemonSqueezyWebhookPayload {
  meta: {
    event_name: string;
    custom_data?: { organization_id?: string };
  };
  data: {
    id: string;
    type: string;
    attributes: {
      status: string;
      customer_id: number;
      variant_id: number;
      renews_at: string | null;
      ends_at: string | null;
      cancelled: boolean;
      [key: string]: unknown;
    };
  };
}

/**
 * HMAC-SHA256 hex digest of the RAW body against the webhook signing secret, timing-safe compare
 * against the X-Signature header - see lemonsqueezy.ts's header comment for the sourcing of this.
 * Takes the raw string body (not a parsed object) deliberately - signature verification must happen
 * over the exact bytes Lemon Squeezy signed, before any JSON.parse.
 */
export async function verifyLemonSqueezySignature(rawBody: string, signatureHeader: string | null, secret: string): Promise<boolean> {
  if (!signatureHeader) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const digestBuf = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const digestHex = Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return timingSafeEqualHex(digestHex, signatureHeader.trim().toLowerCase());
}

function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sha256Hex(input: string): Promise<string> {
  const digestBuf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digestBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Idempotency key (Part 6/7): prefer the provider's own delivery identity when present, but Lemon
 * Squeezy does not guarantee a stable, unique-per-delivery id in the body (see lemonsqueezy.ts's header
 * comment) - fall back to hash(eventType + subscriptionId + rawBody) so a byte-for-byte redelivery of
 * the exact same event is still recognized as a duplicate even without a reliable delivery id.
 */
export async function computeIdempotencyKey(payload: LemonSqueezyWebhookPayload, rawBody: string): Promise<string> {
  const bodyHash = await sha256Hex(rawBody);
  return `lemonsqueezy:${payload.meta.event_name}:${payload.data.id}:${bodyHash.slice(0, 16)}`;
}

/** planId resolution from the variant id on the payload - requires the caller to pass the reverse
 * mapping (variantId -> planId) built from config.ts's variantIdsByPlan, since the webhook payload only
 * ever carries Lemon Squeezy's own variant id, never DiffCI's internal plan id. */
export function resolvePlanIdFromVariant(variantId: string, variantToPlanId: ReadonlyMap<string, PlanId>): PlanId | undefined {
  return variantToPlanId.get(variantId);
}

export interface ProcessWebhookResult {
  status: "processed" | "duplicate" | "unrecognized_event" | "unresolvable_organization" | "invalid_signature";
  organizationId?: string;
}

export interface UpdateOrganizationBillingInput {
  billingStatus: Organization["billingStatus"];
  currentPlan?: string;
  subscriptionStatus?: string;
  billingCustomerReference?: string;
}

export interface ProcessWebhookDeps {
  billingStore: BillingStore;
  updateOrganizationBilling: (organizationId: string, input: UpdateOrganizationBillingInput) => Promise<void>;
  variantToPlanId: ReadonlyMap<string, PlanId>;
  recordAuditEvent: (input: { organizationId?: string; action: string; targetType?: string; targetId?: string; metadata?: Record<string, unknown> }) => Promise<void>;
}

/**
 * Maps DiffCI's internal SubscriptionStatus (already mapped from the provider's raw status by
 * mapProviderStatus() in lemonsqueezy.ts) to the organization's billing_status. Kept as its own function
 * (not inlined) because this IS the state-machine definition Part 8 asks for - the one place that says
 * what each external state means for entitlements.
 */
export function subscriptionStatusToOrganizationBillingStatus(status: ReturnType<typeof mapProviderStatus>): Organization["billingStatus"] {
  switch (status) {
    case "trialing":
      return "trialing";
    case "active":
    case "past_due": // Part 8: past_due keeps the plan active (grace period), never demoted mid-retry
      return status === "active" ? "active" : "past_due";
    case "cancelled":
      return "cancelled";
    case "expired":
      return "expired";
    case "unpaid":
    case "paused":
      // Conservative: neither of these has a distinct organizations.billing_status slot today (Part 8
      // deliberately keeps this state machine small) - both fall to 'past_due' rather than 'cancelled',
      // since the subscription still technically exists and may resume; never silently promote to
      // 'active'.
      return "past_due";
  }
}

/**
 * The full webhook processing pipeline: verify signature -> parse -> idempotency check -> resolve
 * organization -> update local subscription + organization billing state -> audit log. Callers (the
 * product Worker's /v1/billing/webhook route) are responsible only for reading the raw body and the
 * X-Signature header and calling this once.
 */
export async function processLemonSqueezyWebhook(
  rawBody: string,
  signatureHeader: string | null,
  webhookSigningSecret: string,
  deps: ProcessWebhookDeps,
): Promise<ProcessWebhookResult> {
  const valid = await verifyLemonSqueezySignature(rawBody, signatureHeader, webhookSigningSecret);
  if (!valid) return { status: "invalid_signature" };

  let payload: LemonSqueezyWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as LemonSqueezyWebhookPayload;
  } catch {
    return { status: "invalid_signature" }; // malformed body cannot have had a valid signature over valid JSON in practice; treat the same as unverifiable
  }

  const idempotencyKey = await computeIdempotencyKey(payload, rawBody);
  const organizationId = payload.meta.custom_data?.organization_id;

  const recorded = await deps.billingStore.recordBillingEventIfNew({
    idempotencyKey,
    provider: "lemonsqueezy",
    providerEventId: payload.data.id,
    eventType: payload.meta.event_name,
    organizationId,
    payloadHash: await sha256Hex(rawBody),
  });
  if (!recorded) return { status: "duplicate", organizationId };

  if (!RECOGNIZED_SUBSCRIPTION_EVENTS.has(payload.meta.event_name)) {
    await deps.billingStore.markBillingEventProcessed(recorded.id, "ignored_unrecognized_event");
    return { status: "unrecognized_event", organizationId };
  }

  if (!organizationId) {
    // meta.custom_data.organization_id is set at checkout time (lemonsqueezy.ts createCheckout) and
    // should round-trip on every subsequent event for the same subscription - its absence means the
    // checkout wasn't created through DiffCI's own flow, or the correlation was lost. Fail visibly
    // (marked failed, not silently dropped) rather than guessing which organization this belongs to.
    await deps.billingStore.markBillingEventProcessed(recorded.id, "failed", "no organization_id in meta.custom_data");
    return { status: "unresolvable_organization" };
  }

  const status = mapProviderStatus(payload.data.attributes.status);
  const planId = resolvePlanIdFromVariant(String(payload.data.attributes.variant_id), deps.variantToPlanId);

  await deps.billingStore.upsertSubscription({
    organizationId,
    provider: "lemonsqueezy",
    providerSubscriptionId: payload.data.id,
    status,
    rawProviderStatus: payload.data.attributes.status,
    planId: planId ?? "free", // unrecognized variant -> fail closed to free entitlements, never guess a paid plan
    providerVariantId: String(payload.data.attributes.variant_id),
    currentPeriodEnd: payload.data.attributes.renews_at ?? payload.data.attributes.ends_at ?? undefined,
    cancelAtPeriodEnd: payload.data.attributes.cancelled,
  });

  await deps.updateOrganizationBilling(organizationId, {
    billingStatus: subscriptionStatusToOrganizationBillingStatus(status),
    currentPlan: planId && isPlanId(planId) ? planId : undefined, // never downgrade the stored plan on an unrecognized variant - leave it as-is rather than guessing
    subscriptionStatus: payload.data.attributes.status,
    billingCustomerReference: String(payload.data.attributes.customer_id),
  });

  await deps.recordAuditEvent({
    organizationId,
    action: "subscription.changed",
    targetType: "subscription",
    targetId: payload.data.id,
    metadata: { eventType: payload.meta.event_name, status: payload.data.attributes.status },
  });

  await deps.billingStore.markBillingEventProcessed(recorded.id, "processed");
  return { status: "processed", organizationId };
}
