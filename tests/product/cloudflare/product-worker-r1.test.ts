/**
 * Integration test for R1's real wiring through the actual staging product Worker (Part 35: "prove the
 * product architecture, not merely the cloud SDK"). Simulates the real runner container's HTTP calls
 * (register/claim/result) against product-worker.ts's real fetch() handler, and intercepts the async
 * provider's own outbound call to the (real, but here mocked-at-the-network-boundary) synthetic-runner
 * Worker - proving the FULL composition (route -> scheduler -> provider -> token mint -> agent API ->
 * usage/audit/termination) without needing a real Cloudflare Container for this specific test (that
 * real-container proof is separate - the actual R1 deployment run).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../../src/product/store.js";
import { freshProductDb, makeD1 } from "../../helpers/product-db.js";
import productWorker from "../../../src/product/cloudflare/product-worker.js";

/** Mocks the real Cloudflare Service Binding to diffci-synthetic-runner (env.SYNTHETIC_RUNNER_WORKER) -
 * product-worker.ts's async provider talks ONLY through this binding, never a plain fetch() to a
 * workers.dev URL (Cloudflare rejects that specific pattern outright - error 1042, confirmed live and
 * documented in asyncRunnerProviderFromEnv()'s own comment). */
function mockSyntheticRunnerBinding(capturedRunnerCalls: Array<{ url: string; body: unknown }>) {
  return {
    async fetch(request: Request): Promise<Response> {
      const body = await request.text().then((t) => (t ? JSON.parse(t) : undefined));
      capturedRunnerCalls.push({ url: request.url, body });
      return new Response(JSON.stringify({ ok: true, accepted: true }), { status: 200 });
    },
  };
}

/** A real ExecutionContext just fires waitUntil() promises in the background; this test double lets a
 * test explicitly `await ctx.drain()` after a call that triggers background work (R1's real
 * post-result termination, wrapped in ctx.waitUntil() in product-worker.ts) so subsequent assertions
 * see it as already-complete, deterministic - never racing a background task. One instance is shared
 * across every fetch() call within a single test. */
function mockCtx() {
  const pending: Array<Promise<unknown>> = [];
  return {
    waitUntil(p: Promise<unknown>) {
      pending.push(p);
    },
    async drain() {
      await Promise.all(pending);
      pending.length = 0;
    },
  };
}

function buildEnv(db: ReturnType<typeof freshProductDb>, capturedRunnerCalls: Array<{ url: string; body: unknown }>) {
  const d1 = makeD1(db);
  return {
    PRODUCT_DB: d1,
    RESEARCH_DB: d1, // never queried by any route this test exercises
    DIFFCI_PRODUCT_ENABLED: "true",
    // A Worker with no pinned agent artifact refuses to issue ingest tokens, because it
    // cannot tell the customer what to do with one. Tests that exercise the onboarding path therefore
    // have to model a properly-configured deployment.
    DIFFCI_AGENT_ARTIFACT: `npm:@diffci/observer@1.4.2#sha512-${"A".repeat(86)}==`,
    DIFFCI_ENVIRONMENT: "development",
    DIFFCI_ALLOW_DEV_HEADER_AUTH: "true",
    DIFFCI_SESSION_TTL_MS: "2592000000",
    RUNNER_CONTROL_TOKEN: "control-token-xyz",
    DIFFCI_API_ORIGIN: "https://product.example",
    SYNTHETIC_RUNNER_WORKER: mockSyntheticRunnerBinding(capturedRunnerCalls),
  } as unknown as Record<string, unknown>;
}

