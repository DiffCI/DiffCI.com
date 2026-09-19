/**
 * Phase 03 follow-up (2026-08-26): the deletion promise, kept.
 *
 * site/data-handling.html says "Uninstalling deletes it." This handler is the only thing that can make
 * that true, and it is also the only route in DiffCI whose whole purpose is to erase data - so the
 * first test here is the one that matters most: an unsigned delivery deletes nothing.
 */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeReport } from "../ingest/report-fixture.js";
import { ingestObservation } from "../../src/ingest/ingest.js";
import { makeD1ObservationStore } from "../../src/ingest/store.js";
import { makeD1IngestTokenStore } from "../../src/ingest/token.js";
import type { WebhookDeliveryStore } from "../../src/install/delivery-log.js";
import type { PendingInstallationStore } from "../../src/install/pending.js";
import { handleInstallationWebhook } from "../../src/install/webhook.js";
import { makeD1ProductStore } from "../../src/product/store.js";

const SECRET = "webhook-secret-value";

function sign(body: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
}

function delivery(event: string, payload: unknown): { rawBody: string; signature: string; event: string } {
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: sign(rawBody), event };
}

function githubDelivery(event: string, payload: unknown, deliveryId = "delivery-1"): { rawBody: string; signature: string; event: string; deliveryId: string } {
  return { ...delivery(event, payload), deliveryId };
}

/**
 * Two organizations, each with its own installation, repository, credential and one stored observation.
 * Uninstalling one must leave the other exactly as it was.
 */
async function fixture() {
  const db = freshProductDb(["ingest", "usage"]);
  const d1 = makeD1(db);
  const productStore = makeD1ProductStore(d1);
  const tokenStore = makeD1IngestTokenStore(d1);
  const observationStore = makeD1ObservationStore(d1);

  async function tenant(seed: { email: string; slug: string; providerRepositoryId: string; ownerName: string; installationId: string; runId: string }) {
    const user = await productStore.createUser({ email: seed.email });
    const organization = await productStore.createOrganization({ name: seed.slug, slug: seed.slug, ownerUserId: user.id });
    const repository = await productStore.createRepository({
      organizationId: organization.id,
      providerRepositoryId: seed.providerRepositoryId,
      ownerName: seed.ownerName,
      installationId: seed.installationId,
    });
    await productStore.setRepositoryStatus(repository.id, "active");
    const token = await tokenStore.issue({ organizationId: organization.id, repositoryId: repository.id });
    const ingested = await ingestObservation(
      {
        authorization: `Bearer ${token.raw}`,
        body: JSON.stringify(
          makeReport({
            repository: { provider: "github", ownerName: seed.ownerName, providerRepositoryId: seed.providerRepositoryId },
            ci: { provider: "github-actions", runId: seed.runId, runAttempt: "1" },
          }),
        ),
      },
      { tokenStore, observationStore, productStore },
    );
    assert.equal(ingested.ok, true);
    return { user, organization, repository, token };
  }

  const a = await tenant({ email: "a@example.com", slug: "a", providerRepositoryId: "111", ownerName: "a/app", installationId: "9000", runId: "1" });
  const b = await tenant({ email: "b@example.com", slug: "b", providerRepositoryId: "222", ownerName: "b/app", installationId: "9001", runId: "2" });

  return { db, productStore, tokenStore, observationStore, a, b, deps: { productStore, observationStore, tokenStore, webhookSecret: SECRET } };
}

