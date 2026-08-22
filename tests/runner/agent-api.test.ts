import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { handleRegister, handleHeartbeat, handleClaim, handleResult, type AgentApiDeps } from "../../src/runner/agent-api.js";
import { makeD1RunnerTokenStore } from "../../src/runner/token.js";
import { makeD1RunnerStore } from "../../src/runner/store.js";
import { makeD1ExecutionQueueStore } from "../../src/execution-queue/store.js";
import { makeD1UsageStore } from "../../src/usage/store.js";
import { createCloudflareContainersLiteCostModel } from "../../src/usage/cost-model.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";
import type { DatabaseSync } from "node:sqlite";

function seedFixture(db: DatabaseSync) {
  db.exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org-1', 'Acme', 'acme', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO organizations (id, name, slug, created_at, updated_at) VALUES ('org-2', 'Other', 'other', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO runners (id, organization_id, provider, status, requested_resource_class, created_at) VALUES ('runner-1', 'org-1', 'cloudflare-containers-async', 'assigned', 'lite', '2026-01-01T00:00:00Z')`);
  db.exec(`INSERT INTO execution_queue_items (id, organization_id, job_reference, requested_resource_class, priority, status, attempts, max_attempts, created_at, updated_at) VALUES ('job-1', 'org-1', 'node -e "console.log(''diffci-runner-ok'')"', 'lite', 100, 'assigned', 1, 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
}

interface AuditEvent {
  organizationId: string;
  action: string;
  targetType: string;
  targetId: string;
  metadata?: Record<string, unknown>;
}

function makeDeps(db: DatabaseSync): { deps: AgentApiDeps; auditEvents: AuditEvent[] } {
  const auditEvents: AuditEvent[] = [];
  const deps: AgentApiDeps = {
    tokenStore: makeD1RunnerTokenStore(makeD1(db)),
    runnerStore: makeD1RunnerStore(makeD1(db)),
    queueStore: makeD1ExecutionQueueStore(makeD1(db)),
    usageStore: makeD1UsageStore(makeD1(db)),
    costModel: createCloudflareContainersLiteCostModel(),
    recordAuditEvent: async (entry) => {
      auditEvents.push(entry);
    },
  };
  return { deps, auditEvents };
}

describe("handleRegister", () => {
  it("succeeds with a valid token, records a heartbeat and an audit event", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps, auditEvents } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });

    const result = await handleRegister(raw, deps);
    assert.equal(result.ok, true);
    assert.equal(result.data?.runnerId, "runner-1");

    const runner = await deps.runnerStore.getRunner("runner-1");
    assert.ok(runner?.lastHeartbeatAt);
    assert.ok(auditEvents.some((e) => e.action === "runner.registered"));
  });

  it("rejects an unknown token with invalid_token, does nothing else", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps, auditEvents } = makeDeps(db);
    const result = await handleRegister("not-a-real-token", deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_token");
    assert.equal(auditEvents.length, 0);
  });

  it("rejects an expired token", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: -1000 });
    const result = await handleRegister(raw, deps);
    assert.equal(result.error, "token_expired");
  });
});

describe("handleHeartbeat", () => {
  it("updates last_heartbeat_at for a valid token", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    const result = await handleHeartbeat(raw, deps);
    assert.equal(result.ok, true);
    const runner = await deps.runnerStore.getRunner("runner-1");
    assert.ok(runner?.lastHeartbeatAt);
  });
});

describe("handleClaim", () => {
  it("returns the real command from the queue item and transitions the runner to busy", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps, auditEvents } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });

    const result = await handleClaim(raw, deps);
    assert.equal(result.ok, true);
    assert.equal(result.data?.jobId, "job-1");
    assert.match(result.data!.command, /diffci-runner-ok/);

    const runner = await deps.runnerStore.getRunner("runner-1");
    assert.equal(runner?.status, "busy");
    assert.ok(auditEvents.some((e) => e.action === "runner.execution_started"));
  });

  it("rejects a second claim attempt with the same token - token replay (Part 28)", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });

    const first = await handleClaim(raw, deps);
    assert.equal(first.ok, true);
    const second = await handleClaim(raw, deps);
    assert.equal(second.ok, false);
    assert.equal(second.error, "already_claimed");
  });

  it("a token minted for one job cannot claim a different job - only its own bound job is ever returned", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    db.exec(`INSERT INTO execution_queue_items (id, organization_id, job_reference, requested_resource_class, priority, status, attempts, max_attempts, created_at, updated_at) VALUES ('job-2', 'org-1', 'rm -rf /', 'lite', 100, 'assigned', 1, 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    const { deps } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });

    const result = await handleClaim(raw, deps);
    assert.equal(result.data?.jobId, "job-1");
    assert.notEqual(result.data?.command, "rm -rf /", "a token scoped to job-1 must never surface job-2's command");
  });

  it("cross-organization isolation: a token minted for org-1 always resolves to org-1, never org-2, regardless of request content", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    db.exec(`INSERT INTO runners (id, organization_id, provider, status, requested_resource_class, created_at) VALUES ('runner-2', 'org-2', 'cloudflare-containers-async', 'assigned', 'lite', '2026-01-01T00:00:00Z')`);
    db.exec(`INSERT INTO execution_queue_items (id, organization_id, job_reference, requested_resource_class, priority, status, attempts, max_attempts, created_at, updated_at) VALUES ('job-org2', 'org-2', 'echo org-2-secret', 'lite', 100, 'assigned', 1, 3, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`);
    const { deps, auditEvents } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });

    const result = await handleClaim(raw, deps);
    assert.equal(result.data?.jobId, "job-1");
    const auditEvent = auditEvents.find((e) => e.action === "runner.execution_started");
    assert.equal(auditEvent?.organizationId, "org-1", "the token's own bound organization is what's recorded, never inferable/spoofable from elsewhere");
  });
});

