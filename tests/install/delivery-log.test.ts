/**
 * Webhook replay and duplicate suppression (2026-08-27).
 *
 * `installation.deleted` erases every observation for an installation and revokes its credentials.
 * GitHub retries any delivery that did not get a timely 2xx, and any delivery can be redelivered by
 * hand from the App's settings page at any later date. So "the same delivery arrives twice" is not a
 * hypothetical, and on this endpoint it is a data-loss question.
 *
 * The tests below fix the semantics rather than the implementation: what must happen on a retry, on a
 * concurrent duplicate, on a genuine failure, and on a delivery with no id at all.
 */
import { strict as assert } from "node:assert";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1ObservationStore } from "../../src/ingest/store.js";
import { makeD1IngestTokenStore } from "../../src/ingest/token.js";
import { makeD1WebhookDeliveryStore } from "../../src/install/delivery-log.js";
import { makeD1PendingInstallationStore } from "../../src/install/pending.js";
import { handleInstallationWebhook } from "../../src/install/webhook.js";
import { ingestObservation } from "../../src/ingest/ingest.js";
import { makeReport } from "../ingest/report-fixture.js";

const SECRET = "webhook-secret-value";

function delivery(event: string, payload: unknown, deliveryId: string | null | undefined) {
  const rawBody = JSON.stringify(payload);
  return { rawBody, signature: `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`, event, deliveryId };
}

async function fixture() {
  const db = freshProductDb(["ingest", "usage", "auth", "install"]);
  const d1 = makeD1(db);
  const productStore = makeD1ProductStore(d1);
  const tokenStore = makeD1IngestTokenStore(d1);
  const observationStore = makeD1ObservationStore(d1);
  const deliveryStore = makeD1WebhookDeliveryStore(d1);
  const pendingStore = makeD1PendingInstallationStore(d1);

  const user = await productStore.createUser({ email: "a@example.com" });
  const organization = await productStore.createOrganization({ name: "a", slug: "a", ownerUserId: user.id });
  const repository = await productStore.createRepository({ organizationId: organization.id, providerRepositoryId: "111", ownerName: "a/app", installationId: "9000" });
  await productStore.setRepositoryStatus(repository.id, "active");
  const token = await tokenStore.issue({ organizationId: organization.id, repositoryId: repository.id });
  await ingestObservation(
    {
      authorization: `Bearer ${token.raw}`,
      body: JSON.stringify(makeReport({ repository: { provider: "github", ownerName: "a/app", providerRepositoryId: "111" } })),
    },
    { tokenStore, observationStore, productStore },
  );

  return {
    productStore,
    observationStore,
    deliveryStore,
    organization,
    repository,
    deps: { productStore, observationStore, tokenStore, pendingStore, deliveryStore, webhookSecret: SECRET },
  };
}

const DELETED = { action: "deleted", installation: { id: 9000 } };

describe("destructive deliveries are processed exactly once", () => {
  it("erases on the first delivery and ignores the redelivery", async () => {
    const { deps, observationStore, organization, productStore, repository } = await fixture();

    const first = await handleInstallationWebhook(delivery("installation", DELETED, "d-1"), deps);
    assert.equal(first.ok && first.action, "disconnected");
    if (!first.ok || first.action !== "disconnected") return;
    assert.equal(first.observationsDeleted, 1);
    assert.equal((await observationStore.summarise(organization.id)).total, 0);

    // The same delivery id again: GitHub's retry, or a manual redelivery months later.
    const second = await handleInstallationWebhook(delivery("installation", DELETED, "d-1"), deps);
    assert.equal(second.ok, true);
    if (!second.ok || second.action !== "ignored") return assert.fail("a redelivery must be ignored");
    assert.equal(second.duplicate, true);
    assert.match(second.reason, /duplicate/);
    assert.equal((await productStore.getRepository(repository.id))?.status, "removed");
  });

  it("suppresses a concurrent duplicate, not just a sequential one", async () => {
    const { deps, observationStore, organization } = await fixture();

    // Both start before either finishes - the shape of a GitHub retry that overlaps the original.
    const [a, b] = await Promise.all([
      handleInstallationWebhook(delivery("installation", DELETED, "d-race"), deps),
      handleInstallationWebhook(delivery("installation", DELETED, "d-race"), deps),
    ]);

    const outcomes = [a, b].map((r) => (r.ok ? r.action : `error:${r.error}`));
    assert.equal(outcomes.filter((o) => o === "disconnected").length, 1, "exactly one delivery may do the erasing");
    assert.equal(outcomes.filter((o) => o === "ignored").length, 1, "the other must be refused");
    assert.equal((await observationStore.summarise(organization.id)).total, 0);
  });

  it("treats a different delivery id as a different delivery, even with an identical body", async () => {
    const { deps } = await fixture();
    const first = await handleInstallationWebhook(delivery("installation", DELETED, "d-1"), deps);
    const second = await handleInstallationWebhook(delivery("installation", DELETED, "d-2"), deps);

    assert.equal(first.ok && first.action, "disconnected");
    // The second is not suppressed by the dedup layer - it is simply a no-op, because the first already
    // removed everything. Dedup is not a substitute for handlers being idempotent; it is a guard for
    // the case where they are not.
    assert.equal(second.ok && second.action, "disconnected");
    if (second.ok && second.action === "disconnected") assert.equal(second.observationsDeleted, 0);
  });
});

