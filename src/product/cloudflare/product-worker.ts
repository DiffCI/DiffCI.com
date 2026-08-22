/**
 * DiffCI product API Worker - Parts 9/10/17 (a first slice of the full product API; organizations,
 * repositories, and billing routes only - predictions/CI-runs/usage/savings-summary/runner-status routes
 * from Part 17's full list, and the dashboard-contract response shapes from Part 18, are follow-up work,
 * not yet built here). New Worker, new `wrangler.product.jsonc` (not yet created/deployed - see the
 * build's final report), deliberately separate from validation-worker.ts and github-runner-worker.ts:
 * this Worker owns the `diffci-product` D1 database (src/product/cloudflare/schema.sql +
 * src/billing/cloudflare/schema.sql), NEVER diffci-research (Stage 2F's database) - see Part 21.
 *
 * *** IMPORTANT, NOT YET PRODUCTION-SAFE ***: there is no real user authentication system anywhere in
 * this codebase yet (confirmed by the Part 1 audit - no OAuth, no sessions, no JWTs-for-humans). Every
 * organization-scoped route below trusts an `X-DiffCI-User-Id` header as a PLACEHOLDER for "the verified
 * requesting user id" - this header is NOT cryptographically verified and is trivially spoofable by
 * anyone who can reach this Worker. It exists only so the authorization LOGIC (organization membership
 * checks - see src/billing/checkout.ts, portal.ts, src/product/store.ts isMember()) can be built,
 * wired, and tested now, ahead of a real auth layer. Building real auth (GitHub OAuth login + signed
 * sessions/JWTs, with THIS Worker verifying a token rather than trusting a bare header) is the single
 * most important remaining gap before this Worker can be deployed behind a public route - do not deploy
 * this Worker publicly until that exists.
 */
import { makeD1ProductStore, type D1Binding as ProductD1Binding } from "../store.js";
import { makeD1BillingStore } from "../../billing/store.js";
import { buildPlanCatalog, type PlanId } from "../../billing/plans.js";
import { createLemonSqueezyProvider } from "../../billing/lemonsqueezy.js";
import { tryLoadLemonSqueezyConfig, type RawLemonSqueezyEnv } from "../../billing/config.js";
import { createCheckoutForOrganization } from "../../billing/checkout.js";
import { createPortalForOrganization } from "../../billing/portal.js";
import { processLemonSqueezyWebhook } from "../../billing/webhooks.js";
import { getEntitlementsForOrganization } from "../../billing/entitlements.js";

export interface Env extends RawLemonSqueezyEnv {
  PRODUCT_DB: ProductD1Binding;
  DIFFCI_PRODUCT_ENABLED?: string;
  DIFFCI_APP_ORIGIN?: string; // allowlisted redirect_url prefix for checkout, e.g. "https://app.diffci.com/"
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

function requestingUserId(request: Request): string | undefined {
  return request.headers.get("X-DiffCI-User-Id") ?? undefined;
}

function planCatalogFromEnv(env: Env) {
  const config = tryLoadLemonSqueezyConfig(env);
  const variantIdsByPlan = config?.variantIdsByPlan ?? {};
  return { catalog: buildPlanCatalog({ ...Object.fromEntries(Object.entries(variantIdsByPlan).map(([plan, variantId]) => [plan, { lemonsqueezy: variantId }])) }), config };
}

function variantToPlanIdMap(variantIdsByPlan: Partial<Record<PlanId, string>>): Map<string, PlanId> {
  const map = new Map<string, PlanId>();
  for (const [planId, variantId] of Object.entries(variantIdsByPlan)) {
    if (variantId) map.set(variantId, planId as PlanId);
  }
  return map;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.DIFFCI_PRODUCT_ENABLED !== "true") return json({ ok: false, error: "product API disabled" }, 503);

