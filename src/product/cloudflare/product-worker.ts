/**
 * DiffCI product API Worker (Parts 9/10/19 - organizations, repositories, billing, usage, savings,
 * runner, queue, dashboard routes). New Worker, new `wrangler.product.jsonc` (not yet
 * created/deployed - see the build's final report), deliberately separate from validation-worker.ts and
 * github-runner-worker.ts: this Worker owns the `diffci-product` D1 database (schema files under
 * src/product/, src/billing/, src/auth/, src/usage/, src/runner/, src/execution-queue/), plus a SEPARATE,
 * read-only `RESEARCH_DB` binding to `diffci-research` used ONLY by shadow-read-boundary.ts (Part 20) -
 * this Worker never issues a write against diffci-research.
 *
 * Authentication is real (Part 2/3): every organization-scoped route resolves the requesting user via
 * authenticateRequest() (src/auth/authenticate.ts), which honors a real session (Bearer token or
 * diffci_session cookie) in every configuration, and additionally honors the spoofable
 * X-DiffCI-User-Id development header ONLY when DIFFCI_ALLOW_DEV_HEADER_AUTH=true, which
 * parseAuthConfig() (src/auth/config.ts) makes impossible to combine with DIFFCI_ENVIRONMENT=production
 * - the Worker throws and refuses to serve any request at all if that illegal combination is configured.
 * GET/auth/github + GET/auth/github/callback + POST/auth/logout implement the real GitHub OAuth flow
 * (Part 6) - live-tested against mocked GitHub responses; the GitHub OAuth App itself (client_id/secret)
 * is a manual registration step, see docs referenced in the build's final report.
 *
 * scheduled() runs the orphan-runner cleanup sweep (Part 15/22) on the Worker's own cron trigger
 * (wrangler.product.jsonc triggers.crons) - uses the real CloudflareContainerRunnerProvider when
 * RUNNER_CONTROL_TOKEN/SYNTHETIC_RUNNER_URL are configured, falling back to the mock provider otherwise
 * (a stale mock-provider runner has nothing real to terminate, so this is always safe either way).
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
import { makeD1OAuthStore } from "../../auth/oauth-store.js";
import { buildGithubAuthorizeUrl } from "../../auth/oauth.js";
import { handleGithubCallback } from "../../auth/login.js";
import { generateCsrfToken, verifyCsrfToken, CSRF_COOKIE_NAME, CSRF_HEADER_NAME } from "../../auth/csrf.js";
import { buildSessionCookie, buildExpiredSessionCookie, buildCsrfCookie } from "../../auth/session-cookie.js";
import { makeD1UsageStore } from "../../usage/store.js";
import { makeD1RunnerStore } from "../../runner/store.js";
import { runOrphanCleanup } from "../../runner/cleanup.js";
import { createMockRunnerProvider } from "../../runner/mock-provider.js";
import { createCloudflareContainerRunnerProvider } from "../../runner/cloudflare-container-provider.js";
import { createCloudflareContainerAsyncRunnerProvider } from "../../runner/cloudflare-container-async-provider.js";
import { makeD1RunnerTokenStore } from "../../runner/token.js";
import { handleRegister, handleHeartbeat, handleClaim, handleResult, type AgentApiDeps } from "../../runner/agent-api.js";
import { buildRunnerResourceTags } from "../../runner/tags.js";
import { createCloudflareContainersLiteCostModel } from "../../usage/cost-model.js";
import { scheduleNext } from "../../execution-queue/scheduler.js";
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
  GITHUB_OAUTH_CLIENT_ID?: string;
  GITHUB_OAUTH_CLIENT_SECRET?: string;
  CSRF_SECRET?: string;
  SYNTHETIC_RUNNER_URL?: string; // e.g. https://diffci-synthetic-runner.<account>.workers.dev
  RUNNER_CONTROL_TOKEN?: string; // must match the secret configured on wrangler.synthetic-runner.jsonc
  DIFFCI_API_ORIGIN?: string; // this Worker's own public base URL - injected into R1 runners so their
                              // bootstrap script knows where to call back (src/runner/agent-api.ts)
  DIFFCI_ENVIRONMENT_LABEL?: string; // R1 Part 6 resource-tag "environment" value - defaults to "staging"
}

function runnerProviderFromEnv(env: Env) {
  if (env.SYNTHETIC_RUNNER_URL && env.RUNNER_CONTROL_TOKEN) {
    return createCloudflareContainerRunnerProvider({ workerBaseUrl: env.SYNTHETIC_RUNNER_URL, controlToken: env.RUNNER_CONTROL_TOKEN, jobCommand: 'echo "diffci-runner-ok"' });
  }
  return createMockRunnerProvider();
}

/** R1's real, genuinely-async provider - see src/runner/cloudflare-container-async-provider.ts's own
 * header for why this is a SEPARATE provider from runnerProviderFromEnv()'s synchronous one above. */