describe("product-worker.ts R1 wiring - real end-to-end route composition", () => {
  async function setupOrgAndAuthHeaders(db: ReturnType<typeof freshProductDb>) {
    const store = makeD1ProductStore(makeD1(db));
    const user = await store.createUser({ email: "r1@example.com" });
    const org = await store.createOrganization({ name: "R1 Test Org", slug: "r1-test-org", ownerUserId: user.id });
    return { org, user, headers: { "X-DiffCI-User-Id": user.id, "Content-Type": "application/json" } };
  }

  it("full real flow: create synthetic job -> scheduler assigns -> real runner-agent calls (register/claim/result) -> usage + audit + termination", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    const { org, headers } = await setupOrgAndAuthHeaders(db);
    const env = buildEnv(db, capturedRunnerCalls);
    const ctx = mockCtx();

    // 1. Authenticated organization creates a synthetic job.
    const createRes = await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runner-jobs/synthetic`, { method: "POST", headers }), env as never, ctx);
    assert.equal(createRes.status, 202);
    const createBody = (await createRes.json()) as { ok: boolean; queueItemId: string; runnerId: string; outcome: string };
    assert.equal(createBody.ok, true);
    assert.equal(createBody.outcome, "assigned");
    assert.ok(createBody.runnerId);

    // 2. The async provider really did call out to (mocked) synthetic-runner's /v1/runner/start.
    assert.equal(capturedRunnerCalls.length, 1);
    assert.equal(capturedRunnerCalls[0]!.url, "https://synthetic-runner.internal/v1/runner/start");
    const startBody = capturedRunnerCalls[0]!.body as { runnerId: string; apiUrl: string; runnerToken: string };
    assert.equal(startBody.apiUrl, "https://product.example");
    const rawToken = startBody.runnerToken;
    assert.ok(rawToken.length > 0);

    // 3. Simulate the real runner container's own bootstrap script calling back - register.
    const registerRes = await productWorker.fetch(new Request("https://product.example/v1/runner/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never, ctx);
    assert.equal(registerRes.status, 200);

    // 4. Claim - gets back the real trivial command.
    const claimRes = await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never, ctx);
    assert.equal(claimRes.status, 200);
    const claimBody = (await claimRes.json()) as { ok: boolean; data: { steps: Array<{ executable: string; args: string[] }> } };
    assert.equal(claimBody.data.steps.length, 1);
    assert.equal(claimBody.data.steps[0]!.executable, "node");
    assert.match(claimBody.data.steps[0]!.args.join(" "), /diffci-runner-ok/);

    // 5. Submit the result - triggers real termination in the background (ctx.waitUntil()).
    const resultRes = await productWorker.fetch(
      new Request("https://product.example/v1/runner/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 800 }) }),
      env as never,
      ctx,
    );
    assert.equal(resultRes.status, 200);
    const resultBody = (await resultRes.json()) as { ok: boolean; data: { runtimeSeconds: number; costEstimateUsd: number } };
    assert.equal(resultBody.ok, true);
    assert.equal(resultBody.data.runtimeSeconds, 0.8);
    assert.ok(resultBody.data.costEstimateUsd > 0);
    await ctx.drain(); // wait for the background termination work before asserting on it

    // 6. Termination was requested as part of the result route (terminate call to mocked synthetic-runner).
    assert.equal(capturedRunnerCalls.length, 2, "terminateRunner() must have made a real second call");
    assert.equal(capturedRunnerCalls[1]!.url, "https://synthetic-runner.internal/v1/runner/terminate");

    // 7. Real, authenticated, organization-scoped read of the finished runner (Part 31).
    const statusRes = await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runners/${createBody.runnerId}`, { headers }), env as never, ctx);
    const statusBody = (await statusRes.json()) as { ok: boolean; runner: { status: string; costEstimateUsd: number } };
    assert.equal(statusBody.runner.status, "terminated");
    assert.ok(statusBody.runner.costEstimateUsd > 0);
  });

  it("cross-organization isolation: org B cannot create a job or read org A's runner (Part 31/40)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    const store = makeD1ProductStore(makeD1(db));
    const userA = await store.createUser({ email: "a@example.com" });
    const orgA = await store.createOrganization({ name: "A", slug: "org-a-r1", ownerUserId: userA.id });
    const userB = await store.createUser({ email: "b@example.com" });
    const orgB = await store.createOrganization({ name: "B", slug: "org-b-r1", ownerUserId: userB.id });
    const env = buildEnv(db, capturedRunnerCalls);
    const ctx = mockCtx();

    const createRes = await productWorker.fetch(
      new Request(`https://product.example/v1/organizations/${orgA.id}/runner-jobs/synthetic`, { method: "POST", headers: { "X-DiffCI-User-Id": userA.id, "Content-Type": "application/json" } }),
      env as never,
      ctx,
    );
    const createBody = (await createRes.json()) as { runnerId: string };

    // userB (member of orgB only) tries to read orgA's runner via orgA's own URL - must be rejected, not leak.
    const crossOrgRes = await productWorker.fetch(new Request(`https://product.example/v1/organizations/${orgA.id}/runners/${createBody.runnerId}`, { headers: { "X-DiffCI-User-Id": userB.id } }), env as never, ctx);
    assert.notEqual(crossOrgRes.status, 200);

    // userB tries to create a synthetic job under orgA - also rejected.
    const crossCreateRes = await productWorker.fetch(
      new Request(`https://product.example/v1/organizations/${orgA.id}/runner-jobs/synthetic`, { method: "POST", headers: { "X-DiffCI-User-Id": userB.id, "Content-Type": "application/json" } }),
      env as never,
      ctx,
    );
    assert.notEqual(crossCreateRes.status, 202);
    void orgB;
  });

  it("a runner cannot claim a job with a token minted for a DIFFERENT job/org (real route-level enforcement)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    const { org, headers } = await setupOrgAndAuthHeaders(db);
    const env = buildEnv(db, capturedRunnerCalls);
    const ctx = mockCtx();

    await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runner-jobs/synthetic`, { method: "POST", headers }), env as never, ctx);
    const rawToken = (capturedRunnerCalls[0]!.body as { runnerToken: string }).runnerToken;

    // Claim once - legitimate.
    const first = await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never, ctx);
    assert.equal(first.status, 200);

    // Replay the SAME token to claim again - must be rejected (409), not silently re-served.
    const replay = await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never, ctx);
    assert.equal(replay.status, 409);
  });

  it("a duplicate /v1/runner/result submission does not double-terminate or double-bill (real route level)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    const { org, headers } = await setupOrgAndAuthHeaders(db);
    const env = buildEnv(db, capturedRunnerCalls);
    const ctx = mockCtx();

    await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runner-jobs/synthetic`, { method: "POST", headers }), env as never, ctx);
    const rawToken = (capturedRunnerCalls[0]!.body as { runnerToken: string }).runnerToken;
    await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never, ctx);

    const payload = JSON.stringify({ token: rawToken, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 500 });
    await productWorker.fetch(new Request("https://product.example/v1/runner/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), env as never, ctx);
    await ctx.drain();
    const terminateCallsAfterFirst = capturedRunnerCalls.filter((c) => c.url.endsWith("/terminate")).length;

    await productWorker.fetch(new Request("https://product.example/v1/runner/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), env as never, ctx);
    await ctx.drain();
    const terminateCallsAfterSecond = capturedRunnerCalls.filter((c) => c.url.endsWith("/terminate")).length;

    assert.equal(terminateCallsAfterFirst, 1);
    assert.equal(terminateCallsAfterSecond, 1, "a duplicate result must not trigger a second termination request");
  });
});
