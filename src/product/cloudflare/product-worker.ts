/**
 * DiffCI product API Worker (Parts 9/10/19 - organizations, repositories, billing, usage, savings,
 * runner, queue, dashboard routes). New Worker, new `wrangler.product.jsonc` (not yet
 * created/deployed - see the build's final report), deliberately separate from validation-worker.ts and
 * github-runner-worker.ts: this Worker owns the `diffci-product` D1 database (schema files under
 * src/product/, src/billing/, src/auth/, src/usage/, src/runner/, src/execution-queue/), plus a SEPARATE,
 * read-only `RESEARCH_DB` binding to `diffci-research` used ONLY by shadow-read-boundary.ts (Part 20) -
 * this Worker never issues a write against diffci-research.
 *
 * Authentication is now real (Part 2/3): every organization-scoped route resolves the requesting user
 * via authenticateRequest() (src/auth/authenticate.ts), which honors a real session (Bearer token or
 * diffci_session cookie) in every configuration, and additionally honors the spoofable
 * X-DiffCI-User-Id development header ONLY when DIFFCI_ALLOW_DEV_HEADER_AUTH=true, which
 * parseAuthConfig() (src/auth/config.ts) makes impossible to combine with DIFFCI_ENVIRONMENT=production
 * - the Worker throws and refuses to serve any request at all if that illegal combination is configured
 * (see the fetch() handler's top-level try/catch below). No GitHub OAuth login flow is deployed yet
 * (Part 2: "Do NOT necessarily deploy OAuth live yet... implement the application architecture now") -
 * creating a session today requires an out-of-band SessionStore.createSession() call (e.g. from a future
 * OAuth callback route, not yet built).
 */
import { makeD1ProductStore, type D1Binding as ProductD1Binding } from "../store.js";
import { makeD1BillingStore } from "../../billing/store.js";
import { buildPlanCatalog, type PlanId } from "../../billing/plans.js";
import { createLemonSqueezyProvider } from "../../billing/lemonsqueezy.js";
import { tryLoadLemonSqueezyConfig, type RawLemonSqueezyEnv } from "../../billing/config.js";
import { createCheckoutForOrganization } from "../../billing/checkout.js";
import { createPortalForOrganization } from "../../billing/portal.js";
import { processLemonSqueezyWebhook } from "../../billing/webhooks.js";
import { makeD1SessionStore } from "../../auth/sessions.js";
import { authenticateRequest } from "../../auth/authenticate.js";
import { parseAuthConfig, AuthConfigError, type RawAuthEnv } from "../../auth/config.js";
import { makeD1UsageStore } from "../../usage/store.js";
import { makeD1RunnerStore } from "../../runner/store.js";
import { makeD1ExecutionQueueStore } from "../../execution-queue/store.js";
import { makeD1ShadowReadBoundary, type D1Binding as ShadowD1Binding } from "../shadow-read-boundary.js";
import {
  getDashboardForOrganization,
  getOrganizationDetails,
  getQueueItemForOrganization,
  getRunnerStatusForOrganization,
  getSavingsSummaryForOrganization,
  getUsageSummaryForOrganization,
  listRecentQueueItems,
  listRecentRunnerJobs,
  listRepositoriesForOrganization,
  type RouteDeps,
} from "../routes.js";

export interface Env extends RawLemonSqueezyEnv, RawAuthEnv {
  PRODUCT_DB: ProductD1Binding;
  RESEARCH_DB: ShadowD1Binding; // read-only use only - see the header comment above
  DIFFCI_PRODUCT_ENABLED?: string;
  DIFFCI_APP_ORIGIN?: string; // allowlisted redirect_url prefix for checkout, e.g. "https://app.diffci.com/"
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status, headers: { "Cache-Control": "no-store" } });
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

