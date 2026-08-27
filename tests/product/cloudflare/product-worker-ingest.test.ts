/**
 * Phase 03 (2026-08-26): the whole self-serve loop, through the real Worker.
 *
 * The unit tests around it cover each piece; this one is here because the pieces are only worth
 * anything composed: someone signs in, connects a repository, is handed a workflow and a credential,
 * their CI posts a report with that credential, and they can then read it back - and nobody else can.
 * Every step below is an HTTP call against product-worker.ts's real fetch() handler, with the real
 * schema behind it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeD1ProductStore } from "../../../src/product/store.js";
import { freshProductDb, makeD1 } from "../../helpers/product-db.js";
import { makeReport } from "../../ingest/report-fixture.js";
import productWorker from "../../../src/product/cloudflare/product-worker.js";

const ORIGIN = "https://product.example";
const TEST_INTEGRITY = `sha512-${"A".repeat(86)}==`;
const PINNED_AGENT = `npm:@diffci/observer@1.4.2#${TEST_INTEGRITY}`;

function buildEnv(db: ReturnType<typeof freshProductDb>) {
  const d1 = makeD1(db);
  return {
    PRODUCT_DB: d1,
    RESEARCH_DB: d1, // never queried by any route this test exercises
    DIFFCI_PRODUCT_ENABLED: "true",
    DIFFCI_ENVIRONMENT: "development",
    DIFFCI_ALLOW_DEV_HEADER_AUTH: "true",
    DIFFCI_SESSION_TTL_MS: "2592000000",
    DIFFCI_API_ORIGIN: ORIGIN,
    DIFFCI_AGENT_ARTIFACT: PINNED_AGENT,
    // Present so the console renders its real signed-out state. No OAuth call is made by any test here.
    GITHUB_OAUTH_CLIENT_ID: "test-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "test-client-secret",
  } as unknown as Record<string, unknown>;
}

const ctx = { waitUntil() {} };

async function call(env: Record<string, unknown>, method: string, path: string, options: { headers?: Record<string, string>; body?: unknown; token?: string } = {}) {
  const headers: Record<string, string> = { "Content-Type": "application/json", ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await productWorker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) }),
    env as never,
    ctx as never,
  );
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function tenant(db: ReturnType<typeof freshProductDb>, seed: { email: string; slug: string }) {
  const store = makeD1ProductStore(makeD1(db));
  const user = await store.createUser({ email: seed.email });
  const org = await store.createOrganization({ name: seed.slug, slug: seed.slug, ownerUserId: user.id });
  return { user, org, headers: { "X-DiffCI-User-Id": user.id } };
}

describe("product-worker.ts - self-serve install, ingest, and isolation", () => {
  it("a stranger connects a repository, is handed an installation, and their CI's report lands and is readable", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });

    // 1. Connect the repository. Nothing here is DiffCI-side work: no App install, no human.
    const connected = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, {
      headers: acme.headers,
      body: { providerRepositoryId: "111", ownerName: "acme/checkout", defaultBranch: "main" },
    });
    assert.equal(connected.status, 201);
    const repositoryId = (connected.body.repository as { id: string }).id;

    // 2. Ask what to install. This is the entire onboarding surface.
    const install = await call(env, "GET", `/v1/organizations/${acme.org.id}/repositories/${repositoryId}/install`, { headers: acme.headers });
    assert.equal(install.status, 200);
    const instructions = install.body.install as { workflowYaml: string; ingestUrl: string };
    assert.equal(instructions.ingestUrl, `${ORIGIN}/v1/ingest/observations`);
    assert.ok(instructions.workflowYaml.includes("@diffci/observer@1.4.2"));
    // B2 (2026-08-27): there is no `warning` field any longer. An unpinned ref does not produce
    // instructions-with-a-caveat; it produces no instructions at all. See the refusal test below.
    assert.equal(instructions.workflowYaml.includes("@main"), false);

    // 3. Mint a credential. Returned exactly once.
    const issued = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories/${repositoryId}/ingest-tokens`, {
      headers: acme.headers,
      body: { name: "acme/checkout CI" },
    });
    assert.equal(issued.status, 201);
    const token = issued.body.token as string;
    assert.ok(token.startsWith("dci_"));

    // The listing shows the credential exists without ever showing it again.
    const listedTokens = await call(env, "GET", `/v1/organizations/${acme.org.id}/ingest-tokens`, { headers: acme.headers });
    assert.equal(listedTokens.status, 200);
    assert.equal(JSON.stringify(listedTokens.body).includes(token), false, "a listing must not return a live credential");

    // 4. Their CI posts a report. No session, no cookie - just the token.
    const posted = await call(env, "POST", "/v1/ingest/observations", { token, body: makeReport({ repository: { provider: "github", ownerName: "acme/checkout", providerRepositoryId: "111" } }) });
    assert.equal(posted.status, 201);
    assert.equal(posted.body.duplicate, false);

    // 5. The same report again - a re-run of the same attempt, or the client retrying.
    const again = await call(env, "POST", "/v1/ingest/observations", { token, body: makeReport({ repository: { provider: "github", ownerName: "acme/checkout", providerRepositoryId: "111" } }) });
    assert.equal(again.status, 200);
    assert.equal(again.body.duplicate, true);
    assert.equal(again.body.observationId, posted.body.observationId);

    // 6. They read it back.
    const observations = await call(env, "GET", `/v1/organizations/${acme.org.id}/observations`, { headers: acme.headers });
    assert.equal(observations.status, 200);
    const rows = observations.body.observations as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.repositoryId, repositoryId);
    assert.equal((observations.body.summary as { total: number }).total, 1);
  });

  it("refuses ingest without a credential, and with one belonging to another repository", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
    const other = await tenant(db, { email: "dev@other.test", slug: "other" });

    const acmeRepo = (await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, { headers: acme.headers, body: { providerRepositoryId: "111", ownerName: "acme/checkout" } })).body
      .repository as { id: string };
    await call(env, "POST", `/v1/organizations/${other.org.id}/repositories`, { headers: other.headers, body: { providerRepositoryId: "222", ownerName: "other/app" } });
    const acmeToken = (await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories/${acmeRepo.id}/ingest-tokens`, { headers: acme.headers, body: {} })).body.token as string;

    const anonymous = await call(env, "POST", "/v1/ingest/observations", { body: makeReport() });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.rejection, "missing_token");

    // acme's credential, a report from the other repository: the copied-workflow case.
    const crossed = await call(env, "POST", "/v1/ingest/observations", {
      token: acmeToken,
      body: makeReport({ repository: { provider: "github", ownerName: "other/app", providerRepositoryId: "222" } }),
    });
    assert.equal(crossed.status, 403);
    assert.equal(crossed.body.rejection, "repository_mismatch");
  });

  it("one organization cannot read, mint for, or erase another's data through any route", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
    const other = await tenant(db, { email: "dev@other.test", slug: "other" });

    const otherRepo = (await call(env, "POST", `/v1/organizations/${other.org.id}/repositories`, { headers: other.headers, body: { providerRepositoryId: "222", ownerName: "other/app" } })).body
      .repository as { id: string };
    const otherToken = (await call(env, "POST", `/v1/organizations/${other.org.id}/repositories/${otherRepo.id}/ingest-tokens`, { headers: other.headers, body: {} })).body.token as string;
    await call(env, "POST", "/v1/ingest/observations", { token: otherToken, body: makeReport({ repository: { provider: "github", ownerName: "other/app", providerRepositoryId: "222" } }) });

    // Reading another organization's observations, by its real id.
    const read = await call(env, "GET", `/v1/organizations/${other.org.id}/observations`, { headers: acme.headers });
    assert.equal(read.status, 403);

    // Minting a credential for another organization's repository, from inside one's own organization.
    const mint = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories/${otherRepo.id}/ingest-tokens`, { headers: acme.headers, body: {} });
    assert.equal(mint.status, 404);

    // Erasing another organization's data.
    const erase = await call(env, "DELETE", `/v1/organizations/${other.org.id}/observations`, { headers: acme.headers });
    assert.equal(erase.status, 403);

    // Still there, and still theirs.
    const stillTheirs = await call(env, "GET", `/v1/organizations/${other.org.id}/observations`, { headers: other.headers });
    assert.equal((stillTheirs.body.summary as { total: number }).total, 1);
  });

  it("erases on request, which is what the data-handling page promises", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
    const repo = (await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, { headers: acme.headers, body: { providerRepositoryId: "111", ownerName: "acme/checkout" } })).body
      .repository as { id: string };
    const token = (await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories/${repo.id}/ingest-tokens`, { headers: acme.headers, body: {} })).body.token as string;
    await call(env, "POST", "/v1/ingest/observations", { token, body: makeReport({ repository: { provider: "github", ownerName: "acme/checkout", providerRepositoryId: "111" } }) });

    const deleted = await call(env, "DELETE", `/v1/organizations/${acme.org.id}/observations`, { headers: acme.headers });
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 1);

    const after = await call(env, "GET", `/v1/organizations/${acme.org.id}/observations`, { headers: acme.headers });
    assert.equal((after.body.summary as { total: number }).total, 0);
  });

  it("serves the console: signed out, signed in, and never another organization's pages", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
    const other = await tenant(db, { email: "dev@other.test", slug: "other" });

    async function page(path: string, headers?: Record<string, string>) {
      const response = await productWorker.fetch(new Request(`${ORIGIN}${path}`, { headers }), env as never, ctx as never);
      return { status: response.status, contentType: response.headers.get("content-type"), body: await response.text() };
    }

    // Signed out: the front door, not a 404 and not a JSON error.
    const signedOut = await page("/app");
    assert.equal(signedOut.status, 200);
    assert.match(signedOut.contentType ?? "", /text\/html/);
    assert.match(signedOut.body, /Sign in with GitHub/);

    // Signed in: their own organizations, and nobody else's.
    const home = await page("/app", acme.headers);
    assert.match(home.body, /acme/);
    assert.equal(home.body.includes(other.org.id), false);

    const repo = (await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, { headers: acme.headers, body: { providerRepositoryId: "111", ownerName: "acme/checkout" } })).body
      .repository as { id: string };

    const orgPage = await page(`/app/orgs/${acme.org.id}`, acme.headers);
    assert.equal(orgPage.status, 200);
    assert.match(orgPage.body, /acme\/checkout/);
    assert.match(orgPage.body, /Nothing received yet/);

    const repoPage = await page(`/app/orgs/${acme.org.id}/repos/${repo.id}`, acme.headers);
    assert.equal(repoPage.status, 200);
    assert.match(repoPage.body, /Create an ingest token/);
    assert.match(repoPage.body, /secrets.DIFFCI_TOKEN/);

    // Another organization's console pages are refused the same way its API is.
    assert.equal((await page(`/app/orgs/${other.org.id}`, acme.headers)).status, 403);
    assert.equal((await page(`/app/orgs/${other.org.id}/repos/${repo.id}`, acme.headers)).status, 403);
  });

  it("a revoked credential stops working immediately", async () => {
    const db = freshProductDb(["ingest", "usage"]);
    const env = buildEnv(db);
    const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
    const repo = (await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, { headers: acme.headers, body: { providerRepositoryId: "111", ownerName: "acme/checkout" } })).body
      .repository as { id: string };
    const issued = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories/${repo.id}/ingest-tokens`, { headers: acme.headers, body: {} });
    const token = issued.body.token as string;
    const tokenId = (issued.body.tokenRecord as { id: string }).id;

    const revoked = await call(env, "DELETE", `/v1/organizations/${acme.org.id}/ingest-tokens/${tokenId}`, { headers: acme.headers });
    assert.equal(revoked.status, 200);

    const rejected = await call(env, "POST", "/v1/ingest/observations", { token, body: makeReport({ repository: { provider: "github", ownerName: "acme/checkout", providerRepositoryId: "111" } }) });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.body.rejection, "revoked_token");
  });
});

/**
 * The pinned-agent invariant, asserted where a customer would actually hit it: through the Worker, over
 * HTTP.
 *
 * An earlier version of this Worker defaulted to a mutable branch ref when the artifact was unset, so
 * the DEFAULT deployment generated customer workflows naming something that could be repointed. The
 * distribution mechanism has changed since - DiffCI ships as an authenticated package, not a public
 * Action - but the failure mode it guards against has not. These tests fail if it ever returns.
 */
