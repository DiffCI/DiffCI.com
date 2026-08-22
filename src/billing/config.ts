/**
 * Billing configuration validation (Part 5). Config is read from Worker env/secrets by the caller and
 * validated here - this module never reads process.env/import.meta.env directly (keeps it portable
 * between the Worker and tests, matching the rest of the codebase's env-injection style, e.g.
 * validation-worker.ts's env parameter threading).
 */
import type { PlanId } from "./plans.js";

export interface LemonSqueezyConfig {
  apiKey: string;
  webhookSigningSecret: string;
  storeId: string;
  /** Plan id -> Lemon Squeezy variant id. Only plans that are actually purchasable need an entry - 'free'
   * deliberately has no variant (there is nothing to check out for a plan that costs nothing). */
  variantIdsByPlan: Partial<Record<PlanId, string>>;
}

export class BillingConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BillingConfigError";
  }
}

export interface RawLemonSqueezyEnv {
  LEMONSQUEEZY_API_KEY?: string;
  LEMONSQUEEZY_WEBHOOK_SECRET?: string;
  LEMONSQUEEZY_STORE_ID?: string;
  /** JSON string, e.g. '{"developer":"123","team":"456","business":"789"}' - kept as one var rather than
   * one env var per plan so adding a plan never requires a new secret to be provisioned. */
  LEMONSQUEEZY_VARIANT_IDS?: string;
}

/**
 * Throws BillingConfigError on missing/malformed config - callers (checkout/portal/webhook routes) MUST
 * catch this and return a clear 5xx rather than letting a raw exception leak, per Part 5's "create
 * validation for missing/malformed billing configuration." Deliberately does NOT throw for a completely
 * absent config object as a whole - see loadLemonSqueezyConfig()'s caller contract below for how
 * dev/test environments run without it.
 */
export function parseLemonSqueezyConfig(env: RawLemonSqueezyEnv): LemonSqueezyConfig {
  const missing: string[] = [];
  if (!env.LEMONSQUEEZY_API_KEY) missing.push("LEMONSQUEEZY_API_KEY");
  if (!env.LEMONSQUEEZY_WEBHOOK_SECRET) missing.push("LEMONSQUEEZY_WEBHOOK_SECRET");
  if (!env.LEMONSQUEEZY_STORE_ID) missing.push("LEMONSQUEEZY_STORE_ID");
  if (missing.length > 0) {
    throw new BillingConfigError(`Missing required Lemon Squeezy config: ${missing.join(", ")}`);
  }

  let variantIdsByPlan: Partial<Record<PlanId, string>> = {};
  if (env.LEMONSQUEEZY_VARIANT_IDS) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(env.LEMONSQUEEZY_VARIANT_IDS);
    } catch {
      throw new BillingConfigError("LEMONSQUEEZY_VARIANT_IDS is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new BillingConfigError("LEMONSQUEEZY_VARIANT_IDS must be a JSON object of planId -> variantId");
    }
    for (const [planId, variantId] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof variantId !== "string" || variantId.length === 0) {
        throw new BillingConfigError(`LEMONSQUEEZY_VARIANT_IDS["${planId}"] must be a non-empty string`);
      }
    }
    variantIdsByPlan = parsed as Partial<Record<PlanId, string>>;
  }

  return {
    apiKey: env.LEMONSQUEEZY_API_KEY!,
    webhookSigningSecret: env.LEMONSQUEEZY_WEBHOOK_SECRET!,
    storeId: env.LEMONSQUEEZY_STORE_ID!,
    variantIdsByPlan,
  };
}

/**
 * Dev/test convenience (Part 5: "Development/test environments should work without production Lemon
 * Squeezy credentials"): returns undefined rather than throwing when nothing at all is configured, so a
 * Worker/test can run with billing entirely disabled (getEntitlements still works off local D1 state
 * regardless - only checkout/portal/live-webhook-verification actually need this).
 */
export function tryLoadLemonSqueezyConfig(env: RawLemonSqueezyEnv): LemonSqueezyConfig | undefined {
  const anyConfigured = Boolean(env.LEMONSQUEEZY_API_KEY || env.LEMONSQUEEZY_WEBHOOK_SECRET || env.LEMONSQUEEZY_STORE_ID);
  if (!anyConfigured) return undefined;
  return parseLemonSqueezyConfig(env); // partially-configured IS an error - fail loudly, not silently
}
