import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildOnboardingStatus } from "../../src/product/onboarding.js";
import type { Repository } from "../../src/product/types.js";
import type { ObservationRecord } from "../../src/ingest/types.js";
import type { IngestTokenRecord } from "../../src/ingest/token.js";

const repository: Repository = {
  id: "r1", organizationId: "o1", provider: "github", providerRepositoryId: "1",
  ownerName: "team/project", defaultBranch: "main", status: "active", shadowEnabled: false,
  createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
};
const token: IngestTokenRecord = {
  id: "t1", organizationId: "o1", repositoryId: "r1", tokenPrefix: "dci_example",
  createdAt: "2026-09-01T00:00:00Z",
};
const observation: ObservationRecord = {
  id: "obs1", organizationId: "o1", repositoryId: "r1", idempotencyKey: "key",
  schemaVersion: "diffci.observation.v1", status: "OBSERVED", stage: "complete",
  blindSpot: false, worktreeUnchanged: true, blockingWorkflowFindings: 0, pathsRedacted: false,
  identityVerified: true, producedAt: "2026-09-25T00:00:00Z", receivedAt: "2026-09-25T00:00:01Z",
  reportBytes: 10, report: {},
};
const input = { repository, tokens: [token], observations: [observation], now: new Date("2026-09-25T01:00:00Z") };

test("onboarding advances from credential to report to observation", () => {
  assert.equal(buildOnboardingStatus({ ...input, tokens: [], observations: [] }).state, "needs_token");
  assert.equal(buildOnboardingStatus({ ...input, observations: [] }).state, "awaiting_report");
  assert.equal(buildOnboardingStatus(input).state, "observing");
});
test("foreign evidence cannot complete repository setup", () => {
  for (const scope of [{ organizationId: "other" }, { repositoryId: "other" }]) {
    assert.equal(buildOnboardingStatus({ ...input, tokens: [{ ...token, ...scope }] }).state, "needs_token");
    assert.equal(buildOnboardingStatus({ ...input, observations: [{ ...observation, ...scope }] }).state, "awaiting_report");
  }
});
test("expired, malformed expiry and revoked tokens do not confirm upload readiness", () => {
  for (const changes of [{ expiresAt: "2026-09-24T00:00:00Z" }, { expiresAt: "invalid" }, { revokedAt: "2026-09-24T00:00:00Z" }]) {
    assert.equal(buildOnboardingStatus({ ...input, tokens: [{ ...token, ...changes }] }).state, "needs_token");
  }
});
test("newer failed or unsafe reports override an earlier successful report regardless of input order", () => {
  for (const changes of [
    { status: "ERROR" as const }, { status: "REFUSED" as const }, { stage: "analysis" },
    { worktreeUnchanged: false }, { identityVerified: false }, { blockingWorkflowFindings: 1 },
  ]) {
    const failed = { ...observation, ...changes, id: "obs2", receivedAt: "2026-09-25T00:01:00Z" };
    for (const observations of [[failed, observation], [observation, failed]]) {
      assert.equal(buildOnboardingStatus({ ...input, observations }).state, "needs_attention");
    }
  }
});
test("unavailable reads and inactive repositories cannot appear successfully onboarded", () => {
  assert.equal(buildOnboardingStatus({ ...input, evidenceAvailable: false }).state, "unavailable");
  for (const status of ["pending", "paused", "removed"] as const) {
    assert.equal(buildOnboardingStatus({ ...input, repository: { ...repository, status } }).state, "inactive");
  }
});