describe("onboarding refuses to hand out an unpinned agent", () => {
  function envWithAgentArtifact(db: ReturnType<typeof freshProductDb>, agentArtifact: string | undefined) {
    const env = buildEnv(db) as Record<string, unknown>;
    if (agentArtifact === undefined) delete env.DIFFCI_AGENT_ARTIFACT;
    else env.DIFFCI_AGENT_ARTIFACT = agentArtifact;
    return env;
  }

  for (const [label, agentArtifact] of [
    ["unset", undefined],
    ["a dist-tag", `npm:@diffci/observer@latest#${TEST_INTEGRITY}`],
    ["a caret range", `npm:@diffci/observer@^1.4.2#${TEST_INTEGRITY}`],
    ["a wildcard range", `npm:@diffci/observer@1.x#${TEST_INTEGRITY}`],
    ["an exact version with no integrity hash", "npm:@diffci/observer@1.4.2"],
    ["a container tag rather than a digest", "oci:ghcr.io/diffci/observer:v1"],
    ["not an artifact specifier at all", "diffci/diffci-action@" + "b".repeat(40)],
  ] as const) {
    it(`refuses install instructions when DIFFCI_AGENT_ARTIFACT is ${label}`, async () => {
      const db = freshProductDb(["ingest"]);
      const env = envWithAgentArtifact(db, agentArtifact);
      const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
      const connected = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, {
        headers: acme.headers,
        body: { providerRepositoryId: "111", ownerName: "acme/checkout" },
      });
      const repositoryId = (connected.body.repository as { id: string }).id;

      const install = await call(env, "GET", `/v1/organizations/${acme.org.id}/repositories/${repositoryId}/install`, { headers: acme.headers });
      assert.equal(install.status, 503, "a deployment that cannot pin cannot onboard");
      assert.equal(install.body.error, "agent_not_pinned");
      assert.equal(JSON.stringify(install.body).includes("workflowYaml"), false, "a refusal must not carry a workflow anyway");
    });

    it(`refuses to mint an ingest token when DIFFCI_AGENT_ARTIFACT is ${label}`, async () => {
      const db = freshProductDb(["ingest"]);
      const env = envWithAgentArtifact(db, agentArtifact);
      const acme = await tenant(db, { email: "dev@acme.test", slug: "acme" });
      const connected = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories`, {
        headers: acme.headers,
        body: { providerRepositoryId: "111", ownerName: "acme/checkout" },
      });
      const repositoryId = (connected.body.repository as { id: string }).id;

      // Checked before issuance on purpose: handing someone a live credential and then refusing to say
      // what to do with it leaves a secret in their hands and an unrevoked row in the database.
      const issued = await call(env, "POST", `/v1/organizations/${acme.org.id}/repositories/${repositoryId}/ingest-tokens`, { headers: acme.headers, body: {} });
      assert.equal(issued.status, 503);
      assert.equal(issued.body.error, "agent_not_pinned");
      assert.equal(issued.body.token, undefined, "no credential may be minted that cannot be used");

      const listed = await call(env, "GET", `/v1/organizations/${acme.org.id}/repositories/${repositoryId}/ingest-tokens`, { headers: acme.headers });
      assert.deepEqual(listed.body.tokens ?? [], [], "and none may be left behind in the database");
    });
  }

  it("reports the same fact on /health that it enforces on the routes", async () => {
    const db = freshProductDb(["ingest"]);
    const unpinned = await call(envWithAgentArtifact(db, `npm:@diffci/observer@^1.4.2#${TEST_INTEGRITY}`), "GET", "/health");
    assert.equal(unpinned.body.agentArtifactPinned, false);
    assert.equal(unpinned.body.agentArtifactRejection, "not_immutable");

    const pinned = await call(envWithAgentArtifact(db, PINNED_AGENT), "GET", "/health");
    assert.equal(pinned.body.agentArtifactPinned, true);
    assert.equal(pinned.body.agentArtifactRejection, undefined);
  });
});
