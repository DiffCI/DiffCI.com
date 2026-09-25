import assert from "node:assert/strict";
import { it } from "node:test";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { DEFAULT_EVIDENCE_POLICY, makeD1EvidencePolicyStore, parseEvidencePolicy, readEvidencePolicy, updateEvidencePolicy } from "../../src/product/evidence-policy.js";

it("policy changes are role-gated, revision-checked, tenant-scoped and preserve audit history", async () => {
  const db = freshProductDb();
  const product = makeD1ProductStore(makeD1(db));
  const policies = makeD1EvidencePolicyStore(makeD1(db));
  const owner = await product.createUser({ email: "owner@example.com" });
  const member = await product.createUser({ email: "member@example.com" });
  const outsider = await product.createUser({ email: "outsider@example.com" });
  const org = await product.createOrganization({ name: "org", slug: "org", ownerUserId: owner.id });
  const other = await product.createOrganization({ name: "other", slug: "other", ownerUserId: outsider.id });
  await product.addMember(org.id, member.id, "member");
  const body = { expectedRevision: 0, policy: { ...DEFAULT_EVIDENCE_POLICY } };
  assert.deepEqual(await updateEvidencePolicy(product, policies, outsider.id, org.id, body), { ok: false, error: "unauthorized" });
  assert.deepEqual(await updateEvidencePolicy(product, policies, member.id, org.id, body), { ok: false, error: "forbidden" });
  assert.equal((await policies.current(org.id)).revision, 0);
  const first = await updateEvidencePolicy(product, policies, owner.id, org.id, body);
  assert.ok(first.ok);
  assert.equal(first.data.revision, 1);
  assert.equal(first.data.actorUserId, owner.id);
  assert.deepEqual(await updateEvidencePolicy(product, policies, owner.id, org.id, body), { ok: false, error: "revision_conflict" });
  const races = await Promise.all([20, 30].map((minimumPredictions) => updateEvidencePolicy(product, policies, owner.id, org.id,
    { expectedRevision: 1, policy: { ...DEFAULT_EVIDENCE_POLICY, minimumPredictions } })));
  assert.equal(races.filter((r) => r.ok).length, 1);
  const read = await readEvidencePolicy(product, policies, member.id, org.id);
  assert.ok(read.ok);
  assert.equal(read.data.canEdit, false);
  assert.deepEqual(read.data.history.map((r) => r.revision), [2, 1]);
  assert.deepEqual(read.data.history[1]?.policy, DEFAULT_EVIDENCE_POLICY);
  assert.equal((await policies.history(other.id)).length, 0);
  assert.deepEqual(await readEvidencePolicy(product, policies, outsider.id, org.id), { ok: false, error: "unauthorized" });
  // Defense in depth: the storage write itself refuses a member, even if a future caller forgets.
  assert.equal(await policies.append(org.id, member.id, 2, { ...DEFAULT_EVIDENCE_POLICY }), null);
  db.close();
});

it("policy input rejects invalid, unbounded and enforcement fields", () => {
  for (const value of [null, [], {}, { ...DEFAULT_EVIDENCE_POLICY, windowDays: 0 },
    { ...DEFAULT_EVIDENCE_POLICY, windowDays: 91 }, { ...DEFAULT_EVIDENCE_POLICY, minimumPredictions: NaN },
    { ...DEFAULT_EVIDENCE_POLICY, minimumVerifiedPredictions: 11 },
    { ...DEFAULT_EVIDENCE_POLICY, minimumEvaluableFailures: 0 },
    { ...DEFAULT_EVIDENCE_POLICY, windowDays: "7" },
    { ...DEFAULT_EVIDENCE_POLICY, allowSkipping: true }]) assert.equal(parseEvidencePolicy(value), null);
  assert.deepEqual(parseEvidencePolicy(DEFAULT_EVIDENCE_POLICY), DEFAULT_EVIDENCE_POLICY);
});
