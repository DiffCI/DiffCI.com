/**
 * POST /v1/billing/checkout request handling (Part 9), decoupled from the Worker's HTTP layer so
 * authorization is directly unit-testable (see tests/billing/checkout.test.ts) without spinning up a
 * fetch() handler. The Worker route (src/product/cloudflare/product-worker.ts) is a thin wrapper that
 * extracts the requesting user id and calls this.
 */
import type { BillingProvider } from "./provider.js";
import { isPlanId } from "./plans.js";
import type { CheckoutResult, Plan } from "./types.js";

export interface CreateCheckoutInput {
  organizationId: string;
  planId: string;
  redirectUrl?: string;
  customerEmail?: string;
}

export type CreateCheckoutOutcome =
  | { ok: true; result: CheckoutResult }
  | { ok: false; error: "unauthorized" | "insufficient_role" | "invalid_plan" | "plan_not_purchasable" | "organization_not_found" };

export interface CreateCheckoutDeps {
  provider: BillingProvider;
  planCatalog: Record<string, Plan>;
  /** Returns the requesting user's role in the organization, or null if they are not a member at all.
   * Checkout is an owner/admin-only billing action (Part 22/23: "member cannot perform owner-only
   * billing action") - a plain 'member' role is authenticated and IS a member, but is still rejected
   * here, distinctly from a non-member (see CreateCheckoutOutcome's separate error codes). */
  getRole: (organizationId: string, userId: string) => Promise<"owner" | "admin" | "member" | null>;
  organizationExists: (organizationId: string) => Promise<boolean>;
  /** Allowlist check for redirectUrl (Part 9 doesn't mandate this, but an open redirect via an
   * attacker-controlled checkout redirect is a real risk worth closing here rather than trusting the
   * client's URL unconditionally). Pass undefined to skip the check (e.g. in a context with no such
   * concept configured yet). */
  isAllowedRedirectUrl?: (url: string) => boolean;
}

/**
 * Never trusts the client to specify a Lemon-Squeezy variant id directly (Part 9) - only planId is taken
 * from the request; the provider variant id is resolved server-side from planCatalog.
 */
export async function createCheckoutForOrganization(deps: CreateCheckoutDeps, requestingUserId: string, input: CreateCheckoutInput): Promise<CreateCheckoutOutcome> {
  const orgExists = await deps.organizationExists(input.organizationId);
  if (!orgExists) return { ok: false, error: "organization_not_found" };

  // Step 1 (Part 9): verify the requesting user belongs to/controls the organization.
  const role = await deps.getRole(input.organizationId, requestingUserId);
  if (!role) return { ok: false, error: "unauthorized" };
  if (role !== "owner" && role !== "admin") return { ok: false, error: "insufficient_role" }; // a real member, just not permitted to change billing

  if (!isPlanId(input.planId)) return { ok: false, error: "invalid_plan" };

  // Step 2 (Part 9): map the DiffCI plan to a Lemon Squeezy variant, server-side only.
  const plan = deps.planCatalog[input.planId];
  const providerVariantId = plan?.providerVariants.lemonsqueezy;
  if (!providerVariantId) return { ok: false, error: "plan_not_purchasable" }; // e.g. 'free' has no variant

  if (input.redirectUrl && deps.isAllowedRedirectUrl && !deps.isAllowedRedirectUrl(input.redirectUrl)) {
    return { ok: false, error: "unauthorized" };
  }

  // Step 3-4 (Part 9): create the checkout with the internal organization id attached via custom_data
  // (done inside provider.createCheckout - see lemonsqueezy.ts).
  const result = await deps.provider.createCheckout(
    { organizationId: input.organizationId, planId: input.planId, redirectUrl: input.redirectUrl, customerEmail: input.customerEmail },
    providerVariantId,
  );
  return { ok: true, result };
}