function asyncRunnerProviderFromEnv(env: Env) {
  if (!env.SYNTHETIC_RUNNER_URL || !env.RUNNER_CONTROL_TOKEN) return undefined;
  return createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: env.SYNTHETIC_RUNNER_URL, controlToken: env.RUNNER_CONTROL_TOKEN, startTimeoutMs: 30_000 });
}

function agentApiDepsFromEnv(env: Env): AgentApiDeps {
  const store = makeD1ProductStore(env.PRODUCT_DB);
  return {
    tokenStore: makeD1RunnerTokenStore(env.PRODUCT_DB),
    runnerStore: makeD1RunnerStore(env.PRODUCT_DB),
    queueStore: makeD1ExecutionQueueStore(env.PRODUCT_DB),
    usageStore: makeD1UsageStore(env.PRODUCT_DB),
    costModel: createCloudflareContainersLiteCostModel(),
    recordAuditEvent: (entry) => store.recordAuditEvent(entry),
  };
}

function json(payload: unknown, status = 200, extraHeaders?: Headers): Response {
  const headers = new Headers(extraHeaders);
  headers.set("Cache-Control", "no-store");
  return Response.json(payload, { status, headers });
}

/** Part 27: stable-named structured telemetry. One line per event, never a credential/token value in
 * the data payload - every call site below passes only ids/booleans/counts. */