describe("installation webhooks", () => {
  it("deletes nothing when the signature does not verify", async () => {
    const { deps, observationStore, a } = await fixture();
    const body = JSON.stringify({ action: "deleted", installation: { id: 9000 } });

    const forged = await handleInstallationWebhook({ rawBody: body, signature: "sha256=" + "0".repeat(64), event: "installation" }, deps);
    assert.equal(forged.ok, false);
    if (forged.ok) return;
    assert.equal(forged.error, "bad_signature");

    const missing = await handleInstallationWebhook({ rawBody: body, signature: null, event: "installation" }, deps);
    assert.equal(missing.ok === false && missing.error, "bad_signature");

    assert.equal((await observationStore.summarise(a.organization.id)).total, 1, "the data is still there");
  });

  it("erases the repository's observations and kills its credentials when the App is uninstalled", async () => {
    const { deps, observationStore, tokenStore, productStore, a, b } = await fixture();

    const result = await handleInstallationWebhook(delivery("installation", { action: "deleted", installation: { id: 9000 } }), deps);
    assert.equal(result.ok, true);
    if (!result.ok || result.action !== "disconnected") return assert.fail("expected a disconnect");
    assert.equal(result.repositories, 1);
    assert.equal(result.observationsDeleted, 1);
    assert.equal(result.tokensRevoked, 1);

    assert.equal((await observationStore.summarise(a.organization.id)).total, 0);
    assert.equal((await tokenStore.verify(a.token.raw)).ok, false, "a workflow left in place cannot send any more");
    assert.equal((await productStore.getRepository(a.repository.id))?.status, "removed");

    // The other tenant's installation is untouched by any of it.
    assert.equal((await observationStore.summarise(b.organization.id)).total, 1);
    assert.equal((await tokenStore.verify(b.token.raw)).ok, true);
    assert.equal((await productStore.getRepository(b.repository.id))?.status, "active");
  });

  it("removes only the repositories dropped from an installation, not the whole installation", async () => {
    const { deps, observationStore, productStore, a } = await fixture();
    // A second repository under the same installation, which must survive.
    const kept = await productStore.createRepository({ organizationId: a.organization.id, providerRepositoryId: "999", ownerName: "a/other", installationId: "9000" });
    await productStore.setRepositoryStatus(kept.id, "active");

    const result = await handleInstallationWebhook(
      delivery("installation_repositories", { action: "removed", installation: { id: 9000 }, repositories_removed: [{ id: 111, full_name: "a/app" }] }),
      deps,
    );
    assert.equal(result.ok === true && result.action, "disconnected");
    assert.equal((await productStore.getRepository(a.repository.id))?.status, "removed");
    assert.equal((await productStore.getRepository(kept.id))?.status, "active");
    assert.equal((await observationStore.summarise(a.organization.id)).total, 0);
  });

  it("connects repositories added to an installation it already knows the owner of", async () => {
    const { deps, productStore, a } = await fixture();
    const result = await handleInstallationWebhook(
      delivery("installation_repositories", {
        action: "added",
        installation: { id: 9000 },
        repositories_added: [{ id: 777, full_name: "a/new-service", default_branch: "main" }],
      }),
      { ...deps, connectDeps: { credentials: { appId: "1", privateKeyPkcs8Pem: "unused" }, listRepositories: async () => [{ providerRepositoryId: "777", ownerName: "a/new-service", defaultBranch: "main", private: false }] } },
    );

    assert.equal(result.ok === true && result.action, "connected");
    const stored = await productStore.listRepositories(a.organization.id);
    assert.ok(stored.some((repository) => repository.ownerName === "a/new-service"));
  });

  it("ignores an addition it cannot attribute to an organization, rather than guessing one", async () => {
    const { deps } = await fixture();
    const result = await handleInstallationWebhook(
      delivery("installation_repositories", { action: "added", installation: { id: 4242 }, repositories_added: [{ id: 777, full_name: "stranger/app" }] }),
      deps,
    );
    assert.equal(result.ok === true && result.action, "ignored");
  });

  it("ignores deliveries it has nothing to do with", async () => {
    const { deps, observationStore, a } = await fixture();
    for (const [event, payload] of [
      ["installation", { action: "created", installation: { id: 9000 } }],
      ["push", { installation: { id: 9000 } }],
      ["installation", { action: "deleted" }],
    ] as const) {
      const result = await handleInstallationWebhook(delivery(event, payload), deps);
      assert.equal(result.ok === true && result.action, "ignored", `${event} should have been ignored`);
    }
    assert.equal((await observationStore.summarise(a.organization.id)).total, 1);
  });

  it("records the erasure in the audit trail", async () => {
    const { deps, productStore, a } = await fixture();
    await handleInstallationWebhook(delivery("installation", { action: "deleted", installation: { id: 9000 } }), deps);

    const events = await productStore.listAuditEvents(a.organization.id);
    const disconnected = events.find((event) => event.action === "repository.disconnected");
    assert.ok(disconnected);
    assert.equal((disconnected.metadata as { observationsDeleted: number }).observationsDeleted, 1);
  });

  it("records verified deliveries before marking them complete", async () => {
    const { deps } = await fixture();
    const calls: Array<{ event: string | null; deliveryId: string | null | undefined }> = [];
    const deliveryStore: WebhookDeliveryStore = {
      claim: async () => ({ ok: true, claimed: true }),
      complete: async () => {
        assert.equal(calls.length, 1);
      },
      fail: async () => assert.fail("a successful analytics receipt must not fail the delivery"),
      get: async () => null,
      listStale: async () => [],
    };
    const pendingStore: PendingInstallationStore = {
      record: async () => undefined,
      get: async () => null,
      listUnclaimedForSender: async () => [],
      markClaimed: async () => undefined,
      remove: async () => undefined,
    };

    const result = await handleInstallationWebhook(
      githubDelivery("installation", { action: "created", installation: { id: 9000 }, repositories: [{ id: 111 }] }),
      {
        ...deps,
        deliveryStore,
        pendingStore,
        recordVerifiedDelivery: async (request) => {
          calls.push({ event: request.event, deliveryId: request.deliveryId });
        },
      },
    );

    assert.equal(result.ok === true && result.action, "parked");
    assert.deepEqual(calls, [{ event: "installation", deliveryId: "delivery-1" }]);
  });

  it("does not complete a delivery when the verified-delivery recorder fails", async () => {
    const { deps } = await fixture();
    let failedReason = "";
    const deliveryStore: WebhookDeliveryStore = {
      claim: async () => ({ ok: true, claimed: true }),
      complete: async () => assert.fail("a failed analytics receipt must keep the delivery retryable"),
      fail: async (_deliveryId: string, reason: string) => {
        failedReason = reason;
      },
      get: async () => null,
      listStale: async () => [],
    };
    const pendingStore: PendingInstallationStore = {
      record: async () => undefined,
      get: async () => null,
      listUnclaimedForSender: async () => [],
      markClaimed: async () => undefined,
      remove: async () => undefined,
    };

    await assert.rejects(
      handleInstallationWebhook(
        githubDelivery("installation", { action: "created", installation: { id: 9000 }, repositories: [{ id: 111 }] }),
        {
          ...deps,
          deliveryStore,
          pendingStore,
          recordVerifiedDelivery: async () => {
            throw new Error("analytics_outbox_unavailable");
          },
        },
      ),
      /analytics_outbox_unavailable/,
    );
    assert.equal(failedReason, "Error");
  });
});
