/**
 * Install-first onboarding, and the authorization that guards it (B3, 2026-08-27).
 *
 * The gap this closes: someone who installs the App from GitHub's own page - the link the App's public
 * URL and the marketing site both hand out - produced an `installation.created` delivery the handler
 * ignored, then landed on a setup URL with no state to consume, and got a bare 400. That was the most
 * likely first experience of DiffCI, and it was a dead end.
 *
 * The fix must not trade that dead end for a worse problem. A webhook says which GitHub account
 * installed something; it does not say which DiffCI tenant that belongs to, and inventing an answer is
 * the cross-tenant mistake all of Phase 03 is built to avoid. So these tests are mostly about what the
 * claim REFUSES.
 */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1OAuthStore } from "../../src/auth/oauth-store.js";
import { makeD1PendingInstallationStore, claimInstallation } from "../../src/install/pending.js";
import { handleInstallationWebhook } from "../../src/install/webhook.js";
import { makeD1ObservationStore } from "../../src/ingest/store.js";
import { makeD1IngestTokenStore } from "../../src/ingest/token.js";

const SECRET = "webhook-secret-value";

function delivery(event: string, payload: unknown, deliveryId?: string) {
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`, event, deliveryId };
}

async function fixture() {
  const db = freshProductDb(["ingest", "auth", "install"]);
  const d1 = makeD1(db);
  const productStore = makeD1ProductStore(d1);
  const oauthStore = makeD1OAuthStore(d1);
  const pendingStore = makeD1PendingInstallationStore(d1);
  const observationStore = makeD1ObservationStore(d1);
  const tokenStore = makeD1IngestTokenStore(d1);

  // The installer: a real DiffCI user whose GitHub identity is linked, as it would be after login.
  const installer = await productStore.createUser({ email: "installer@acme.test" });
  await oauthStore.linkProviderIdentity(installer.id, "github", "77", "installer");
  const acme = await productStore.createOrganization({ name: "Acme", slug: "acme", ownerUserId: installer.id });

  // A bystander: signed in, has their own organization, did not perform the install.
  const bystander = await productStore.createUser({ email: "bystander@other.test" });
  await oauthStore.linkProviderIdentity(bystander.id, "github", "88", "bystander");
  const other = await productStore.createOrganization({ name: "Other", slug: "other", ownerUserId: bystander.id });

  const deps = { productStore, observationStore, tokenStore, pendingStore, webhookSecret: SECRET };
  return { db, productStore, oauthStore, pendingStore, installer, acme, bystander, other, deps };
}

const CREATED = {
  action: "created",
  installation: { id: 9100, account: { login: "acme" } },
  sender: { id: 77, login: "installer" },
  repositories: [{ id: 111, full_name: "acme/checkout" }],
};

describe("installation.created", () => {
  it("is parked, not attributed - the delivery cannot say which tenant it belongs to", async () => {
    const { deps, pendingStore, productStore, acme } = await fixture();

    const result = await handleInstallationWebhook(delivery("installation", CREATED), deps);
    assert.equal(result.ok, true);
    if (!result.ok || result.action !== "parked") return assert.fail("expected the installation to be parked");
    assert.equal(result.repositories, 1);

    const pending = await pendingStore.get("9100");
    assert.equal(pending?.senderProviderUserId, "77");
    assert.equal(pending?.accountLogin, "acme");
    assert.equal(pending?.claimedAt, undefined);

    // Nothing was connected anywhere on the strength of a webhook alone.
    assert.deepEqual(await productStore.listRepositories(acme.id), []);
  });

  it("records a redelivery without duplicating it, and without re-opening a claimed installation", async () => {
    const { deps, pendingStore, installer, acme } = await fixture();
    await handleInstallationWebhook(delivery("installation", CREATED), deps);
    await pendingStore.markClaimed({ installationId: "9100", userId: installer.id, organizationId: acme.id });

    // GitHub redelivers the same creation event after the claim - by retry, or from the settings page.
    await handleInstallationWebhook(delivery("installation", CREATED), deps);

    const pending = await pendingStore.get("9100");
    assert.ok(pending?.claimedAt, "a redelivered creation must not blank out an existing claim");
    assert.equal(pending?.claimedOrganizationId, acme.id);
  });

  it("parks an unclaimable row rather than dropping a delivery with no sender", async () => {
    const { deps, pendingStore } = await fixture();
    await handleInstallationWebhook(delivery("installation", { ...CREATED, sender: undefined }), deps);
    const pending = await pendingStore.get("9100");
    assert.ok(pending, "the installation is still visible to an operator");
    assert.equal(pending?.senderProviderUserId, undefined, "but has no identity anyone could match");
  });
});

describe("claiming a parked installation", () => {
  // connectInstallation would call GitHub; these tests are about the checks that run BEFORE it, so the
  // refusal path never reaches the network. A refusal that got as far as an API call would be a bug.
  const unreachableConnectDeps = {
    credentials: { appId: "1", privateKeyPkcs8Pem: "unused" },
    listRepositories: async () => {
      throw new Error("connectInstallation must not be reached on a refused claim");
    },
  };

  it("refuses someone who did not perform the installation", async () => {
    const { deps, pendingStore, productStore, oauthStore, bystander, other } = await fixture();
    await handleInstallationWebhook(delivery("installation", CREATED), deps);

    const outcome = await claimInstallation(
      { pendingStore, productStore, oauthStore, connectDeps: unreachableConnectDeps },
      { installationId: "9100", userId: bystander.id, organizationId: other.id },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, "not_installer");
    assert.equal((await pendingStore.get("9100"))?.claimedAt, undefined, "a refused claim leaves it unclaimed");
  });

  it("refuses the real installer attaching it to an organization they do not belong to", async () => {
    const { deps, pendingStore, productStore, oauthStore, installer, other } = await fixture();
    await handleInstallationWebhook(delivery("installation", CREATED), deps);

    const outcome = await claimInstallation(
      { pendingStore, productStore, oauthStore, connectDeps: unreachableConnectDeps },
      { installationId: "9100", userId: installer.id, organizationId: other.id },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, "unauthorized");
  });

  it("refuses a delivery whose installer is unknown, rather than treating absence as permission", async () => {
    const { deps, pendingStore, productStore, oauthStore, installer, acme } = await fixture();
    await handleInstallationWebhook(delivery("installation", { ...CREATED, sender: undefined }), deps);

    const outcome = await claimInstallation(
      { pendingStore, productStore, oauthStore, connectDeps: unreachableConnectDeps },
      { installationId: "9100", userId: installer.id, organizationId: acme.id },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, "not_installer");
  });

  it("refuses an installation nobody has ever heard of", async () => {
    const { pendingStore, productStore, oauthStore, installer, acme } = await fixture();
    const outcome = await claimInstallation(
      { pendingStore, productStore, oauthStore, connectDeps: unreachableConnectDeps },
      { installationId: "does-not-exist", userId: installer.id, organizationId: acme.id },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, "unknown_installation");
  });

  it("refuses a second claim, so an installation is never re-parented", async () => {
    const { deps, pendingStore, productStore, oauthStore, installer, acme } = await fixture();
    await handleInstallationWebhook(delivery("installation", CREATED), deps);
    await pendingStore.markClaimed({ installationId: "9100", userId: installer.id, organizationId: acme.id });

    const outcome = await claimInstallation(
      { pendingStore, productStore, oauthStore, connectDeps: unreachableConnectDeps },
      { installationId: "9100", userId: installer.id, organizationId: acme.id },
    );
    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.refusal, "already_claimed");
  });

  it("connects the installation's repositories when the installer claims it into their own organization", async () => {
    const { deps, pendingStore, productStore, oauthStore, installer, acme } = await fixture();
    await handleInstallationWebhook(delivery("installation", CREATED), deps);

    const outcome = await claimInstallation(
      {
        pendingStore,
        productStore,
        oauthStore,
        connectDeps: {
          credentials: { appId: "1", privateKeyPkcs8Pem: "unused" },
          listRepositories: async () => [{ providerRepositoryId: "111", ownerName: "acme/checkout", defaultBranch: "main", private: true }],
        },
      },
      { installationId: "9100", userId: installer.id, organizationId: acme.id },
    );

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.connected, 1);
    const repositories = await productStore.listRepositories(acme.id);
    assert.equal(repositories.length, 1);
    assert.equal(repositories[0]!.ownerName, "acme/checkout");
    assert.ok((await pendingStore.get("9100"))?.claimedAt);
  });

  it("still refuses a repository another organization already claimed, even to a valid claimant", async () => {
    const { deps, pendingStore, productStore, oauthStore, installer, acme, other } = await fixture();
    // The bystander's organization got there first, by any earlier route.
    await productStore.createRepository({ organizationId: other.id, providerRepositoryId: "111", ownerName: "acme/checkout" });
    await handleInstallationWebhook(delivery("installation", CREATED), deps);

    const outcome = await claimInstallation(
      {
        pendingStore,
        productStore,
        oauthStore,
        connectDeps: {
          credentials: { appId: "1", privateKeyPkcs8Pem: "unused" },
          listRepositories: async () => [{ providerRepositoryId: "111", ownerName: "acme/checkout", defaultBranch: "main", private: true }],
        },
      },
      { installationId: "9100", userId: installer.id, organizationId: acme.id },
    );

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.result.connected, 0);
    assert.equal(outcome.result.refused, 1, "passing the claim checks does not let anyone capture another tenant's repository");
    assert.deepEqual(await productStore.listRepositories(acme.id), []);
  });
});
