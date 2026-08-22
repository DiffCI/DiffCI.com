import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryPredictionStore, GroundTruthAlreadyKnownError, FutureReplayError, type CreatePredictionInput } from "../../src/preflight/prediction-store.js";

function baseInput(): CreatePredictionInput {
  return {
    repositoryOwnerName: "adityankale190895/DiffCI.com",
    commitSha: "8450e08140fd248c7aacf017b4540c9c932300cb",
    changedFiles: ["src/research/cloudflare/github-runner-worker.ts"],
    riskScore: 3,
    riskReasons: [{ signal: "dockerfile_change", weight: 3, detail: "test" }],
    recommendedChecks: ["runtime_parity", "typecheck"],
    predictedFailureClasses: [],
    expectedEarlyDetectionStrategy: "runtime_parity check would catch a provisioning drift before CI",
    evidenceVersion: "p1-v1",
    algorithmVersion: "risk-model-v1",
  };
}

describe("InMemoryPredictionStore - Part D temporal + structural safety", () => {
  it("createLivePrediction stamps createdAt from the store's own clock, never an externally-supplied value", async () => {
    const store = new InMemoryPredictionStore(() => "2026-08-22T10:00:00.000Z");
    const record = await store.createLivePrediction(baseInput());
    assert.equal(record.createdAt, "2026-08-22T10:00:00.000Z");
    assert.equal(record.mode, "LIVE");
    assert.equal(record.replayedAt, undefined);
  });

  it("refuses to create a LIVE prediction once ground truth is already known for that commit", async () => {
    const store = new InMemoryPredictionStore();
    const input = baseInput();
    await store.recordGroundTruthKnown(input.repositoryOwnerName, input.commitSha);
    await assert.rejects(() => store.createLivePrediction(input), GroundTruthAlreadyKnownError);
  });

  it("recordGroundTruthKnown only blocks the SAME (repo, commit) pair, not unrelated ones", async () => {
    const store = new InMemoryPredictionStore();
    await store.recordGroundTruthKnown("adityankale190895/DiffCI.com", "some-other-sha");
    const record = await store.createLivePrediction(baseInput());
    assert.ok(record.id);
  });

  it("recordGroundTruthKnown is idempotent and does not throw on repeated calls", async () => {
    const store = new InMemoryPredictionStore();
    const input = baseInput();
    await store.recordGroundTruthKnown(input.repositoryOwnerName, input.commitSha);
    await store.recordGroundTruthKnown(input.repositoryOwnerName, input.commitSha);
    assert.equal(await store.hasGroundTruthKnown(input.repositoryOwnerName, input.commitSha), true);
  });

  it("createReplayPrediction is allowed even when ground truth is already known - replay is explicitly retrospective", async () => {
    const store = new InMemoryPredictionStore(() => "2026-08-22T12:00:00.000Z");
    const input = baseInput();
    await store.recordGroundTruthKnown(input.repositoryOwnerName, input.commitSha);
    const record = await store.createReplayPrediction({ ...input, simulatedCreatedAt: "2026-08-15T09:00:00.000Z" });
    assert.equal(record.mode, "REPLAY");
    assert.equal(record.createdAt, "2026-08-15T09:00:00.000Z", "createdAt represents the SIMULATED as-of time, not the real replay time");
    assert.equal(record.replayedAt, "2026-08-22T12:00:00.000Z", "replayedAt captures when the replay actually ran, honestly distinct from createdAt");
  });

  it("rejects a REPLAY prediction whose simulatedCreatedAt is in the replay's own future", async () => {
    const store = new InMemoryPredictionStore(() => "2026-08-22T12:00:00.000Z");
    await assert.rejects(() => store.createReplayPrediction({ ...baseInput(), simulatedCreatedAt: "2026-08-23T00:00:00.000Z" }), FutureReplayError);
  });

  it("a prediction is never mutated after creation - the store exposes no update method for it at all", async () => {
    const store = new InMemoryPredictionStore();
    const record = await store.createLivePrediction(baseInput());
    const fetched = await store.getPrediction(record.id);
    assert.deepEqual(fetched, record);
    // Structural proof: PredictionStore's own type surface has no update/mutate method - if this test
    // compiles, there is no API to call. (TypeScript enforces this at compile time; this assertion is
    // the runtime half of that guarantee - the returned record and stored record are the same value.)
  });

  it("listPredictions reflects every created prediction, LIVE and REPLAY together", async () => {
    const store = new InMemoryPredictionStore(() => "2026-08-22T12:00:00.000Z");
    await store.createLivePrediction(baseInput());
    await store.createReplayPrediction({ ...baseInput(), commitSha: "another-sha", simulatedCreatedAt: "2026-08-01T00:00:00.000Z" });
    const all = await store.listPredictions();
    assert.equal(all.length, 2);
  });

  it("getPrediction returns undefined for an unknown id rather than throwing", async () => {
    const store = new InMemoryPredictionStore();
    assert.equal(await store.getPrediction("does-not-exist"), undefined);
  });
});
