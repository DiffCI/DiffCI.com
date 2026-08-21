import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, it } from "node:test";
import { handleShadowWebhook, type ShadowWebhookDeps } from "../../../src/research/cloudflare/shadow-webhook.js";
import { verifyWebhookSignature } from "../../../src/shadow/github-app.js";

const SECRET = "test-webhook-secret";

function sign(rawBody: string): string {
  return `sha256=${createHmac("sha256", SECRET).update(rawBody).digest("hex")}`;
}

interface FakeCalls {
  enrolled: Array<{ repository: string; language: string }>;
  installationIds: Array<{ repository: string; installationId: string }>;
  polls: string[];
  reconciles: string[];
  logs: string[];
}

function makeDeps(): { deps: ShadowWebhookDeps; calls: FakeCalls } {
  const calls: FakeCalls = { enrolled: [], installationIds: [], polls: [], reconciles: [], logs: [] };
  const deps: ShadowWebhookDeps = {
    // The REAL HMAC implementation, bound to the test secret - signature handling is the security
    // boundary of this route, so the tests must exercise it, not a stub.
    verifySignature: (body, signature) => verifyWebhookSignature(body, signature, SECRET),
    ensureRepository: async (repository, language) => {
      calls.enrolled.push({ repository, language });
    },
    setInstallationId: async (repository, installationId) => {
      calls.installationIds.push({ repository, installationId });
    },
    schedulePoll: (repository) => calls.polls.push(repository),
    scheduleReconcile: (repository) => calls.reconciles.push(repository),
    log: (m) => calls.logs.push(m),
  };
  return { deps, calls };
}

async function deliver(eventName: string, payload: unknown, deps: ShadowWebhookDeps, options?: { badSignature?: boolean }) {
  const rawBody = JSON.stringify(payload);
  const signature = options?.badSignature ? `sha256=${"0".repeat(64)}` : sign(rawBody);
  return handleShadowWebhook(eventName, signature, rawBody, deps);
}

describe("handleShadowWebhook", () => {
  it("rejects an invalid signature with 401 and processes nothing - ping included", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await deliver("ping", { zen: "hi" }, deps, { badSignature: true });
    assert.equal(outcome.status, 401);
    const pushOutcome = await handleShadowWebhook("push", null, JSON.stringify({}), deps);
    assert.equal(pushOutcome.status, 401, "a missing signature header must also be rejected");
    assert.deepEqual(calls.polls, []);
    assert.deepEqual(calls.enrolled, []);
  });

  it("answers a correctly signed ping", async () => {
    const { deps } = makeDeps();
    const outcome = await deliver("ping", { zen: "Design for failure." }, deps);
    assert.equal(outcome.status, 200);
    assert.equal(outcome.body.action, "pong");
  });

  it("rejects a signed but unparsable body", async () => {
    const { deps } = makeDeps();
    const rawBody = "not-json{";
    const outcome = await handleShadowWebhook("push", sign(rawBody), rawBody, deps);
    assert.equal(outcome.status, 400);
  });

  it("enrolls repositories and records the installation id on installation created", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await deliver(
      "installation",
      { action: "created", installation: { id: 12345 }, repositories: [{ full_name: "acme/web" }, { full_name: "acme/api" }, { full_name: "bad name!!" }] },
      deps,
    );
    assert.equal(outcome.status, 200);
    assert.deepEqual(calls.enrolled.map((e) => e.repository), ["acme/web", "acme/api"], "an invalid full_name must be filtered, not enrolled");
    assert.deepEqual(calls.installationIds, [
      { repository: "acme/web", installationId: "12345" },
      { repository: "acme/api", installationId: "12345" },
    ]);
  });

  it("acknowledges an uninstall without changing repository state", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await deliver("installation", { action: "deleted", installation: { id: 12345 } }, deps);
    assert.equal(outcome.status, 200);
    assert.deepEqual(calls.enrolled, []);
    assert.equal(calls.logs.filter((l) => l.includes("deleted")).length, 1);
  });

  it("enrolls repositories added to an existing installation", async () => {
    const { deps, calls } = makeDeps();
    await deliver(
      "installation_repositories",
      { action: "added", installation: { id: 777 }, repositories_added: [{ full_name: "acme/new" }], repositories_removed: [] },
      deps,
    );
    assert.deepEqual(calls.enrolled.map((e) => e.repository), ["acme/new"]);
    assert.deepEqual(calls.installationIds, [{ repository: "acme/new", installationId: "777" }]);
  });

  it("schedules an immediate poll for a default-branch push", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await deliver(
      "push",
      { ref: "refs/heads/main", repository: { full_name: "acme/web", default_branch: "main" }, installation: { id: 42 } },
      deps,
    );
    assert.equal(outcome.body.action, "poll-scheduled");
    assert.deepEqual(calls.polls, ["acme/web"]);
    assert.deepEqual(calls.enrolled.map((e) => e.repository), ["acme/web"], "push must auto-enroll on first contact");
    assert.deepEqual(calls.installationIds, [{ repository: "acme/web", installationId: "42" }]);
  });

  it("ignores a push to a non-default branch", async () => {
    const { deps, calls } = makeDeps();
    const outcome = await deliver(
      "push",
      { ref: "refs/heads/feature-x", repository: { full_name: "acme/web", default_branch: "main" } },
      deps,
    );
    assert.equal(outcome.body.action, "push-non-default-branch-ignored");
    assert.deepEqual(calls.polls, []);
  });

  it("schedules reconciliation when a workflow run completes, and only then", async () => {
    const { deps, calls } = makeDeps();
    const completed = await deliver("workflow_run", { action: "completed", repository: { full_name: "acme/web" } }, deps);
    assert.equal(completed.body.action, "reconcile-scheduled");
    const requested = await deliver("workflow_run", { action: "requested", repository: { full_name: "acme/web" } }, deps);
    assert.equal(requested.body.action, "workflow-run-not-completed-ignored");
    assert.deepEqual(calls.reconciles, ["acme/web"]);
  });

  it("acknowledges pull_request as explicitly not-yet-supported and unknown events as ignored", async () => {
    const { deps, calls } = makeDeps();
    const pr = await deliver("pull_request", { action: "opened", repository: { full_name: "acme/web" } }, deps);
    assert.equal(pr.body.action, "pull-request-not-yet-supported");
    const star = await deliver("star", { action: "created" }, deps);
    assert.equal(star.status, 200);
    assert.equal(star.body.action, "ignored");
    assert.deepEqual(calls.polls, []);
    assert.deepEqual(calls.reconciles, []);
  });
});
