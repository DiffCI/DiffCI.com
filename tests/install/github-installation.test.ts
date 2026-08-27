/**
 * Phase 03 follow-up (2026-08-26): connecting repositories from a real App installation.
 *
 * The case this exists for is the last one: two DiffCI organizations, one GitHub repository. GitHub is
 * happy to let both install an App they each have rights to (a transfer, a shared org, an outside
 * collaborator with admin). Re-parenting the row would move that repository's observations, credentials
 * and history into whoever installed most recently.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { connectInstallation, listInstallationRepositories, type InstallationRepository } from "../../src/install/github-installation.js";
import { makeD1ProductStore } from "../../src/product/store.js";

const CREDENTIALS = { appId: "1", privateKeyPkcs8Pem: "unused - listRepositories is injected" };

async function fixture() {
  const db = freshProductDb(["ingest"]);
  const productStore = makeD1ProductStore(makeD1(db));
  const user = await productStore.createUser({ email: "owner@example.com" });
  const orgA = await productStore.createOrganization({ name: "A", slug: "a", ownerUserId: user.id });
  const orgB = await productStore.createOrganization({ name: "B", slug: "b", ownerUserId: user.id });
  return { db, productStore, user, orgA, orgB };
}

function repositories(...items: Array<Partial<InstallationRepository> & { providerRepositoryId: string; ownerName: string }>): InstallationRepository[] {
  return items.map((item) => ({ defaultBranch: "main", private: false, ...item }));
}

describe("connecting a GitHub App installation", () => {
  it("connects exactly the repositories the installation covers, with GitHub's own ids", async () => {
    const { productStore, user, orgA } = await fixture();
    const result = await connectInstallation(
      {
        productStore,
        credentials: CREDENTIALS,
        listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app", defaultBranch: "trunk" }, { providerRepositoryId: "222", ownerName: "acme/lib" }),
      },
      { organizationId: orgA.id, userId: user.id, installationId: "9000" },
    );

    assert.equal(result.connected, 2);
    const stored = await productStore.listRepositories(orgA.id);
    assert.deepEqual(stored.map((r) => r.ownerName).sort(), ["acme/app", "acme/lib"]);
    const app = stored.find((r) => r.ownerName === "acme/app")!;
    assert.equal(app.providerRepositoryId, "111");
    assert.equal(app.defaultBranch, "trunk");
    assert.equal(app.installationId, "9000");
    assert.equal(app.status, "active", "a connected repository is ready to receive observations");
  });

  it("refuses a repository another organization already connected, and changes nothing about it", async () => {
    const { productStore, user, orgA, orgB } = await fixture();
    await connectInstallation(
      { productStore, credentials: CREDENTIALS, listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app" }) },
      { organizationId: orgA.id, userId: user.id, installationId: "9000" },
    );

    const second = await connectInstallation(
      {
        productStore,
        credentials: CREDENTIALS,
        listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app" }, { providerRepositoryId: "333", ownerName: "other/app" }),
      },
      { organizationId: orgB.id, userId: user.id, installationId: "9001" },
    );

    assert.equal(second.refused, 1);
    assert.equal(second.connected, 1, "the repository nobody had claimed still connects");
    assert.ok(second.outcomes.some((o) => o.result === "claimed_elsewhere" && o.ownerName === "acme/app"));

    const claimed = await productStore.getRepositoryByProviderId("111");
    assert.equal(claimed?.organizationId, orgA.id, "the claim stands with whoever connected first");
    assert.equal(claimed?.installationId, "9000", "and the newcomer's installation id was not written over it");
    assert.deepEqual((await productStore.listRepositories(orgB.id)).map((r) => r.ownerName), ["other/app"]);
  });

  it("re-installing refreshes what GitHub says, without duplicating the repository", async () => {
    const { productStore, user, orgA } = await fixture();
    await connectInstallation(
      { productStore, credentials: CREDENTIALS, listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app", defaultBranch: "master" }) },
      { organizationId: orgA.id, userId: user.id, installationId: "9000" },
    );

    // Renamed on GitHub, default branch changed, installed again under a new installation id.
    const again = await connectInstallation(
      { productStore, credentials: CREDENTIALS, listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/checkout", defaultBranch: "main" }) },
      { organizationId: orgA.id, userId: user.id, installationId: "9002" },
    );

    assert.equal(again.updated, 1);
    assert.equal(again.connected, 0);
    const stored = await productStore.listRepositories(orgA.id);
    assert.equal(stored.length, 1, "the numeric id is the identity, so a rename is not a new repository");
    assert.equal(stored[0]!.ownerName, "acme/checkout");
    assert.equal(stored[0]!.defaultBranch, "main");
    assert.equal(stored[0]!.installationId, "9002");
  });

  it("brings a previously removed repository back to active when it is re-installed", async () => {
    const { productStore, user, orgA } = await fixture();
    const first = await connectInstallation(
      { productStore, credentials: CREDENTIALS, listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app" }) },
      { organizationId: orgA.id, userId: user.id, installationId: "9000" },
    );
    const repositoryId = (first.outcomes[0] as { repository: { id: string } }).repository.id;
    await productStore.setRepositoryStatus(repositoryId, "removed");

    await connectInstallation(
      { productStore, credentials: CREDENTIALS, listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app" }) },
      { organizationId: orgA.id, userId: user.id, installationId: "9000" },
    );
    assert.equal((await productStore.getRepository(repositoryId))?.status, "active");
  });

  it("records what happened, without an actor when a webhook did it", async () => {
    const { productStore, orgA } = await fixture();
    await connectInstallation(
      { productStore, credentials: CREDENTIALS, listRepositories: async () => repositories({ providerRepositoryId: "111", ownerName: "acme/app" }) },
      { organizationId: orgA.id, installationId: "9000" },
    );
    const events = await productStore.listAuditEvents(orgA.id);
    const connected = events.find((event) => event.action === "installation.connected");
    assert.ok(connected);
    assert.equal(connected.actorUserId, undefined, "a webhook is not a person and must not be recorded as one");
  });
});

describe("listing an installation's repositories", () => {
  function pagedFetch(pages: Array<Array<{ id: number; full_name: string; default_branch?: string }>>): { fetchImpl: typeof fetch; urls: string[] } {
    const urls: string[] = [];
    const fetchImpl = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      const page = Number(new URL(url).searchParams.get("page") ?? "1");
      return new Response(JSON.stringify({ repositories: pages[page - 1] ?? [] }), { status: 200 });
    }) as unknown as typeof fetch;
    return { fetchImpl, urls };
  }

  it("follows pagination rather than connecting whatever fits on the first page", async () => {
    const full = Array.from({ length: 100 }, (_, i) => ({ id: i + 1, full_name: `acme/repo-${i + 1}` }));
    const { fetchImpl, urls } = pagedFetch([full, [{ id: 101, full_name: "acme/last" }]]);

    const result = await listInstallationRepositories("token", fetchImpl);
    assert.equal(result.length, 101);
    assert.equal(urls.length, 2);
    assert.equal(result[100]!.ownerName, "acme/last");
  });

  it("stops on a short page", async () => {
    const { fetchImpl, urls } = pagedFetch([[{ id: 1, full_name: "acme/only" }]]);
    assert.equal((await listInstallationRepositories("token", fetchImpl)).length, 1);
    assert.equal(urls.length, 1);
  });

  it("throws with GitHub's status rather than returning an empty list", async () => {
    const failing = (async () => new Response("no", { status: 403 })) as unknown as typeof fetch;
    await assert.rejects(() => listInstallationRepositories("token", failing), /403/);
  });
});