function outcomeStatus(error: string): number {
  if (error === "unauthorized" || error === "insufficient_role") return 403;
  if (error === "not_found" || error === "organization_not_found") return 404;
  return 400;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.DIFFCI_PRODUCT_ENABLED !== "true") return json({ ok: false, error: "product API disabled" }, 503);

    let authConfig;
    try {
      authConfig = parseAuthConfig(env); // THROWS (refuses to serve ANY request) if dev-header-auth is combined with production - Part 3
    } catch (err) {
      if (err instanceof AuthConfigError) return json({ ok: false, error: `misconfigured: ${err.message}` }, 500);
      throw err;
    }

    const url = new URL(request.url);
    const store = makeD1ProductStore(env.PRODUCT_DB);
    const billingStore = makeD1BillingStore(env.PRODUCT_DB);
    const sessionStore = makeD1SessionStore(env.PRODUCT_DB);
    const usageStore = makeD1UsageStore(env.PRODUCT_DB);
    const runnerStore = makeD1RunnerStore(env.PRODUCT_DB);
    const queueStore = makeD1ExecutionQueueStore(env.PRODUCT_DB);
    const shadowBoundary = makeD1ShadowReadBoundary(env.RESEARCH_DB);
    const routeDeps: RouteDeps = { productStore: store, shadowBoundary, runnerStore, queueStore, usageStore };

    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "diffci-product" });
    }

    // --- Billing webhook (Part 7) - authenticated by X-Signature, never by session/dev-header auth
    // (matches the established convention: validation-worker.ts's /v1/shadow/webhook is likewise
    // authenticated purely by its own HMAC check). Placed before the session-auth gate below since a
    // webhook delivery carries no session at all. -----------------------------------------------------
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
      return json({ ok: true, status: result.status }); // always 200 for a recognized-but-not-actionable outcome - Part 7 safe retry behavior
    }

    if (request.method === "POST" && url.pathname === "/v1/organizations") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return json({ ok: false, error: "unauthorized" }, 401);
      const body = (await request.json().catch(() => null)) as { name?: string; slug?: string } | null;
      if (!body?.name || !body?.slug || !/^[a-z0-9-]+$/.test(body.slug)) {
        return json({ ok: false, error: "name and a URL-safe slug (lowercase letters/digits/hyphens) are required" }, 400);
      }
      const existing = await store.getOrganizationBySlug(body.slug);
      if (existing) return json({ ok: false, error: "slug already in use" }, 409);
      const org = await store.createOrganization({ name: body.name, slug: body.slug, ownerUserId: principal.userId });
      await store.recordAuditEvent({ organizationId: org.id, actorUserId: principal.userId, action: "organization.created", targetType: "organization", targetId: org.id });
      return json({ ok: true, organization: org }, 201);
    }

    const orgMatch = url.pathname.match(/^\/v1\/organizations\/([^/]+)(\/.*)?$/);
    if (orgMatch) {
      const organizationId = orgMatch[1]!;
      const subPath = orgMatch[2] ?? "";
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return json({ ok: false, error: "unauthorized" }, 401);
      const userId = principal.userId;

      if (request.method === "GET" && subPath === "") {
        const outcome = await getOrganizationDetails(routeDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/repositories") {
        const outcome = await listRepositoriesForOrganization(routeDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, repositories: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "POST" && subPath === "/repositories") {
        const detailsOutcome = await getOrganizationDetails(routeDeps, userId, organizationId);
        if (!detailsOutcome.ok) return json({ ok: false, error: detailsOutcome.error }, outcomeStatus(detailsOutcome.error));
        const { entitlements } = detailsOutcome.data;
        const currentCount = (await store.listRepositories(organizationId)).length;
        if (entitlements.maxRepositories >= 0 && currentCount >= entitlements.maxRepositories) {
          return json({ ok: false, error: "repository limit reached for current plan", maxRepositories: entitlements.maxRepositories }, 402);
        }
        const body = (await request.json().catch(() => null)) as { providerRepositoryId?: string; ownerName?: string; defaultBranch?: string } | null;
        if (!body?.providerRepositoryId || !body?.ownerName) return json({ ok: false, error: "providerRepositoryId and ownerName are required" }, 400);
        const repo = await store.createRepository({ organizationId, providerRepositoryId: body.providerRepositoryId, ownerName: body.ownerName, defaultBranch: body.defaultBranch });
        await store.recordAuditEvent({ organizationId, actorUserId: userId, action: "repository.connected", targetType: "repository", targetId: repo.id, metadata: { ownerName: repo.ownerName } });
        return json({ ok: true, repository: repo }, 201);
      }

      if (request.method === "GET" && subPath === "/usage") {
        const outcome = await getUsageSummaryForOrganization(routeDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/savings") {
        const ownerName = url.searchParams.get("repo");
        if (!ownerName) return json({ ok: false, error: "repo query param is required" }, 400);
        const outcome = await getSavingsSummaryForOrganization(routeDeps, userId, organizationId, ownerName);
        return outcome.ok ? json({ ok: true, savings: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/runners") {
        const outcome = await listRecentRunnerJobs(routeDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, runners: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const runnerMatch = subPath.match(/^\/runners\/([^/]+)$/);
      if (request.method === "GET" && runnerMatch) {
        const outcome = await getRunnerStatusForOrganization(routeDeps, userId, organizationId, runnerMatch[1]!);
        return outcome.ok ? json({ ok: true, runner: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/queue") {
        const outcome = await listRecentQueueItems(routeDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, queue: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const queueItemMatch = subPath.match(/^\/queue\/([^/]+)$/);
      if (request.method === "GET" && queueItemMatch) {
        const outcome = await getQueueItemForOrganization(routeDeps, userId, organizationId, queueItemMatch[1]!);
        return outcome.ok ? json({ ok: true, item: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/dashboard") {
        const outcome = await getDashboardForOrganization(routeDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, dashboard: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
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
            getRole: async (orgId, uid) => (await store.getMembership(orgId, uid))?.role ?? null,
            organizationExists: async (orgId) => (await store.getOrganization(orgId)) !== null,
            isAllowedRedirectUrl: env.DIFFCI_APP_ORIGIN ? (redirectUrl) => redirectUrl.startsWith(env.DIFFCI_APP_ORIGIN!) : undefined,
          },
          userId,
          { organizationId, planId: body.planId, redirectUrl: body.redirectUrl, customerEmail: body.customerEmail },
        );
        if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
        await store.recordAuditEvent({ organizationId, actorUserId: userId, action: "checkout.opened", targetType: "subscription", metadata: { planId: body.planId } });
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

    return json({ ok: false, error: "not-found" }, 404);
  },
};
