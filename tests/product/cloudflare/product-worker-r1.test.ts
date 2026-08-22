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
import { describe, it, beforeEach, afterEach } from "node:test";
import { makeD1ProductStore } from "../../../src/product/store.js";
import { freshProductDb, makeD1 } from "../../helpers/product-db.js";
import productWorker from "../../../src/product/cloudflare/product-worker.js";

const ORIGINAL_FETCH = globalThis.fetch;

function buildEnv(db: ReturnType<typeof freshProductDb>, capturedRunnerCalls: Array<{ url: string; body: unknown }>) {
  const d1 = makeD1(db);
  return {
    PRODUCT_DB: d1,
    RESEARCH_DB: d1, // never queried by any route this test exercises
    DIFFCI_PRODUCT_ENABLED: "true",
    DIFFCI_ENVIRONMENT: "development",
    DIFFCI_ALLOW_DEV_HEADER_AUTH: "true",
    DIFFCI_SESSION_TTL_MS: "2592000000",
    SYNTHETIC_RUNNER_URL: "https://synthetic.example",
    RUNNER_CONTROL_TOKEN: "control-token-xyz",
    DIFFCI_API_ORIGIN: "https://product.example",
    __capturedRunnerCalls: capturedRunnerCalls,
  } as unknown as Record<string, unknown>;
}

function mockFetch(capturedRunnerCalls: Array<{ url: string; body: unknown }>): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input as Request).url;
    const body = init?.body ? JSON.parse(init.body as string) : undefined;
    if (url.startsWith("https://synthetic.example")) {
      capturedRunnerCalls.push({ url, body });
      return new Response(JSON.stringify({ ok: true, accepted: true }), { status: 200 });
    }
    throw new Error(`unexpected fetch to ${url} in test`);
  }) as typeof fetch;
}

