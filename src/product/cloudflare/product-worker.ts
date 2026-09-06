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
import { readGithubOAuthEnv } from "../../auth/oauth-env.js";
import { loadUserReports } from "../report-access.js";
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
import { handleRegister, handleHeartbeat, handleClaim, handleResult, type AgentApiDeps, type ClaimStep } from "../../runner/agent-api.js";
import { buildRunnerResourceTags } from "../../runner/tags.js";
import { createCloudflareContainersLiteCostModel, createDefaultComputeCostModel } from "../../usage/cost-model.js";
import { createDefaultClimateImpactModel } from "../../usage/climate-model.js";
import { makeD1DurationObservationStore } from "../../usage/duration-observation-store.js";
import { computeHistoricalAverageSecondsPerTest } from "../../usage/duration-capture.js";
import { runDurationCaptureSweep } from "../../usage/duration-capture-job.js";
import { scheduleNext } from "../../execution-queue/scheduler.js";
import { makeD1ExecutionQueueStore } from "../../execution-queue/store.js";
import { makeD1ShadowReadBoundary, type D1Binding as ShadowD1Binding } from "../shadow-read-boundary.js";
import { connectInstallation } from "../../install/github-installation.js";
import { handleInstallationWebhook } from "../../install/webhook.js";
import { makeD1PendingInstallationStore, claimInstallation } from "../../install/pending.js";
import { makeD1WebhookDeliveryStore } from "../../install/delivery-log.js";
import { currentMonth, getMonthlyLedgerForOrganization, type LedgerRouteDeps } from "../../ledger/routes.js";
import { makeD1InvoiceStore } from "../../billing/invoice-store.js";
import { DEFAULT_SAVINGS_SHARE_PERCENT } from "../../billing/metered.js";
import {
  getInvoiceForOrganization,
  issueInvoice,
  listInvoicesForOrganization,
  markInvoicePaid,
  prepareInvoiceForMonth,
  reconcileInvoiceForOrganization,
  voidInvoiceForOrganization,
  type InvoiceRouteDeps,
} from "../../billing/invoice-routes.js";
import { renderClaimInstallation, renderHome, renderInvoices, renderLedger, renderOrganization, renderRepository, renderSignedOut } from "../../ui/pages.js";
import { makeD1IngestTokenStore } from "../../ingest/token.js";
import { parseAgentArtifact } from "../../ingest/agent-artifact.js";
import { decideRepositoryAdmission, EARLY_ACCESS_ENABLED } from "../../billing/repository-admission.js";
import { makeD1ObservationStore } from "../../ingest/store.js";
import { ingestObservation, MAX_REPORT_BYTES } from "../../ingest/ingest.js";
import type { IngestRejection } from "../../ingest/types.js";
import { runRetentionSweep } from "../../ingest/retention.js";
import {
  deleteObservationsForOrganization,
  getInstallInstructionsForRepository,
  getObservationForOrganization,
  issueIngestTokenForRepository,
  listIngestTokensForOrganization,
  listObservationsForOrganization,
  revokeIngestToken,
  type IngestRouteDeps,
} from "../../ingest/routes.js";
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
  DIFFCI_AGENT_ARTIFACT?: string; // "npm:@diffci/observer@1.4.2#sha512-..." - the pinned agent onboarding installs
  DIFFCI_SAVINGS_SHARE_PERCENT?: string; // metered price, default 15 - copied onto each invoice at build time
  // GitHub App (Phase 03 follow-up): repository discovery on install, and erasure on uninstall. All four
  // are needed together; with any missing, the console says the App is not configured here rather than
  // offering a button that cannot work.
  GITHUB_APP_SLUG?: string; // the App's URL slug, e.g. "diffci-observer"
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY?: string; // PKCS#8 PEM (secret)
  GITHUB_APP_WEBHOOK_SECRET?: string; // secret
  // 2026-09-05 private-repository reports: Service Binding to diffci-research-sandbox (a plain fetch to
  // its workers.dev URL is blocked, error 1042) plus the research dispatch token it authenticates with.
  RESEARCH_WORKER?: { fetch(request: Request): Promise<Response> };
  RESEARCH_DISPATCH_TOKEN?: string; // secret - the same value the research Worker holds
  DIFFCI_REPORT_BASE_URL?: string; // optional override of the public report route
  SYNTHETIC_RUNNER_WORKER?: { fetch(request: Request): Promise<Response> }; // real Service Binding to diffci-synthetic-runner - see wrangler.product.jsonc's own comment on why this exists instead of a plain fetch(SYNTHETIC_RUNNER_URL)
}

function runnerProviderFromEnv(env: Env) {
  if (env.SYNTHETIC_RUNNER_URL && env.RUNNER_CONTROL_TOKEN) {
    return createCloudflareContainerRunnerProvider({ workerBaseUrl: env.SYNTHETIC_RUNNER_URL, controlToken: env.RUNNER_CONTROL_TOKEN, jobCommand: 'echo "diffci-runner-ok"' });
  }
  return createMockRunnerProvider();
}

/** R1's real, genuinely-async provider - see src/runner/cloudflare-container-async-provider.ts's own
 * header for why this is a SEPARATE provider from runnerProviderFromEnv()'s synchronous one above.
 * Routed through the real Service Binding (env.SYNTHETIC_RUNNER_WORKER), never a plain fetch() to
 * SYNTHETIC_RUNNER_URL - found via a real, preserved first-attempt failure (R1 Part 26/40): Cloudflare
 * rejects a Worker fetching another Worker's own workers.dev URL outright (error 1042). The existing
 * SYNCHRONOUS provider (runnerProviderFromEnv, above) has this exact same latent issue if ever actually
 * invoked from within this deployed Worker rather than an external script - out of scope to fix here
 * (Part 2: don't redesign a working abstraction unless necessary), but worth flagging honestly (see the
 * R1 final report's security/limitations review). */