describe("delivery-id handling", () => {
  it("refuses a signed delivery that carries no delivery id", async () => {
    const { deps, observationStore, organization } = await fixture();
    // GitHub always sends X-GitHub-Delivery. Something that does not is either not GitHub or is a
    // proxy stripping headers - and it cannot be de-duplicated, so it does not get to erase anything.
    const result = await handleInstallationWebhook(delivery("installation", DELETED, null), deps);
    assert.equal(result.ok, true);
    if (!result.ok || result.action !== "ignored") return assert.fail("expected a refusal");
    assert.match(result.reason, /delivery id/);
    assert.equal((await observationStore.summarise(organization.id)).total, 1, "nothing was erased");
  });

  it("records the delivery id only after the signature verifies", async () => {
    const { deps, deliveryStore } = await fixture();
    const body = JSON.stringify(DELETED);
    const forged = await handleInstallationWebhook({ rawBody: body, signature: "sha256=" + "0".repeat(64), event: "installation", deliveryId: "d-forged" }, deps);
    assert.equal(forged.ok, false);

    // Otherwise an unauthenticated attacker could burn the id of a real pending delivery and cause the
    // genuine retry to be dropped as a duplicate - a denial of the uninstall itself.
    assert.equal(await deliveryStore.get("d-forged"), null);
  });
});

describe("failure handling", () => {
  it("marks a failed delivery so GitHub's retry is allowed to succeed", async () => {
    const { deps, deliveryStore } = await fixture();
    const exploding = {
      ...deps,
      productStore: {
        ...deps.productStore,
        listRepositoriesByInstallation: async () => {
          throw new Error("D1 unavailable");
        },
      },
    };

    await assert.rejects(() => handleInstallationWebhook(delivery("installation", DELETED, "d-fail"), exploding as never));
    assert.equal((await deliveryStore.get("d-fail"))?.status, "failed");

    // The retry gets through, because a delivery that errored was never applied.
    const retry = await handleInstallationWebhook(delivery("installation", DELETED, "d-fail"), deps);
    assert.equal(retry.ok && retry.action, "disconnected");
    assert.equal((await deliveryStore.get("d-fail"))?.status, "completed");
  });

  it("leaves a crashed delivery visible as stale rather than silently stuck", async () => {
    const { deliveryStore } = await fixture();
    await deliveryStore.claim({ deliveryId: "d-crashed", event: "installation", action: "deleted" });
    // Nothing marks it complete - the isolate died mid-handler.
    const stale = await deliveryStore.listStale(0);
    assert.equal(stale.some((row) => row.deliveryId === "d-crashed"), true);
    assert.equal((await deliveryStore.get("d-crashed"))?.status, "processing");
  });

  it("refuses to re-run a delivery still marked processing", async () => {
    const { deps, deliveryStore, observationStore, organization } = await fixture();
    await deliveryStore.claim({ deliveryId: "d-inflight", event: "installation", action: "deleted" });

    const result = await handleInstallationWebhook(delivery("installation", DELETED, "d-inflight"), deps);
    assert.equal(result.ok && result.action, "ignored");
    // Deliberate: for a destructive handler, "is the first attempt still running or did it die?" is not
    // a question worth guessing about. Refusing costs an operator a stale row; guessing costs a customer
    // a second erase.
    assert.equal((await observationStore.summarise(organization.id)).total, 1);
  });
});