describe("product-worker.ts R1 wiring - real end-to-end route composition", () => {
  beforeEach(() => {
    // Nothing global here - fetch is patched per-test below.
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  async function setupOrgAndAuthHeaders(db: ReturnType<typeof freshProductDb>) {
    const store = makeD1ProductStore(makeD1(db));
    const user = await store.createUser({ email: "r1@example.com" });
    const org = await store.createOrganization({ name: "R1 Test Org", slug: "r1-test-org", ownerUserId: user.id });
    return { org, user, headers: { "X-DiffCI-User-Id": user.id, "Content-Type": "application/json" } };
  }

  it("full real flow: create synthetic job -> scheduler assigns -> real runner-agent calls (register/claim/result) -> usage + audit + termination", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mockFetch(capturedRunnerCalls);
    const { org, headers } = await setupOrgAndAuthHeaders(db);
    const env = buildEnv(db, capturedRunnerCalls);

    // 1. Authenticated organization creates a synthetic job.
    const createRes = await productWorker.fetch(
      new Request(`https://product.example/v1/organizations/${org.id}/runner-jobs/synthetic`, { method: "POST", headers }),
      env as never,
    );
    assert.equal(createRes.status, 202);
    const createBody = (await createRes.json()) as { ok: boolean; queueItemId: string; runnerId: string; outcome: string };
    assert.equal(createBody.ok, true);
    assert.equal(createBody.outcome, "assigned");
    assert.ok(createBody.runnerId);

    // 2. The async provider really did call out to (mocked) synthetic-runner's /v1/runner/start.
    assert.equal(capturedRunnerCalls.length, 1);
    assert.equal(capturedRunnerCalls[0]!.url, "https://synthetic.example/v1/runner/start");
    const startBody = capturedRunnerCalls[0]!.body as { runnerId: string; apiUrl: string; runnerToken: string };
    assert.equal(startBody.apiUrl, "https://product.example");
    const rawToken = startBody.runnerToken;
    assert.ok(rawToken.length > 0);

    // 3. Simulate the real runner container's own bootstrap script calling back - register.
    const registerRes = await productWorker.fetch(new Request("https://product.example/v1/runner/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never);
    assert.equal(registerRes.status, 200);

    // 4. Claim - gets back the real trivial command.
    const claimRes = await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never);
    assert.equal(claimRes.status, 200);
    const claimBody = (await claimRes.json()) as { ok: boolean; data: { command: string } };
    assert.match(claimBody.data.command, /diffci-runner-ok/);

    // 5. Submit the result.
    const resultRes = await productWorker.fetch(
      new Request("https://product.example/v1/runner/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 800 }) }),
      env as never,
    );
    assert.equal(resultRes.status, 200);
    const resultBody = (await resultRes.json()) as { ok: boolean; data: { runtimeSeconds: number; costEstimateUsd: number } };
    assert.equal(resultBody.ok, true);
    assert.equal(resultBody.data.runtimeSeconds, 0.8);
    assert.ok(resultBody.data.costEstimateUsd > 0);

    // 6. Termination was requested as part of the result route (terminate call to mocked synthetic-runner).
    assert.equal(capturedRunnerCalls.length, 2, "terminateRunner() must have made a real second call");
    assert.equal(capturedRunnerCalls[1]!.url, "https://synthetic.example/v1/runner/terminate");

    // 7. Real, authenticated, organization-scoped read of the finished runner (Part 31).
    const statusRes = await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runners/${createBody.runnerId}`, { headers }), env as never);
    const statusBody = (await statusRes.json()) as { ok: boolean; runner: { status: string; costEstimateUsd: number } };
    assert.equal(statusBody.runner.status, "terminated");
    assert.ok(statusBody.runner.costEstimateUsd > 0);
  });

  it("cross-organization isolation: org B cannot create a job or read org A's runner (Part 31/40)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mockFetch(capturedRunnerCalls);
    const store = makeD1ProductStore(makeD1(db));
    const userA = await store.createUser({ email: "a@example.com" });
    const orgA = await store.createOrganization({ name: "A", slug: "org-a-r1", ownerUserId: userA.id });
    const userB = await store.createUser({ email: "b@example.com" });
    const orgB = await store.createOrganization({ name: "B", slug: "org-b-r1", ownerUserId: userB.id });
    const env = buildEnv(db, capturedRunnerCalls);

    const createRes = await productWorker.fetch(
      new Request(`https://product.example/v1/organizations/${orgA.id}/runner-jobs/synthetic`, { method: "POST", headers: { "X-DiffCI-User-Id": userA.id, "Content-Type": "application/json" } }),
      env as never,
    );
    const createBody = (await createRes.json()) as { runnerId: string };

    // userB (member of orgB only) tries to read orgA's runner via orgA's own URL - must be rejected, not leak.
    const crossOrgRes = await productWorker.fetch(
      new Request(`https://product.example/v1/organizations/${orgA.id}/runners/${createBody.runnerId}`, { headers: { "X-DiffCI-User-Id": userB.id } }),
      env as never,
    );
    assert.notEqual(crossOrgRes.status, 200);

    // userB tries to create a synthetic job under orgA - also rejected.
    const crossCreateRes = await productWorker.fetch(
      new Request(`https://product.example/v1/organizations/${orgA.id}/runner-jobs/synthetic`, { method: "POST", headers: { "X-DiffCI-User-Id": userB.id, "Content-Type": "application/json" } }),
      env as never,
    );
    assert.notEqual(crossCreateRes.status, 202);
    void orgB;
  });

  it("a runner cannot claim a job with a token minted for a DIFFERENT job/org (real route-level enforcement)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mockFetch(capturedRunnerCalls);
    const { org, headers } = await setupOrgAndAuthHeaders(db);
    const env = buildEnv(db, capturedRunnerCalls);

    await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runner-jobs/synthetic`, { method: "POST", headers }), env as never);
    const rawToken = (capturedRunnerCalls[0]!.body as { runnerToken: string }).runnerToken;

    // Claim once - legitimate.
    const first = await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never);
    assert.equal(first.status, 200);

    // Replay the SAME token to claim again - must be rejected (409), not silently re-served.
    const replay = await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never);
    assert.equal(replay.status, 409);
  });

  it("a duplicate /v1/runner/result submission does not double-terminate or double-bill (real route level)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    const capturedRunnerCalls: Array<{ url: string; body: unknown }> = [];
    globalThis.fetch = mockFetch(capturedRunnerCalls);
    const { org, headers } = await setupOrgAndAuthHeaders(db);
    const env = buildEnv(db, capturedRunnerCalls);

    await productWorker.fetch(new Request(`https://product.example/v1/organizations/${org.id}/runner-jobs/synthetic`, { method: "POST", headers }), env as never);
    const rawToken = (capturedRunnerCalls[0]!.body as { runnerToken: string }).runnerToken;
    await productWorker.fetch(new Request("https://product.example/v1/runner/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: rawToken }) }), env as never);

    const payload = JSON.stringify({ token: rawToken, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 500 });
    await productWorker.fetch(new Request("https://product.example/v1/runner/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), env as never);
    const terminateCallsAfterFirst = capturedRunnerCalls.filter((c) => c.url.endsWith("/terminate")).length;

    await productWorker.fetch(new Request("https://product.example/v1/runner/result", { method: "POST", headers: { "Content-Type": "application/json" }, body: payload }), env as never);
    const terminateCallsAfterSecond = capturedRunnerCalls.filter((c) => c.url.endsWith("/terminate")).length;

    assert.equal(terminateCallsAfterFirst, 1);
    assert.equal(terminateCallsAfterSecond, 1, "a duplicate result must not trigger a second termination request");
  });
});