    const url = new URL(request.url);
    const store = makeD1ProductStore(env.PRODUCT_DB);
    const billingStore = makeD1BillingStore(env.PRODUCT_DB);

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "diffci-product" });
    }

    // --- Organizations -----------------------------------------------------------------------------
    if (request.method === "POST" && url.pathname === "/v1/organizations") {
      const userId = requestingUserId(request);
      if (!userId) return json({ ok: false, error: "unauthorized" }, 401);
      const body = (await request.json().catch(() => null)) as { name?: string; slug?: string } | null;
      if (!body?.name || !body?.slug || !/^[a-z0-9-]+$/.test(body.slug)) {
        return json({ ok: false, error: "name and a URL-safe slug (lowercase letters/digits/hyphens) are required" }, 400);
      }
      const existing = await store.getOrganizationBySlug(body.slug);
      if (existing) return json({ ok: false, error: "slug already in use" }, 409);
      const org = await store.createOrganization({ name: body.name, slug: body.slug, ownerUserId: userId });
      await store.recordAuditEvent({ organizationId: org.id, actorUserId: userId, action: "organization.created", targetType: "organization", targetId: org.id });
      return json({ ok: true, organization: org }, 201);
    }

    const orgMatch = url.pathname.match(/^\/v1\/organizations\/([^/]+)(\/.*)?$/);
    if (orgMatch) {
      const organizationId = orgMatch[1]!;
      const subPath = orgMatch[2] ?? "";
      const userId = requestingUserId(request);
      if (!userId) return json({ ok: false, error: "unauthorized" }, 401);

      // Single tenant-isolation chokepoint (Part 19) for every /v1/organizations/:id/* route below.
      const isMember = await store.isMember(organizationId, userId);
      if (!isMember) return json({ ok: false, error: "unauthorized" }, 403);

      if (request.method === "GET" && subPath === "") {
        const org = await store.getOrganization(organizationId);
        if (!org) return json({ ok: false, error: "not found" }, 404);
        return json({ ok: true, organization: org, entitlements: getEntitlementsForOrganization(org) });
      }

      if (request.method === "GET" && subPath === "/repositories") {
        return json({ ok: true, repositories: await store.listRepositories(organizationId) });
      }

      if (request.method === "POST" && subPath === "/repositories") {
        const org = await store.getOrganization(organizationId);
        if (!org) return json({ ok: false, error: "not found" }, 404);
        const entitlements = getEntitlementsForOrganization(org);
        const currentCount = (await store.listRepositories(organizationId)).length;
        if (entitlements.maxRepositories >= 0 && currentCount >= entitlements.maxRepositories) {
          return json({ ok: false, error: "repository limit reached for current plan", maxRepositories: entitlements.maxRepositories }, 402);
        }
        const body = (await request.json().catch(() => null)) as { providerRepositoryId?: string; ownerName?: string; defaultBranch?: string } | null;
        if (!body?.providerRepositoryId || !body?.ownerName) return json({ ok: false, error: "providerRepositoryId and ownerName are required" }, 400);
        const repo = await store.createRepository({ organizationId, providerRepositoryId: body.providerRepositoryId, ownerName: body.ownerName, defaultBranch: body.defaultBranch });
        await store.recordAuditEvent({ organizationId, actorUserId: userId, action: "repository.enrolled", targetType: "repository", targetId: repo.id, metadata: { ownerName: repo.ownerName } });
        return json({ ok: true, repository: repo }, 201);
      }

      // --- Billing (Part 9/10) -------------------------------------------------------------------
      if (request.method === "POST" && subPath === "/billing/checkout") {
        const { catalog, config } = planCatalogFromEnv(env);
        if (!config) return json({ ok: false, error: "billing is not configured in this environment" }, 503);
        const body = (await request.json().catch(() => null)) as { planId?: string; redirectUrl?: string; customerEmail?: string } | null;
        if (!body?.planId) return json({ ok: false, error: "planId is required" }, 400);
        const provider = createLemonSqueezyProvider(config);
        const outcome = await createCheckoutForOrganization(
          {
            provider,
            planCatalog: catalog,
            isMember: (orgId, uid) => store.isMember(orgId, uid),
            organizationExists: async (orgId) => (await store.getOrganization(orgId)) !== null,
            isAllowedRedirectUrl: env.DIFFCI_APP_ORIGIN ? (redirectUrl) => redirectUrl.startsWith(env.DIFFCI_APP_ORIGIN!) : undefined,
          },
          userId,
          { organizationId, planId: body.planId, redirectUrl: body.redirectUrl, customerEmail: body.customerEmail },
        );
        if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.error === "unauthorized" ? 403 : 400);
        return json({ ok: true, checkout: outcome.result });
      }

      if (request.method === "POST" && subPath === "/billing/portal") {
        const { config } = planCatalogFromEnv(env);
        if (!config) return json({ ok: false, error: "billing is not configured in this environment" }, 503);
        const provider = createLemonSqueezyProvider(config);
        const outcome = await createPortalForOrganization({ provider, billingStore, isMember: (orgId, uid) => store.isMember(orgId, uid) }, userId, organizationId);
        if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcome.error === "unauthorized" ? 403 : 404);
        return json({ ok: true, portal: outcome.result });
      }
    }

    // --- Billing webhook (Part 7) - authenticated by X-Signature, not the Bearer/membership scheme
    // above (matches the established convention: validation-worker.ts's /v1/shadow/webhook is likewise
    // authenticated purely by its own HMAC check, not the dispatch-token Bearer scheme). --------------
    if (request.method === "POST" && url.pathname === "/v1/billing/webhook") {
      const { config } = planCatalogFromEnv(env);
      if (!config) return json({ ok: false, error: "billing is not configured in this environment" }, 503);
      const rawBody = await request.text();
      const signature = request.headers.get("X-Signature");
      const result = await processLemonSqueezyWebhook(rawBody, signature, config.webhookSigningSecret, {
        billingStore,
        updateOrganizationBilling: (orgId, input) => store.updateOrganizationBilling(orgId, input),
        variantToPlanId: variantToPlanIdMap(config.variantIdsByPlan),
        recordAuditEvent: (input) => store.recordAuditEvent(input),
      });
      if (result.status === "invalid_signature") return json({ ok: false, error: "invalid signature" }, 401);
      // Always 200 for a recognized-but-not-actionable outcome (duplicate/unrecognized_event) - Part 7
      // "safe retry behavior": a non-2xx here would make the provider redeliver forever for something
      // we've already durably recorded and intentionally will not act on again.
      return json({ ok: true, status: result.status });
    }

    return json({ ok: false, error: "not-found" }, 404);
  },
};