function asyncRunnerProviderFromEnv(env: Env) {
  if (!env.RUNNER_CONTROL_TOKEN || !env.SYNTHETIC_RUNNER_WORKER) return undefined;
  const binding = env.SYNTHETIC_RUNNER_WORKER;
  const bindingFetch: typeof fetch = (async (input: unknown, init?: RequestInit) => binding.fetch(new Request(input as string, init))) as typeof fetch;
  return createCloudflareContainerAsyncRunnerProvider({ workerBaseUrl: "https://synthetic-runner.internal", controlToken: env.RUNNER_CONTROL_TOKEN, startTimeoutMs: 30_000 }, bindingFetch);
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

/** The console's responses. Never cached: every page is per-session and some of it changes per request. */
function htmlResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
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

/**
 * Ingest rejections mapped to HTTP (Phase 03). The distinctions matter to the caller: 401 means "fix
 * your credential", 403 means "this credential is real but not for this repository", 409 means "the
 * credential is fine and the repository is not accepting observations", and 4xx generally means the
 * client should not retry - src/client/submit.ts only retries 5xx and network failures.
 */
function ingestRejectionStatus(rejection: IngestRejection): number {
  switch (rejection) {
    case "missing_token":
    case "invalid_token":
    case "revoked_token":
    case "expired_token":
      return 401;
    case "repository_mismatch":
      return 403;
    case "repository_inactive":
      return 409;
    case "payload_too_large":
      return 413;
    case "malformed_payload":
    case "unsupported_schema":
      return 400;
  }
}

function outcomeStatus(error: string): number {
  if (error === "unauthorized" || error === "insufficient_role") return 403;
  if (error === "not_found" || error === "organization_not_found") return 404;
  // The deployment is misconfigured, not the request. Same class as the 503s returned when OAuth or
  // the App is unconfigured: nothing the caller can change will make it succeed.
  if (error === "agent_not_pinned") return 503;
  return 400;
}

interface ExecutionCtx {
  waitUntil(promise: Promise<unknown>): void;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionCtx): Promise<Response> {
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

    // Phase 03 ingest. `actionRef` is what generated install instructions tell a customer to pin; it is
    // configuration rather than a constant because the published action's SHA changes with every
    // release, and instructions naming a stale one would be worse than instructions naming none.
    const parsedAgentArtifact = parseAgentArtifact(env.DIFFCI_AGENT_ARTIFACT);
    // B3 + replay dedup (2026-08-27). Both back the installation webhook: one parks an installation
    // that arrived without a session to attribute it to, the other stops a redelivered destructive
    // event being applied twice.
    const pendingInstallationStore = makeD1PendingInstallationStore(env.PRODUCT_DB);
    const webhookDeliveryStore = makeD1WebhookDeliveryStore(env.PRODUCT_DB);
    const ingestTokenStore = makeD1IngestTokenStore(env.PRODUCT_DB);
    const observationStore = makeD1ObservationStore(env.PRODUCT_DB);
    const ingestDeps: IngestRouteDeps = {
      productStore: store,
      tokenStore: ingestTokenStore,
      observationStore,
      // NO FALLBACK, deliberately. The predecessor of this line defaulted to a branch ref, which meant
      // the DEFAULT configuration generated customer workflows naming something mutable - whoever
      // controlled that branch would control what ran in every customer's CI, forever. An unparseable
      // or unset value yields null, and every route that would emit a workflow refuses instead.
      agentArtifact: parsedAgentArtifact.ok ? parsedAgentArtifact.artifact : null,
      apiOrigin: env.DIFFCI_API_ORIGIN ?? url.origin,
    };

    // Phase 04. No `savingsInput` is supplied: no per-repository duration observation exists for a
    // client-observed repository yet, so every time and cost figure the ledger produces is UNKNOWN -
    // which is the honest answer, and the one the ledger is built to give rather than to paper over.
    const ledgerDeps: LedgerRouteDeps = { productStore: store, observationStore };

    // Phase 05. DIFFCI_SAVINGS_SHARE_PERCENT exists so the rate is configuration rather than a constant
    // compiled into the pricing code - but the rate that applied is copied ONTO each invoice when it is
    // built, so changing this never re-prices an invoice anyone has already seen.
    const invoiceDeps: InvoiceRouteDeps = {
      ...ledgerDeps,
      invoiceStore: makeD1InvoiceStore(env.PRODUCT_DB),
      savingsSharePercent: env.DIFFCI_SAVINGS_SHARE_PERCENT ? Number(env.DIFFCI_SAVINGS_SHARE_PERCENT) : undefined,
    };

    // Real duration-derived cost/carbon savings (2026-08-23), computed lazily - only the two routes that
    // actually surface savings numbers (dashboard, /savings) pay for this extra D1 read, not every
    // request through this Worker. averageSecondsPerAvoidedTest is "unavailable" until the cron sweep
    // (see scheduled() below) has captured at least one real commit's CI timing, and honestly tagged
    // "historical_estimate" (never "measured") from then on. costModel/climateModel here are the GENERIC
    // default shapes (createDefaultComputeCostModel/createDefaultClimateImpactModel), NOT
    // createCloudflareContainersLiteCostModel - that model prices DiffCI's OWN 0.25 vCPU/256 MiB runner
    // containers (used elsewhere in this file for R1's runner cost tracking), which has nothing to do
    // with the cost/carbon of the CUSTOMER's own CI compute that these avoided tests would have run on.
    async function routeDepsWithSavings(): Promise<RouteDeps> {
      const durationObservationStore = makeD1DurationObservationStore(env.PRODUCT_DB);
      const recentDurationObservations = await durationObservationStore.listRecent(undefined, 200);
      const historicalDuration = computeHistoricalAverageSecondsPerTest(recentDurationObservations);
      if (typeof historicalDuration.value !== "number") return routeDeps;
      return { ...routeDeps, savingsOptions: { averageSecondsPerAvoidedTest: { seconds: historicalDuration.value, confidence: "historical_estimate" as const }, costModel: createDefaultComputeCostModel(), climateModel: createDefaultClimateImpactModel() } };
    }

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
        githubOAuthConfigured: readGithubOAuthEnv(env).ok, // validated, not merely present - a malformed id reads as unconfigured
        csrfConfigured: Boolean(env.CSRF_SECRET),
        queueSubsystemReachable: dbReachable, // queue/runner/usage all live in the same PRODUCT_DB binding as organizations
        runnerProvider: env.SYNTHETIC_RUNNER_URL && env.RUNNER_CONTROL_TOKEN ? "cloudflare-containers" : "mock",
        // Phases 03-05 (2026-08-26). Booleans and a rate, never a secret value - these exist so the
        // deployment runbook can verify each step with one request instead of by trying the flow and
        // interpreting the failure.
        githubAppConfigured: Boolean(env.GITHUB_APP_SLUG && env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY),
        githubAppWebhookConfigured: Boolean(env.GITHUB_APP_WEBHOOK_SECRET),
        // Whether generated install instructions will name a specific commit rather than a moving ref.
        // Same parser the routes use, not a second check that could drift from it. When this is false,
        // install-instruction generation is refused - the flag and the behaviour cannot disagree.
        agentArtifactPinned: parsedAgentArtifact.ok,
        agentArtifactRejection: parsedAgentArtifact.ok ? undefined : parsedAgentArtifact.rejection,
        agentArtifact: parsedAgentArtifact.ok ? parsedAgentArtifact.artifact.display : undefined,
        savingsSharePercent: env.DIFFCI_SAVINGS_SHARE_PERCENT ? Number(env.DIFFCI_SAVINGS_SHARE_PERCENT) : DEFAULT_SAVINGS_SHARE_PERCENT,
      });
    }

    // --- The console (Phase 03 follow-up) ---------------------------------------------------------
    // Server-rendered HTML, no build step. Every page here reads through the same organization-scoped
    // route functions the JSON API uses, so a page cannot see anything an API caller could not: there is
    // no separate "UI query" path, and therefore no second place for a tenancy check to be forgotten.
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/app" || url.pathname === "/app/")) {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) {
        const oauth = readGithubOAuthEnv(env);
        if (!oauth.ok) console.log(`github-oauth: sign-in disabled - ${oauth.reason}`);
        return htmlResponse(renderSignedOut({ githubConfigured: oauth.ok }));
      }
      const [user, organizations, login] = await Promise.all([
        store.getUser(principal.userId),
        store.listOrganizationsForUser(principal.userId),
        oauthStore.getProviderLoginForUser(principal.userId, "github").catch(() => null), // no OAuth schema = no login to look up
      ]);
      // 2026-09-05: the user's shadow reports, authorised by GitHub's collaborator answer through the
      // research Worker (Service Binding + dispatch token). Unavailable is rendered as unavailable.
      const reports = await loadUserReports({ researchWorker: env.RESEARCH_WORKER, dispatchToken: env.RESEARCH_DISPATCH_TOKEN, reportBaseUrl: env.DIFFCI_REPORT_BASE_URL }, login);
      return htmlResponse(renderHome({ email: user?.email ?? "", organizations, reports }));
    }

    const consoleInvoicesMatch = url.pathname.match(/^\/app\/orgs\/([^/]+)\/invoices\/?$/);
    if (request.method === "GET" && consoleInvoicesMatch) {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return Response.redirect(`${url.origin}/app`, 302);
      const organizationId = consoleInvoicesMatch[1]!;
      const [details, invoices] = await Promise.all([
        getOrganizationDetails(routeDeps, principal.userId, organizationId),
        listInvoicesForOrganization(invoiceDeps, principal.userId, organizationId),
      ]);
      if (!details.ok) return htmlResponse(renderSignedOut({ githubConfigured: true }), outcomeStatus(details.error));
      if (!invoices.ok) return htmlResponse(renderSignedOut({ githubConfigured: true }), outcomeStatus(invoices.error));

      const reconcileId = url.searchParams.get("reconcile");
      const reconciliation = reconcileId
        ? await reconcileInvoiceForOrganization(invoiceDeps, principal.userId, organizationId, reconcileId)
        : undefined;
      const [user, membership] = await Promise.all([store.getUser(principal.userId), store.getMembership(organizationId, principal.userId)]);
      return htmlResponse(
        renderInvoices({
          email: user?.email ?? "",
          organization: details.data.organization,
          invoices: invoices.data,
          reconciliation: reconciliation?.ok ? { invoiceId: reconcileId!, result: reconciliation.data.reconciliation } : undefined,
          canManage: membership?.role === "owner" || membership?.role === "admin",
        }),
      );
    }

    const consoleLedgerMatch = url.pathname.match(/^\/app\/orgs\/([^/]+)\/ledger\/?$/);
    if (request.method === "GET" && consoleLedgerMatch) {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return Response.redirect(`${url.origin}/app`, 302);
      const organizationId = consoleLedgerMatch[1]!;
      const month = url.searchParams.get("month") ?? currentMonth();
      const [details, ledger] = await Promise.all([
        getOrganizationDetails(routeDeps, principal.userId, organizationId),
        getMonthlyLedgerForOrganization(ledgerDeps, principal.userId, organizationId, month),
      ]);
      if (!details.ok) return htmlResponse(renderSignedOut({ githubConfigured: true }), outcomeStatus(details.error));
      if (!ledger.ok) return htmlResponse(renderSignedOut({ githubConfigured: true }), outcomeStatus(ledger.error));
      const user = await store.getUser(principal.userId);
      return htmlResponse(renderLedger({ email: user?.email ?? "", organization: details.data.organization, ledger: ledger.data }));
    }

    const consoleOrgMatch = url.pathname.match(/^\/app\/orgs\/([^/]+)(?:\/repos\/([^/]+))?\/?$/);
    if (request.method === "GET" && consoleOrgMatch) {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return Response.redirect(`${url.origin}/app`, 302);
      const organizationId = consoleOrgMatch[1]!;
      const repositoryId = consoleOrgMatch[2];

      const details = await getOrganizationDetails(routeDeps, principal.userId, organizationId);
      if (!details.ok) return htmlResponse(renderSignedOut({ githubConfigured: true }), outcomeStatus(details.error));
      const user = await store.getUser(principal.userId);
      const email = user?.email ?? "";

      if (repositoryId) {
        const install = await getInstallInstructionsForRepository(ingestDeps, principal.userId, organizationId, repositoryId);
        if (!install.ok) return htmlResponse(renderSignedOut({ githubConfigured: true }), outcomeStatus(install.error));
        const [repository, tokens, observations] = await Promise.all([
          store.getRepository(repositoryId),
          listIngestTokensForOrganization(ingestDeps, principal.userId, organizationId),
          listObservationsForOrganization(ingestDeps, principal.userId, organizationId, { repositoryId, limit: 20 }),
        ]);
        if (!repository) return htmlResponse(renderSignedOut({ githubConfigured: true }), 404);
        return htmlResponse(
          renderRepository({
            email,
            organization: details.data.organization,
            repository,
            install: install.data,
            tokens: (tokens.ok ? tokens.data : []).filter((token) => token.repositoryId === repositoryId),
            observations: observations.ok ? observations.data.observations : [],
          }),
        );
      }

      const [repositories, tokens, observations, dashboard] = await Promise.all([
        listRepositoriesForOrganization(routeDeps, principal.userId, organizationId),
        listIngestTokensForOrganization(ingestDeps, principal.userId, organizationId),
        listObservationsForOrganization(ingestDeps, principal.userId, organizationId, { limit: 10 }),
        // 2026-09-05 seamless install: report links (with the token for private repositories) for a
        // verified member - the only place a private repository's report token is ever shown. A research
        // database problem must never take the console page down: links are simply absent.
        getDashboardForOrganization(routeDeps, principal.userId, organizationId).catch(() => ({ ok: false as const, error: "not_found" as const })),
      ]);
      return htmlResponse(
        renderOrganization({
          email,
          organization: details.data.organization,
          repositories: repositories.ok ? repositories.data : [],
          tokens: tokens.ok ? tokens.data : [],
          summary: observations.ok ? observations.data.summary : { total: 0, observed: 0, refused: 0, errored: 0, selective: 0, full: 0, worktreeUnchanged: 0, distinctRepositories: 0 },
          recent: observations.ok ? observations.data.observations : [],
          installUrl: env.GITHUB_APP_SLUG ? `/app/install?organizationId=${encodeURIComponent(organizationId)}` : undefined,
          reports: dashboard.ok ? dashboard.data.reports : [],
        }),
      );
    }

    // Start of the App installation flow. The state is server-generated and single-use (the same
    // oauth_states table the login flow uses), so the installation that comes back can only be attached
    // to the organization whose owner started this - not to one named in a link somebody was sent.
    if (request.method === "GET" && url.pathname === "/app/install") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return Response.redirect(`${url.origin}/app`, 302);
      const organizationId = url.searchParams.get("organizationId") ?? "";
      if (!(await store.isMember(organizationId, principal.userId))) return json({ ok: false, error: "unauthorized" }, 403);
      if (!env.GITHUB_APP_SLUG) return json({ ok: false, error: "the GitHub App is not configured in this environment" }, 503);
      const state = await oauthStore.createState(10 * 60 * 1000, `/app/orgs/${organizationId}`);
      return Response.redirect(`https://github.com/apps/${env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`, 302);
    }

    // Where GitHub sends the installer back (the App's Setup URL).
    if (request.method === "GET" && url.pathname === "/app/install/callback") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return Response.redirect(`${url.origin}/app`, 302);
      const installationId = url.searchParams.get("installation_id");
      const state = url.searchParams.get("state");
      if (!installationId) return json({ ok: false, error: "invalid callback: missing installation_id" }, 400);

      // B3 (2026-08-27): the install-first arrival. Someone who installed from GitHub's own App page
      // never passed through /app/install, so there is no state to consume - and before this, they got
      // a bare 400 and no way forward. There is still nothing here that authorises attaching the
      // installation to a tenant, so this does NOT connect anything: it sends them to the claim screen,
      // where they choose an organization and the claim is authorised properly. See install/pending.ts.
      if (!state) {
        return Response.redirect(`${url.origin}/app/install/claim?installation_id=${encodeURIComponent(installationId)}`, 302);
      }

      const consumed = await oauthStore.consumeState(state);
      const organizationId = consumed?.redirectTo?.replace("/app/orgs/", "");
      if (!consumed || !organizationId) {
        logEvent("installation.state_rejected", {});
        return json({ ok: false, error: "invalid or already-used installation state" }, 400);
      }
      // Membership is re-checked here, not assumed from the state: the state proves the flow started
      // here, not that this particular session may act for that organization.
      if (!(await store.isMember(organizationId, principal.userId))) return json({ ok: false, error: "unauthorized" }, 403);
      if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return json({ ok: false, error: "the GitHub App is not configured in this environment" }, 503);

      const result = await connectInstallation(
        { productStore: store, credentials: { appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY } },
        { organizationId, userId: principal.userId, installationId },
      );
      logEvent("installation.connected", { organizationId, connected: result.connected, updated: result.updated, refused: result.refused });
      return Response.redirect(`${url.origin}/app/orgs/${organizationId}`, 302);
    }

    // Uninstall and repository-removal deliveries. This is the route that ERASES data, so the signature
    // check inside handleInstallationWebhook is the whole of its authentication.
    // B3: the claim screen. Lists the organizations this signed-in user could attach the parked
    // installation to. Deliberately shows nothing about the installation beyond what they already know
    // (they just performed it) until the claim itself proves they are the installer.
    if (request.method === "GET" && url.pathname === "/app/install/claim") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return Response.redirect(`${url.origin}/app`, 302);
      const installationId = url.searchParams.get("installation_id") ?? "";
      if (!installationId) return json({ ok: false, error: "missing installation_id" }, 400);
      const [user, organizations, pending] = await Promise.all([
        store.getUser(principal.userId),
        store.listOrganizationsForUser(principal.userId),
        pendingInstallationStore.get(installationId),
      ]);
      return htmlResponse(
        renderClaimInstallation({
          email: user?.email ?? "",
          installationId,
          accountLogin: pending?.accountLogin,
          // A claimed installation is reported as claimed rather than as missing: "unknown" would send
          // someone re-installing to fix a problem they do not have.
          alreadyClaimed: Boolean(pending?.claimedAt),
          known: Boolean(pending),
          organizations,
        }),
      );
    }

    if (request.method === "POST" && url.pathname === "/v1/installations/claim") {
      const principal = await authenticateRequest(request, { config: authConfig, sessionStore });
      if (!principal) return json({ ok: false, error: "unauthorized" }, 401);
      if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
      if (!env.GITHUB_APP_ID || !env.GITHUB_APP_PRIVATE_KEY) return json({ ok: false, error: "the GitHub App is not configured in this environment" }, 503);
      const body = (await request.json().catch(() => null)) as { installationId?: string; organizationId?: string } | null;
      if (!body?.installationId || !body?.organizationId) return json({ ok: false, error: "installationId and organizationId are required" }, 400);

      const outcome = await claimInstallation(
        {
          pendingStore: pendingInstallationStore,
          productStore: store,
          oauthStore,
          connectDeps: { credentials: { appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY } },
        },
        { installationId: body.installationId, userId: principal.userId, organizationId: body.organizationId },
      );
      if (!outcome.ok) {
        logEvent("installation.claim_refused", { refusal: outcome.refusal });
        // Every refusal is 403 except "no such installation". Distinguishing "not yours" from
        // "already taken" with different statuses would let someone probe which installation ids exist.
        return json({ ok: false, error: outcome.refusal }, outcome.refusal === "unknown_installation" ? 404 : 403);
      }
      logEvent("installation.claimed", { organizationId: body.organizationId, connected: outcome.result.connected, refused: outcome.result.refused });
      return json({ ok: true, ...outcome.result }, 200);
    }

    if (request.method === "POST" && url.pathname === "/v1/webhooks/github/installation") {
      if (!env.GITHUB_APP_WEBHOOK_SECRET) return json({ ok: false, error: "webhooks are not configured in this environment" }, 503);
      const rawBody = await request.text();
      const result = await handleInstallationWebhook(
        {
          rawBody,
          signature: request.headers.get("X-Hub-Signature-256"),
          event: request.headers.get("X-GitHub-Event"),
          // Replay/duplicate suppression key. GitHub retries anything that did not get a timely 2xx,
          // and any delivery can be redelivered by hand from the App's settings page months later.
          deliveryId: request.headers.get("X-GitHub-Delivery"),
        },
        {
          productStore: store,
          observationStore,
          tokenStore: ingestTokenStore,
          pendingStore: pendingInstallationStore,
          deliveryStore: webhookDeliveryStore,
          webhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
          connectDeps:
            env.GITHUB_APP_ID && env.GITHUB_APP_PRIVATE_KEY
              ? { credentials: { appId: env.GITHUB_APP_ID, privateKeyPkcs8Pem: env.GITHUB_APP_PRIVATE_KEY } }
              : undefined,
        },
      );
      if (!result.ok) {
        logEvent("installation_webhook.rejected", { error: result.error });
        return json({ ok: false, error: result.error }, result.error === "bad_signature" ? 401 : 400);
      }
      logEvent("installation_webhook.handled", { ...result });
      return json(result, 200);
    }

    // --- GitHub OAuth login (Part 6) --------------------------------------------------------------
    if (request.method === "GET" && url.pathname === "/auth/github") {
      const oauth = readGithubOAuthEnv(env); // validated, not merely present: a malformed id must never reach GitHub
      if (!oauth.ok) {
        console.log(`github-oauth: refusing ${url.pathname} - ${oauth.reason}`);
        return json({ ok: false, error: "GitHub OAuth is not configured in this environment" }, 503);
      }
      const redirectTo = url.searchParams.get("redirect_to") ?? undefined;
      if (redirectTo && env.DIFFCI_APP_ORIGIN && !redirectTo.startsWith(env.DIFFCI_APP_ORIGIN)) {
        return json({ ok: false, error: "redirect_to is outside the allowed app origin" }, 400);
      }
      const state = await oauthStore.createState(10 * 60 * 1000, redirectTo); // 10 min - long enough for a real login, short enough to bound replay exposure
      const authorizeUrl = buildGithubAuthorizeUrl({ ...oauth.credentials, redirectUri: `${url.origin}/auth/github/callback` }, state);
      logEvent("oauth.redirect", { provider: "github" });
      return new Response(null, { status: 302, headers: { Location: authorizeUrl } });
    }

    if (request.method === "GET" && url.pathname === "/auth/github/callback") {
      const oauth = readGithubOAuthEnv(env); // validated, not merely present: a malformed id must never reach GitHub
      if (!oauth.ok) {
        console.log(`github-oauth: refusing ${url.pathname} - ${oauth.reason}`);
        return json({ ok: false, error: "GitHub OAuth is not configured in this environment" }, 503);
      }
      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      if (!code || !state) {
        logEvent("oauth.failure", { provider: "github", reason: "missing_code_or_state" });
        return json({ ok: false, error: "invalid callback: missing code or state" }, 400);
      }
      const outcome = await handleGithubCallback(
        {
          oauthConfig: { ...oauth.credentials, redirectUri: `${url.origin}/auth/github/callback` },
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
      const body = (await request.json().catch(() => null)) as { token?: string; exitCode?: number; stdout?: string; stderr?: string; durationMs?: number; timedOut?: boolean } | null;
      if (!body?.token || body.exitCode === undefined || body.stdout === undefined || body.durationMs === undefined) {
        return json({ ok: false, error: "token, exitCode, stdout, and durationMs are required" }, 400);
      }
      const deps = agentApiDepsFromEnv(env);
      const result = await handleResult({ token: body.token, exitCode: body.exitCode, stdout: body.stdout, stderr: body.stderr, durationMs: body.durationMs, timedOut: body.timedOut }, deps);
      if (!result.ok) return json(result, 401);

      // Part 9/26: request real teardown right after a genuine (non-duplicate) completion - R1's own
      // "one job per runner" model means completion IS the natural termination trigger, not a separate
      // later sweep. A duplicate result (already torn down by the first call) skips this safely.
      //
      // Deliberately run in ctx.waitUntil(), NOT awaited inline before responding - found via a real,
      // preserved first-run bug (R1 Part 26): the runner container's own curl call back to /result can
      // be torn down (by the Sandbox exec() timeout, or the container simply exiting right after firing
      // the request) before it ever reads OUR response, and an inline await here left a runner
      // genuinely stuck at 'terminating' with no 'terminated_at' when that happened - the request
      // handler's own execution was cut short along with the now-gone client connection. ctx.waitUntil()
      // guarantees this completes regardless of whether the calling container is still around to see it.
      if (!result.data?.duplicate) {
        const runnerId = result.data!.runnerId;
        ctx.waitUntil(
          (async () => {
            const runner = await deps.runnerStore.getRunner(runnerId);
            if (runner?.providerRunnerId && runner.status === "completed") {
              const provider = asyncRunnerProviderFromEnv(env);
              if (provider) {
                await deps.runnerStore.transitionRunnerStatus(runner.id, "terminating");
                await provider.terminateRunner(runner.providerRunnerId);
                await deps.runnerStore.transitionRunnerStatus(runner.id, "terminated");
                await store.recordAuditEvent({ organizationId: runner.organizationId, action: "runner.terminated", targetType: "runner", targetId: runner.id });
              }
            }
          })().catch((err) => logEvent("runner.termination_failed", { runnerId, error: err instanceof Error ? err.message : String(err) })),
        );
      }
      return json(result, 200);
    }

    // --- Ingest (Phase 03) ------------------------------------------------------------------------
    // The only write path here reachable by a machine in someone else's infrastructure. Authenticated
    // by an ingest token, NOT by a session: there is no human, no cookie and no CSRF token in a CI job.
    // Everything about which organization this belongs to comes from the credential; nothing comes from
    // the payload (see src/ingest/ingest.ts).
    if (request.method === "POST" && url.pathname === "/v1/ingest/observations") {
      const declaredLength = Number(request.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > MAX_REPORT_BYTES) {
        // Refused on the declared length so an oversized body is never read into memory at all.
        return json({ ok: false, rejection: "payload_too_large", error: `Report exceeds the ${MAX_REPORT_BYTES}-byte limit.` }, 413);
      }
      const body = await request.text();
      const result = await ingestObservation(
        { authorization: request.headers.get("authorization"), body },
        { tokenStore: ingestTokenStore, observationStore, productStore: store, usageStore },
      );
      if (!result.ok) {
        logEvent("ingest.rejected", { rejection: result.rejection });
        return json({ ok: false, rejection: result.rejection, error: result.message }, ingestRejectionStatus(result.rejection));
      }
      logEvent("ingest.accepted", { duplicate: result.duplicate, status: result.record.status, organizationId: result.record.organizationId });
      return json(
        { ok: true, duplicate: result.duplicate, observationId: result.record.id, receivedAt: result.record.receivedAt },
        result.duplicate ? 200 : 201,
      );
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
        // One policy, stated once (see billing/repository-admission.ts). This path is "manual": the
        // repository id came out of a request body and nothing outside DiffCI vouches for it, so it is
        // held to the plan limit even during early access.
        const admission = decideRepositoryAdmission({ entitlements, currentRepositoryCount: currentCount, source: "manual", earlyAccess: EARLY_ACCESS_ENABLED });
        if (!admission.admit) {
          return json({ ok: false, error: "repository limit reached for current plan", maxRepositories: admission.maxRepositories }, 402);
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
        const outcome = await getSavingsSummaryForOrganization(await routeDepsWithSavings(), userId, organizationId, ownerName);
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
        // R2 Part 3: structured, never a bare shell string - the fixed, DiffCI-only synthetic step,
        // policy-valid by construction (node is allowlisted, the array form goes through
        // command-policy.ts's own validateCommand() again inside handleClaim before ever being served).
        const syntheticSteps: ClaimStep[] = [{ executable: "node", args: ["-e", "console.log('diffci-runner-ok')"] }];
        const item = await queueStore.enqueue({ organizationId, jobReference: JSON.stringify(syntheticSteps), requestedResourceClass: "lite" });
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
          // batchLimit high enough that THIS request's own newly-enqueued item is never starved by an
          // older still-queued item ahead of it in (priority, createdAt) order - found via a real,
          // preserved first-attempt failure (R1 Part 26) where a stuck retrying item silently absorbed
          // every subsequent request's single scheduling slot, and the real error was never surfaced.
          20,
        );
        const outcome = outcomes.find((o) => o.queueItemId === item.id);
        if (outcome?.outcome === "provisioning_failed") logEvent("runner.job_provisioning_failed", { queueItemId: item.id, runnerId: outcome.runnerId, error: outcome.error });
        return json({ ok: true, queueItemId: item.id, runnerId: outcome?.runnerId, outcome: outcome?.outcome, error: outcome?.error }, 202);
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

      // --- Ingest credentials, install instructions and stored observations (Phase 03) ------------
      // Every one of these goes through src/ingest/routes.ts, which checks membership AND that the
      // repository named belongs to this organization. Mutating ones additionally require CSRF, the
      // same as every other state-changing route in this Worker.
      const ingestTokenIssueMatch = subPath.match(/^\/repositories\/([^/]+)\/ingest-tokens$/);
      if (request.method === "POST" && ingestTokenIssueMatch) {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const body = (await request.json().catch(() => null)) as { name?: string; ttlMs?: number } | null;
        const outcome = await issueIngestTokenForRepository(ingestDeps, userId, organizationId, ingestTokenIssueMatch[1]!, {
          name: body?.name,
          ttlMs: typeof body?.ttlMs === "number" ? body.ttlMs : undefined,
        });
        if (!outcome.ok) return json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
        // The only response in this Worker that carries a live credential. It is returned once, is
        // never stored in raw form, and cannot be read back by any route.
        return json({ ok: true, token: outcome.data.token, tokenRecord: outcome.data.record, install: outcome.data.install }, 201);
      }

      const installMatch = subPath.match(/^\/repositories\/([^/]+)\/install$/);
      if (request.method === "GET" && installMatch) {
        const outcome = await getInstallInstructionsForRepository(ingestDeps, userId, organizationId, installMatch[1]!);
        return outcome.ok ? json({ ok: true, install: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/ingest-tokens") {
        const outcome = await listIngestTokensForOrganization(ingestDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, tokens: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const ingestTokenMatch = subPath.match(/^\/ingest-tokens\/([^/]+)$/);
      if (request.method === "DELETE" && ingestTokenMatch) {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const outcome = await revokeIngestToken(ingestDeps, userId, organizationId, ingestTokenMatch[1]!);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      // --- Metered invoices (Phase 05) -----------------------------------------------------------
      if (request.method === "GET" && subPath === "/invoices") {
        const outcome = await listInvoicesForOrganization(invoiceDeps, userId, organizationId);
        return outcome.ok ? json({ ok: true, invoices: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      // Prepares the month's invoice, or returns the one that already exists. Never re-prices.
      if (request.method === "POST" && subPath === "/invoices") {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const body = (await request.json().catch(() => null)) as { month?: string } | null;
        const outcome = await prepareInvoiceForMonth(invoiceDeps, userId, organizationId, body?.month ?? currentMonth());
        return outcome.ok
          ? json({ ok: true, invoice: outcome.data.invoice, created: outcome.data.created }, outcome.data.created ? 201 : 200)
          : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const invoiceMatch = subPath.match(/^\/invoices\/([^/]+)$/);
      if (request.method === "GET" && invoiceMatch) {
        const outcome = await getInvoiceForOrganization(invoiceDeps, userId, organizationId, invoiceMatch[1]!);
        return outcome.ok ? json({ ok: true, invoice: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      // Recomputes the invoice from today's ledger, line by line. Open to any member on purpose: the
      // customer checking the bill is the reason this endpoint exists.
      const reconcileMatch = subPath.match(/^\/invoices\/([^/]+)\/reconcile$/);
      if (request.method === "GET" && reconcileMatch) {
        const outcome = await reconcileInvoiceForOrganization(invoiceDeps, userId, organizationId, reconcileMatch[1]!);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const issueMatch = subPath.match(/^\/invoices\/([^/]+)\/issue$/);
      if (request.method === "POST" && issueMatch) {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const outcome = await issueInvoice(invoiceDeps, userId, organizationId, issueMatch[1]!);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const payMatch = subPath.match(/^\/invoices\/([^/]+)\/paid$/);
      if (request.method === "POST" && payMatch) {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const body = (await request.json().catch(() => null)) as { reference?: string } | null;
        if (!body?.reference) return json({ ok: false, error: "a payment reference is required - something that proves this was paid" }, 400);
        const outcome = await markInvoicePaid(invoiceDeps, userId, organizationId, payMatch[1]!, body.reference);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const voidMatch = subPath.match(/^\/invoices\/([^/]+)\/void$/);
      if (request.method === "POST" && voidMatch) {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const outcome = await voidInvoiceForOrganization(invoiceDeps, userId, organizationId, voidMatch[1]!);
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      // Phase 04: the month, as JSON. Same data the console's ledger page renders.
      if (request.method === "GET" && subPath === "/ledger") {
        const outcome = await getMonthlyLedgerForOrganization(ledgerDeps, userId, organizationId, url.searchParams.get("month") ?? currentMonth());
        return outcome.ok ? json({ ok: true, ledger: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/observations") {
        const outcome = await listObservationsForOrganization(ingestDeps, userId, organizationId, {
          limit: url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : undefined,
          since: url.searchParams.get("since") ?? undefined,
          repositoryId: url.searchParams.get("repositoryId") ?? undefined,
        });
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      const observationMatch = subPath.match(/^\/observations\/([^/]+)$/);
      if (request.method === "GET" && observationMatch) {
        const outcome = await getObservationForOrganization(ingestDeps, userId, organizationId, observationMatch[1]!);
        return outcome.ok ? json({ ok: true, observation: outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      // Erasure on request - site/data-handling.html's "ask, and it goes sooner", as a route.
      if (request.method === "DELETE" && subPath === "/observations") {
        if (!(await requireCsrf(request, env, principal))) return json({ ok: false, error: "csrf_invalid" }, 403);
        const outcome = await deleteObservationsForOrganization(ingestDeps, userId, organizationId, {
          repositoryId: url.searchParams.get("repositoryId") ?? undefined,
        });
        return outcome.ok ? json({ ok: true, ...outcome.data }) : json({ ok: false, error: outcome.error }, outcomeStatus(outcome.error));
      }

      if (request.method === "GET" && subPath === "/dashboard") {
        const outcome = await getDashboardForOrganization(await routeDepsWithSavings(), userId, organizationId);
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

    // 2026-08-23: real duration-observation capture, same cron trigger, own bounded batch. Reads Stage 2F
    // predictions ONLY through the existing read-only ShadowReadBoundary (Part 20 - no new SQL against
    // shadow_predictions/shadow_ground_truth, no write path touched), independently re-fetches real
    // GitHub job timing (unauthenticated - no token configured for this Worker today), and writes only to
    // the separate, additive ci_duration_observations table. maxPerSweep=5 keeps this comfortably under
    // GitHub's unauthenticated 60 req/hour/IP limit even at the existing */10-minute cron cadence.
    try {
      const store = makeD1ProductStore(env.PRODUCT_DB);
      const shadowBoundary = makeD1ShadowReadBoundary(env.RESEARCH_DB);
      const durationStore = makeD1DurationObservationStore(env.PRODUCT_DB);
      const repositories = (await store.listAllRepositories(50)).map((r) => r.ownerName);
      const windowEnd = new Date();
      const windowStart = new Date(windowEnd.getTime() - 30 * 24 * 60 * 60 * 1000); // last 30 days - a rolling window, not the repository's whole history
      const captureResult = await runDurationCaptureSweep({ shadowBoundary, store: durationStore }, repositories, windowStart.toISOString(), windowEnd.toISOString(), 5);
      logEvent("duration_capture.sweep_completed", { ...captureResult });
    } catch (err) {
      // Never let a duration-capture failure affect orphan cleanup's own success/failure signal above -
      // this sweep is purely additive telemetry, not safety-critical.
      logEvent("duration_capture.sweep_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // Phase 03 retention sweep. site/data-handling.html promises "90 days maximum, regardless" and
    // carries a banner saying the page must not be published because the automated deletion path does
    // not exist. For observations, it now does, and it runs on this same cron rather than depending on
    // a webhook, a session, or anyone remembering. Wrapped so a failure here cannot affect the sweeps
    // above - but logged loudly, because a retention sweep that silently stops running is a broken
    // public commitment, not a missing metric.
    try {
      const result = await runRetentionSweep(makeD1ObservationStore(env.PRODUCT_DB));
      logEvent("observations.retention_sweep_completed", { ...result });
    } catch (err) {
      logEvent("observations.retention_sweep_failed", { error: err instanceof Error ? err.message : String(err) });
    }

    // NOTE (2026-08-25): shadow-economics capture deliberately does NOT run here. It briefly did, and
    // failed live on every single commit - this Worker holds no GitHub credential (only
    // RUNNER_CONTROL_TOKEN), so its GitHub reads were unauthenticated: 60 req/hour against a Cloudflare
    // egress IP shared across tenants. The sweep now runs in the research-sandbox Worker, which already
    // owns GITHUB_TOKEN and the Shadow App keys, and writes to shadow_economics_observations in
    // diffci-research (see src/research/cloudflare/schema-migration-2026-08-25-shadow-economics.sql).
    // Copying the App private key into this internet-facing Worker was considered and rejected: it can
    // mint tokens for every installed repository. The product layer reads that table through the
    // existing read-only ShadowReadBoundary, never by writing to diffci-research itself.
  },
};
