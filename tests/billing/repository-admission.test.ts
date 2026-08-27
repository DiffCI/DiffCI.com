/**
 * Early access, as a decision instead of an accident (2026-08-27).
 *
 * Onboarding via the GitHub App reached first value without any payment setup - not because anyone
 * decided it should, but because `connectInstallation` called `createRepository` directly while the
 * typed route checked `maxRepositories`. Two paths, two policies, no test. Anyone tidying that
 * inconsistency would have silently broken signup for every free-plan organization after the first
 * repository.
 *
 * These tests pin the intended behaviour so it survives being noticed.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { decideRepositoryAdmission, EARLY_ACCESS_ENABLED } from "../../src/billing/repository-admission.js";
import { getPlanEntitlements } from "../../src/billing/plans.js";
import { connectInstallation } from "../../src/install/github-installation.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";

const free = getPlanEntitlements("free");

describe("repository admission policy", () => {
  it("admits anything inside the plan limit, whatever the source", () => {
    for (const source of ["installation", "manual"] as const) {
      const decision = decideRepositoryAdmission({ entitlements: free, currentRepositoryCount: 0, source, earlyAccess: true });
      assert.equal(decision.admit, true);
      if (!decision.admit) return;
      assert.equal(decision.reason, "within_plan_limit");
    }
  });

  it("admits an installation-sourced repository past the limit during early access, and says why", () => {
    const decision = decideRepositoryAdmission({ entitlements: free, currentRepositoryCount: free.maxRepositories, source: "installation", earlyAccess: true });
    assert.equal(decision.admit, true);
    if (!decision.admit) return;
    // The reason matters as much as the outcome: it is the difference between a deliberate programme
    // and a hole. An audit reading `early_access_installation` knows which one this is.
    assert.equal(decision.reason, "early_access_installation");
  });

  it("still refuses a manually-typed repository past the limit, even during early access", () => {
    // This is the path where nothing outside DiffCI vouches for the repository id, so it is the path
    // where an unlimited allowance would actually be worth abusing.
    const decision = decideRepositoryAdmission({ entitlements: free, currentRepositoryCount: free.maxRepositories, source: "manual", earlyAccess: true });
    assert.equal(decision.admit, false);
    if (decision.admit) return;
    assert.equal(decision.reason, "plan_limit_reached");
    assert.equal(decision.maxRepositories, free.maxRepositories);
  });

  it("applies the limit uniformly once early access ends", () => {
    const decision = decideRepositoryAdmission({ entitlements: free, currentRepositoryCount: free.maxRepositories, source: "installation", earlyAccess: false });
    assert.equal(decision.admit, false);
  });

  it("treats a negative limit as unlimited, matching the plans module's convention", () => {
    const decision = decideRepositoryAdmission({ entitlements: { maxRepositories: -1 }, currentRepositoryCount: 9999, source: "manual", earlyAccess: false });
    assert.equal(decision.admit, true);
  });

  it("has early access switched on, which is what makes external onboarding possible today", () => {
    // A canary, not a tautology: when someone turns this off, the tests that depend on free-plan
    // onboarding working should fail loudly at the same moment.
    assert.equal(EARLY_ACCESS_ENABLED, true);
  });
});

describe("the App install path under the policy", () => {
  async function connect(maxRepositories: number, earlyAccess: boolean) {
    const db = freshProductDb(["ingest"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const user = await productStore.createUser({ email: "dev@acme.test" });
    const organization = await productStore.createOrganization({ name: "Acme", slug: "acme", ownerUserId: user.id });

    const result = await connectInstallation(
      {
        productStore,
        credentials: { appId: "1", privateKeyPkcs8Pem: "unused" },
        maxRepositories,
        earlyAccess,
        listRepositories: async () => [
          { providerRepositoryId: "111", ownerName: "acme/one", defaultBranch: "main", private: true },
          { providerRepositoryId: "222", ownerName: "acme/two", defaultBranch: "main", private: true },
        ],
      },
      { organizationId: organization.id, userId: user.id, installationId: "9000" },
    );
    return { result, repositories: await productStore.listRepositories(organization.id) };
  }

  it("connects every repository an installation covers during early access, past the free limit", async () => {
    const { result, repositories } = await connect(free.maxRepositories, true);
    assert.equal(result.connected, 2, "a free-plan organization can still onboard a whole installation");
    assert.equal(result.planLimited, 0);
    assert.equal(repositories.length, 2);
  });

  it("stops at the limit once early access ends, and reports what it did not connect", async () => {
    const { result, repositories } = await connect(1, false);
    assert.equal(result.connected, 1);
    assert.equal(result.planLimited, 1, "the unconnected repository is reported, not silently dropped");
    assert.equal(repositories.length, 1);
  });
});
