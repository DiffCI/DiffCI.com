import assert from "node:assert/strict";
import { it } from "node:test";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import { makeD1ProductStore } from "../../src/product/store.js";
import { DEFAULT_EVIDENCE_POLICY, makeD1EvidencePolicyStore } from "../../src/product/evidence-policy.js";
import { assessEvidence, getFleetForOrganization } from "../../src/product/fleet.js";
import type { FleetWindowEvidence } from "../../src/product/shadow-read-boundary.js";
import { renderFleetPanel } from "../../src/ui/fleet.js";
import { renderSafe } from "../../src/ui/render.js";

const now = new Date("2026-09-25T12:00:00.000Z");
const good: FleetWindowEvidence = { predictions: 10, selective: 5, full: 5, verifiedPredictions: 5,
  evaluableFailures: 1, failuresPreserved: 1, missedFailures: 0, analysisOverheadMs: 100, latestPredictionAt: "2026-09-25T00:00:00.000Z" };

it("policy never treats no evidence as safety and always flags misses", () => {
  assert.deepEqual(assessEvidence(good, DEFAULT_EVIDENCE_POLICY, true, now), []);
  const findings = assessEvidence({ ...good, missedFailures: 1, latestPredictionAt: "2026-09-20T00:00:00Z" }, DEFAULT_EVIDENCE_POLICY, false, now);
  assert.deepEqual(findings, ["awaiting_workflow", "missed_failures", "stale_observations"]);
  assert.ok(assessEvidence({ ...good, evaluableFailures: 0 }, DEFAULT_EVIDENCE_POLICY, true, now).includes("no_failure_evidence"));
  assert.ok(assessEvidence({ ...good, predictions: 0, verifiedPredictions: 0, latestPredictionAt: null }, DEFAULT_EVIDENCE_POLICY, true, now).includes("no_observations"));
});

it("fleet scopes all reads, compares equal windows and exposes partial failures without zero-filling", async () => {
  const db = freshProductDb();
  const productStore = makeD1ProductStore(makeD1(db));
  const user = await productStore.createUser({ email: "a@example.com" });
  const org = await productStore.createOrganization({ name: "A", slug: "a", ownerUserId: user.id });
  for (const name of ["a/good", "a/down", "a/<script>"]) await productStore.createRepository({ organizationId: org.id, ownerName: name, providerRepositoryId: name });
  const calls: string[] = [];
  const deps = { productStore, policies: makeD1EvidencePolicyStore(makeD1(db)),
    evidence: { async summarize(name: string, start: string, end: string) {
      calls.push(name); assert.equal(Date.parse(end) - Date.parse(start), 7 * 86400000);
      if (name === "a/down") throw new Error("database unavailable");
      return { ...good, selective: end === now.toISOString() ? 5 : 2 };
    } }, shadow: { async getEvidenceWorkflowState(ownerName: string) { return { ownerName, state: "identified" as const }; } } };
  assert.deepEqual(await getFleetForOrganization(deps, "outsider", org.id, now), { ok: false, error: "unauthorized" });
  assert.equal(calls.length, 0);
  const result = await getFleetForOrganization(deps, user.id, org.id, now);
  assert.ok(result.ok);
  assert.deepEqual(result.data.unavailable, ["a/down"]);
  assert.equal(result.data.totals.predictions, 20);
  assert.equal(result.data.totals.unavailable, 1);
  assert.equal(result.data.repositories[0]?.selectivePercentChange, 30);
  assert.ok(result.data.notice.includes("does not authorize"));
  const page = renderSafe(renderFleetPanel(org.id, { report: result.data, canEditPolicy: false, history: [] }));
  assert.ok(page.includes("a/&lt;script&gt;"));
  assert.ok(page.includes("Evidence could not be loaded"));
  assert.ok(!page.includes("Save reporting policy"));
  assert.ok(renderSafe(renderFleetPanel(org.id)).includes("unavailable"));
  db.close();
});