describe("handleResult", () => {
  async function claimedFixture() {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps, auditEvents } = makeDeps(db);
    const { raw } = await deps.tokenStore.issueToken({ runnerId: "runner-1", jobId: "job-1", organizationId: "org-1", ttlMs: 60_000 });
    await handleClaim(raw, deps);
    return { db, deps, auditEvents, raw };
  }

  it("transitions to completed, computes real cost, records usage events exactly once each", async () => {
    const { deps, auditEvents, raw } = await claimedFixture();
    const result = await handleResult({ token: raw, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 1500 }, deps);
    assert.equal(result.ok, true);
    assert.equal(result.data?.runtimeSeconds, 1.5);
    assert.ok(result.data!.costEstimateUsd > 0);

    const runner = await deps.runnerStore.getRunner("runner-1");
    assert.equal(runner?.status, "completed");
    assert.equal(runner?.costBasis, "provider_estimate");

    const events = await deps.usageStore.listEventsInRange("org-1", "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    assert.equal(events.filter((e) => e.eventType === "runner_seconds").length, 1);
    assert.equal(events.filter((e) => e.eventType === "runner_job").length, 1);
    assert.ok(auditEvents.some((e) => e.action === "runner.execution_completed"));
  });

  it("a duplicate result submission is a safe no-op - no second usage event, no error", async () => {
    const { deps, raw } = await claimedFixture();
    const first = await handleResult({ token: raw, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 1500 }, deps);
    assert.equal(first.data?.duplicate, undefined);

    const second = await handleResult({ token: raw, exitCode: 0, stdout: "diffci-runner-ok\n", durationMs: 1500 }, deps);
    assert.equal(second.ok, true);
    assert.equal(second.data?.duplicate, true);

    const events = await deps.usageStore.listEventsInRange("org-1", "2020-01-01T00:00:00Z", "2030-01-01T00:00:00Z");
    assert.equal(events.filter((e) => e.eventType === "runner_seconds").length, 1, "must still be exactly one - never double-billed");
    assert.equal(events.filter((e) => e.eventType === "runner_job").length, 1);
  });

  it("truncates stdout/stderr to the output cap (Part 17) rather than storing unbounded logs", async () => {
    const { deps, auditEvents, raw } = await claimedFixture();
    const hugeOutput = "x".repeat(10_000);
    await handleResult({ token: raw, exitCode: 0, stdout: hugeOutput, durationMs: 500 }, deps);
    const auditEvent = auditEvents.find((e) => e.action === "runner.execution_completed");
    assert.equal(auditEvent?.metadata?.stdoutTruncated, true);
    assert.ok((auditEvent?.metadata?.stdoutPreview as string).length <= 200);
  });

  it("rejects an unknown/invalid token entirely - no transition, no usage event", async () => {
    const db = freshProductDb(["runner", "execution-queue", "usage"]);
    seedFixture(db);
    const { deps } = makeDeps(db);
    const result = await handleResult({ token: "garbage", exitCode: 0, stdout: "x", durationMs: 100 }, deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_token");
    const runner = await deps.runnerStore.getRunner("runner-1");
    assert.equal(runner?.status, "assigned", "must remain untouched");
  });
});
