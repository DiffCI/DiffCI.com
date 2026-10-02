import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { canChangeManagedExecution, decideManagedExecutionAdmission, makeD1ManagedExecutionConsentStore, readManagedExecutionConsent, updateManagedExecutionConsent, validateManagedExecutionConsent, type ManagedExecutionConsent } from "../../src/product/managed-execution.js";
import type { Repository } from "../../src/product/types.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";

const repository: Repository = {
  id: "repo-1", organizationId: "org-1", provider: "github", providerRepositoryId: "1",
  ownerName: "acme/app", defaultBranch: "main", status: "active", shadowEnabled: true,
  createdAt: "2026-10-02T00:00:00.000Z", updatedAt: "2026-10-02T00:00:00.000Z",
};
const consent: ManagedExecutionConsent = {
  organizationId: "org-1", repositoryId: "repo-1", mode: "verification", revision: 1,
  consentedByUserId: "user-1", consentedAt: "2026-10-02T00:00:00.000Z", maxDurationSeconds: 900,
};

describe("managed execution admission", () => {
  it("requires an owner or admin to change consent", () => {
    assert.equal(canChangeManagedExecution("owner"), true);
    assert.equal(canChangeManagedExecution("admin"), true);
    assert.equal(canChangeManagedExecution("member"), false);
  });

  it("admits only an active same-tenant repository, explicit verification consent, immutable commit, provider and pinned artifact", () => {
    assert.deepEqual(decideManagedExecutionAdmission({ organizationId: "org-1", repository, consent, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: true }), { allowed: true, reason: "authorized" });
  });

  it("fails closed for every missing production prerequisite", () => {
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-2", repository, consent, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: true }).reason, "tenant_mismatch");
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository: { ...repository, status: "paused" }, consent, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: true }).reason, "repository_inactive");
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: true }).reason, "consent_missing");
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository, consent: { ...consent, mode: "observation_only" }, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: true }).reason, "observation_only");
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository, consent, commitSha: "main", providerAvailable: true, agentArtifactPinned: true }).reason, "immutable_commit_required");
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository, consent, commitSha: "a".repeat(40), providerAvailable: false, agentArtifactPinned: true }).reason, "provider_unavailable");
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository, consent, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: false }).reason, "artifact_unpinned");
  });

  it("rejects malformed consent instead of treating it as disabled-but-valid", () => {
    assert.match(validateManagedExecutionConsent({ ...consent, maxDurationSeconds: 59 }) ?? "", /60 through 3600/);
    assert.equal(decideManagedExecutionAdmission({ organizationId: "org-1", repository, consent: { ...consent, consentedAt: "bad" }, commitSha: "a".repeat(40), providerAvailable: true, agentArtifactPinned: true }).reason, "consent_missing");
  });
});

describe("managed execution consent persistence", () => {
  it("is tenant-scoped, owner/admin-only, revision checked and append-only", async () => {
    const db = freshProductDb();
    const product = makeD1ProductStore(makeD1(db));
    const consents = makeD1ManagedExecutionConsentStore(makeD1(db));
    const owner = await product.createUser({ email: "execution-owner@example.com" });
    const member = await product.createUser({ email: "execution-member@example.com" });
    const outsider = await product.createUser({ email: "execution-outsider@example.com" });
    const org = await product.createOrganization({ name: "Execution", slug: "execution", ownerUserId: owner.id });
    await product.addMember(org.id, member.id, "member");
    const repo = await product.createRepository({ organizationId: org.id, providerRepositoryId: "101", ownerName: "acme/app" });
    await product.setRepositoryStatus(repo.id, "active");

    const enable = { expectedRevision: 0, mode: "verification", maxDurationSeconds: 900 };
    assert.deepEqual(await updateManagedExecutionConsent(product, consents, outsider.id, org.id, repo.id, enable), { ok: false, error: "unauthorized" });
    assert.deepEqual(await updateManagedExecutionConsent(product, consents, member.id, org.id, repo.id, enable), { ok: false, error: "forbidden" });
    const enabled = await updateManagedExecutionConsent(product, consents, owner.id, org.id, repo.id, enable);
    assert.ok(enabled.ok);
    assert.equal(enabled.data.revision, 1);
    assert.equal(enabled.data.mode, "verification");
    const memberRead = await readManagedExecutionConsent(product, consents, member.id, org.id, repo.id);
    assert.ok(memberRead.ok);
    assert.equal(memberRead.data.canEdit, false);
    assert.equal(memberRead.data.current.mode, "verification");
    assert.deepEqual(await readManagedExecutionConsent(product, consents, outsider.id, org.id, repo.id), { ok: false, error: "unauthorized" });
    assert.deepEqual(await updateManagedExecutionConsent(product, consents, owner.id, org.id, repo.id, enable), { ok: false, error: "revision_conflict" });

    const disabled = await updateManagedExecutionConsent(product, consents, owner.id, org.id, repo.id,
      { expectedRevision: 1, mode: "observation_only", maxDurationSeconds: 900 });
    assert.ok(disabled.ok);
    assert.deepEqual((await consents.history(org.id, repo.id)).map((entry) => entry.mode), ["observation_only", "verification"]);
    db.close();
  });
});