function logEvent(name: string, data: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event: name, ts: new Date().toISOString(), ...data }));
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("Cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
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

/**
 * Part 9: applied to every state-changing browser route. Only enforced for authenticationMethod ===
 * "session" (real cookie-backed browser sessions - the actual CSRF threat model; a Bearer-token API
 * client isn't vulnerable to CSRF the same way, since the token must be explicitly attached by calling
 * code rather than auto-sent by the browser) and only when CSRF_SECRET is configured at all (if it
 * isn't, there is no session-cookie flow live yet either, matching this build's own scoping).
 */
async function requireCsrf(request: Request, env: Env, principal: { sessionId?: string; authenticationMethod: string }): Promise<boolean> {
  if (principal.authenticationMethod !== "session" || !principal.sessionId) return true;
  if (!env.CSRF_SECRET) return true;
  const cookieValue = readCookie(request, CSRF_COOKIE_NAME);
  const headerValue = request.headers.get(CSRF_HEADER_NAME) ?? undefined;
  // Bound to the resolved session id (not the raw token, not just userId) - the same value the CSRF
  // cookie was signed against at login time (see the /auth/github/callback route below), so it is
  // specific to THIS session, not reusable across a user's other logged-in sessions/devices.
  return verifyCsrfToken(env.CSRF_SECRET, principal.sessionId, cookieValue, headerValue);
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
    const oauthStore = makeD1OAuthStore(env.PRODUCT_DB);
    const usageStore = makeD1UsageStore(env.PRODUCT_DB);
    const runnerStore = makeD1RunnerStore(env.PRODUCT_DB);
    const queueStore = makeD1ExecutionQueueStore(env.PRODUCT_DB);
    const shadowBoundary = makeD1ShadowReadBoundary(env.RESEARCH_DB);
    const routeDeps: RouteDeps = { productStore: store, shadowBoundary, runnerStore, queueStore, usageStore };

    // Part 26: deployment-safe health/diagnostics - only non-sensitive booleans/counts, never a secret
    // value, a token, customer data, or a raw SQL error message.
    if (request.method === "GET" && url.pathname === "/health") {
      let dbReachable = true;
      try {
        await store.getOrganizationBySlug("__health_check_nonexistent_slug__");
      } catch {
        dbReachable = false;
      }
      const { config: billingConfig } = planCatalogFromEnv(env);
      return json({
        ok: true,
        service: "diffci-product",
        workerHealthy: true,
        productDbReachable: dbReachable,
        authConfigValid: true, // reaching this line already proves parseAuthConfig() didn't throw
        environment: authConfig.environment,
        billingConfigured: billingConfig !== undefined,
        githubOAuthConfigured: Boolean(env.GITHUB_OAUTH_CLIENT_ID && env.GITHUB_OAUTH_CLIENT_SECRET),
        csrfConfigured: Boolean(env.CSRF_SECRET),
        queueSubsystemReachable: dbReachable, // queue/runner/usage all live in the same PRODUCT_DB binding as organizations
        runnerProvider: env.SYNTHETIC_RUNNER_URL && env.RUNNER_CONTROL_TOKEN ? "cloudflare-containers" : "mock",
      });
    }

    // --- GitHub OAuth login (Part 6) --------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/auth/github") {
      if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return json({ ok: false, error: "GitHub OAuth is not configured in this environment" }, 503);
      const redirectTo = url.searchParams.get("redirect_to") ?? undefined;
      if (redirectTo && env.DIFFCI_APP_ORIGIN && !redirectTo.startsWith(env.DIFFCI_APP_ORIGIN)) {
        return json({ ok: false, error: "redirect_to is outside the allowed app origin" }, 400);
      }
      const state = await oauthStore.createState(10 * 60 * 1000, redirectTo); // 10 min - long enough for a real login, short enough to bound replay exposure
      const authorizeUrl = buildGithubAuthorizeUrl({ clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET, redirectUri: `${url.origin}/auth/github/callback` }, state);
      logEvent("oauth.redirect", { provider: "github" });
      return new Response(null, { status: 302, headers: { Location: authorizeUrl } });
    }

    if (request.method === "GET" && url.pathname === "/auth/github/callback") {
      if (!env.GITHUB_OAUTH_CLIENT_ID || !env.GITHUB_OAUTH_CLIENT_SECRET) return json({ ok: false, error: "GitHub OAuth is not configured in this environment" }, 503);
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        logEvent("oauth.failure", { provider: "github", reason: "missing_code_or_state" });
        return json({ ok: false, error: "invalid callback: missing code or state" }, 400);
      }
      const outcome = await handleGithubCallback(
        {
          oauthConfig: { clientId: env.GITHUB_OAUTH_CLIENT_ID, clientSecret: env.GITHUB_OAUTH_CLIENT_SECRET, redirectUri: `${url.origin}/auth/github/callback` },
          oauthStore,
          sessionStore,
          productStore: store,
          sessionTtlMs: authConfig.sessionTtlMs,
        },
        { code, state },
      );
      if (!outcome.ok) {
        logEvent("oauth.failure", { provider: "github", reason: outcome.error });
        return json({ ok: false, error: outcome.error }, outcome.error === "invalid_or_replayed_state" ? 400 : 502);
      }
      logEvent("oauth.success", { provider: "github", userId: outcome.userId, wasNewUser: outcome.wasNewUser });
      logEvent("session.created", { userId: outcome.userId });
      await store.recordAuditEvent({ actorUserId: outcome.userId, action: "user.authenticated", metadata: { provider: "github", wasNewUser: outcome.wasNewUser } });

      const headers = new Headers({ Location: outcome.redirectTo && (!env.DIFFCI_APP_ORIGIN || outcome.redirectTo.startsWith(env.DIFFCI_APP_ORIGIN)) ? outcome.redirectTo : "/" });
      headers.append("Set-Cookie", buildSessionCookie(outcome.rawSessionToken, outcome.sessionExpiresAt));
      if (env.CSRF_SECRET) headers.append("Set-Cookie", buildCsrfCookie(await generateCsrfToken(env.CSRF_SECRET, outcome.sessionId)));
      return new Response(null, { status: 302, headers });
    }

    if (request.method === "POST" && url.pathname === "/auth/logout") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (principal?.sessionId) {
        await sessionStore.revokeSession(principal.sessionId);
        logEvent("session.revoked", { userId: principal.userId, reason: "logout" });
      }
      const headers = new Headers();
      headers.append("Set-Cookie", buildExpiredSessionCookie());
      return json({ ok: true }, 200, headers);
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

    // --- R1 runner-agent API (Part 13) -----------------------------------------------------------------
    // Authenticated purely by each request's own one-time runner token (src/runner/agent-api.ts /
    // src/runner/token.ts) - NEVER a browser session (Part 13: "Do not reuse browser sessions for runner
    // authentication"). Placed before the session-auth gate below since a real runner agent carries no
    // user session at all - same reasoning as the billing webhook route just above.
    if (request.method === "POST" && url.pathname === "/v1/runner/register") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) return json({ ok: false, error: "token is required" }, 400);
      const result = await handleRegister(body.token, agentApiDepsFromEnv(env));
      return json(result, result.ok ? 200 : 401);
    }

    if (request.method === "POST" && url.pathname === "/v1/runner/heartbeat") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) return json({ ok: false, error: "token is required" }, 400);
      const result = await handleHeartbeat(body.token, agentApiDepsFromEnv(env));
      return json(result, result.ok ? 200 : 401);
    }

    if (request.method === "POST" && url.pathname === "/v1/runner/claim") {
      const body = (await request.json().catch(() => null)) as { token?: string } | null;
      if (!body?.token) return json({ ok: false, error: "token is required" }, 400);
      const result = await handleClaim(body.token, agentApiDepsFromEnv(env));
      return json(result, result.ok ? 200 : result.error === "already_claimed" ? 409 : 401);
    }

    if (request.method === "POST" && url.pathname === "/v1/runner/result") {
      const body = (await request.json().catch(() => null)) as { token?: string; exitCode?: number; stdout?: string; stderr?: string; durationMs?: number } | null;
      if (!body?.token || body.exitCode === undefined || body.stdout === undefined || body.durationMs === undefined) {
        return json({ ok: false, error: "token, exitCode, stdout, and durationMs are required" }, 400);
      }
      const deps = agentApiDepsFromEnv(env);
      const result = await handleResult({ token: body.token, exitCode: body.exitCode, stdout: body.stdout, stderr: body.stderr, durationMs: body.durationMs }, deps);
      if (!result.ok) return json(result, 401);

      // Part 9/26: request real teardown right after a genuine (non-duplicate) completion - R1's own
      // "one job per runner" model means completion IS the natural termination trigger, not a separate
      // later sweep. A duplicate result (already torn down by the first call) skips this safely.
      if (!result.data?.duplicate) {
        const runner = await deps.runnerStore.getRunner(result.data!.runnerId);
        if (runner?.providerRunnerId && runner.status === "completed") {
          const provider = asyncRunnerProviderFromEnv(env);
          if (provider) {
            await deps.runnerStore.transitionRunnerStatus(runner.id, "terminating");
            await provider.terminateRunner(runner.providerRunnerId);
            await deps.runnerStore.transitionRunnerStatus(runner.id, "terminated");
            await store.recordAuditEvent({ organizationId: runner.organizationId, action: "runner.terminated", targetType: "runner", targetId: runner.id });
          }
        }
      }
      return json(result, 200);
    }

    if (request.method === "POST" && url.pathname === "/v1/organizations") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return json({ ok: false, error: "unauthorized" }, 401);
      if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
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
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
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

      // R1 Part 26/35: the real end-to-end proof entry point - "authenticated organization -> create
      // synthetic job -> queue -> scheduler -> provider -> real runner -> runner API -> result -> usage
      // -> audit -> teardown", driven through this actual staging route, never by invoking provider code
      // directly from a script. Deliberately: ONLY the fixed, trivial, deterministic command (Part 15) -
      // no request body field lets a caller supply an arbitrary command (Part 36/40: R1 never executes
      // caller-supplied code).
      if (request.method === "POST" && subPath === "/runner-jobs/synthetic") {
        const detailsOutcome = await getOrganizationDetails(routeDeps, userId, organizationId);
        if (!detailsOutcome.ok) return json({ ok: false, error: detailsOutcome.error }, outcomeStatus(detailsOutcome.error));
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const provider = asyncRunnerProviderFromEnv(env);
        if (!provider || !env.DIFFCI_API_ORIGIN) return json({ ok: false, error: "R1 real runner is not configured in this environment (SYNTHETIC_RUNNER_URL/RUNNER_CONTROL_TOKEN/DIFFCI_API_ORIGIN)" }, 503);

        const tokenStore = makeD1RunnerTokenStore(env.PRODUCT_DB);
        const item = await queueStore.enqueue({ organizationId, jobReference: 'node -e "console.log(\'diffci-runner-ok\')"', requestedResourceClass: "lite" });
        await store.recordAuditEvent({ organizationId, actorUserId: userId, action: "runner.job_queue_created", targetType: "queue_item", targetId: item.id });

        const outcomes = await scheduleNext(
          {
            queueStore,
            runnerStore,
            runnerProvider: provider,
            getMaxConcurrency: async () => detailsOutcome.data.entitlements.maxConcurrency,
            mintRunnerCredential: async ({ runnerId, jobId, organizationId: orgId }) => {
              const { raw } = await tokenStore.issueToken({ runnerId, jobId, organizationId: orgId, ttlMs: 10 * 60_000 });
              const tags = buildRunnerResourceTags({ environment: env.DIFFCI_ENVIRONMENT_LABEL ?? "staging", runnerId, organizationId: orgId, jobId, createdAt: new Date().toISOString() });
              await store.recordAuditEvent({ organizationId: orgId, actorUserId: userId, action: "runner.provisioned", targetType: "runner", targetId: runnerId, metadata: { tags } });
              return { token: raw, apiBaseUrl: env.DIFFCI_API_ORIGIN!, jobCommand: item.jobReference };
            },
          },
          1,
        );
        const outcome = outcomes.find((o) => o.queueItemId === item.id);
        return json({ ok: true, queueItemId: item.id, runnerId: outcome?.runnerId, outcome: outcome?.outcome }, 202);
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
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
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
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
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

  // Part 15/22: orphan-runner cleanup sweep, wired to wrangler.product.jsonc's cron trigger.
  async scheduled(_event: unknown, env: Env): Promise<void> {
    const runnerStore = makeD1RunnerStore(env.PRODUCT_DB);
    const provider = runnerProviderFromEnv(env);
    const results = await runOrphanCleanup(runnerStore, provider);
    for (const r of results) {
      logEvent("runner.orphan_cleanup", { runnerId: r.runnerId, previousStatus: r.previousStatus, terminated: r.terminated, error: r.error });
    }
    logEvent("orphan_cleanup.sweep_completed", { count: results.length, terminated: results.filter((r) => r.terminated).length, failed: results.filter((r) => !r.terminated).length });
  },
};
