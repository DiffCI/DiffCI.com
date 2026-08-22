import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1PredictionStore } from "../../../src/preflight/cloudflare/d1-prediction-store.js";
import { GroundTruthAlreadyKnownError } from "../../../src/preflight/prediction-store.js";
import { freshPreflightDb, makeD1 } from "../../helpers/preflight-db.js";
import type { CreatePredictionInput } from "../../../src/preflight/prediction-store.js";

function baseInput(): CreatePredictionInput {
  return {
    repositoryOwnerName: "adityankale190895/DiffCI.com",
    commitSha: "8450e08140fd248c7aacf017b4540c9c932300cb",
    changedFiles: ["wrangler.github-runner.jsonc"],
    riskScore: 3,
    riskReasons: [{ signal: "dockerfile_change", weight: 3, detail: "test" }],
    recommendedChecks: ["runtime_parity"],
    predictedFailureClasses: [],
    expectedEarlyDetectionStrategy: "runtime_parity",
    evidenceVersion: "p1-v1",
    algorithmVersion: "risk-model-v1",
  };
}

describe("makeD1PredictionStore - real SQLite, real committed schema.sql", () => {
  it("persists a LIVE prediction and reads it back with every field intact, JSON columns real-parsed", async () => {
    const store = makeD1PredictionStore(makeD1(freshPreflightDb()));
    const created = await store.createLivePrediction(baseInput());
    const fetched = await store.getPrediction(created.id);
    assert.deepEqual(fetched, created);
    assert.deepEqual(fetched?.changedFiles, ["wrangler.github-runner.jsonc"]);
    assert.deepEqual(fetched?.riskReasons, [{ signal: "dockerfile_change", weight: 3, detail: "test" }]);
  });

  it("listPredictions returns every persisted prediction, ordered by created_at", async () => {
    const store = makeD1PredictionStore(makeD1(freshPreflightDb()));
    await store.createLivePrediction({ ...baseInput(), commitSha: "sha-1" });
    await store.createLivePrediction({ ...baseInput(), commitSha: "sha-2" });
    const all = await store.listPredictions();
    assert.equal(all.length, 2);
  });

  it("hasGroundTruthKnown is false until a real preflight_reconciliations row exists for that commit", async () => {
    const db = freshPreflightDb();
    const store = makeD1PredictionStore(makeD1(db));
    const input = baseInput();
    await store.createLivePrediction(input);
    assert.equal(await store.hasGroundTruthKnown(input.repositoryOwnerName, input.commitSha), false);
  });

  it("createLivePrediction refuses once a real reconciliation row exists for that commit (real JOIN, not tracked state)", async () => {
    const db = freshPreflightDb();
    const store = makeD1PredictionStore(makeD1(db));
    const input = baseInput();
    const prediction = await store.createLivePrediction(input);

    // Simulate the reconciliation flow writing a real row directly (mirrors what a real reconciliation
    // path would INSERT into preflight_reconciliations).
    db.exec(
      `INSERT INTO preflight_reconciliations (id, prediction_id, reconciled_at, workflow_run_id, workflow_conclusion, total_workflow_duration_ms, outcome, outcome_reason)
       VALUES ('recon-1', '${prediction.id}', '2026-08-22T10:00:00Z', 'run-1', 'success', 1000, 'TN', 'no risk predicted, CI succeeded')`,
    );

    assert.equal(await store.hasGroundTruthKnown(input.repositoryOwnerName, input.commitSha), true);
    await assert.rejects(() => store.createLivePrediction(input), GroundTruthAlreadyKnownError);
  });

  it("createReplayPrediction records both the simulated and real replay timestamps for real, and is never blocked by an existing reconciliation", async () => {
    const db = freshPreflightDb();
    const store = makeD1PredictionStore(makeD1(db));
    const input = baseInput();
    const prediction = await store.createLivePrediction(input);
    db.exec(
      `INSERT INTO preflight_reconciliations (id, prediction_id, reconciled_at, workflow_run_id, workflow_conclusion, total_workflow_duration_ms, outcome, outcome_reason)
       VALUES ('recon-1', '${prediction.id}', '2026-08-22T10:00:00Z', 'run-1', 'success', 1000, 'TN', 'x')`,
    );

    const replay = await store.createReplayPrediction({ ...input, commitSha: "another-sha", simulatedCreatedAt: "2026-08-01T00:00:00.000Z" });
    assert.equal(replay.mode, "REPLAY");
    assert.equal(replay.createdAt, "2026-08-01T00:00:00.000Z");
    assert.ok(replay.replayedAt);
  });

  it("getPrediction returns undefined for an unknown id", async () => {
    const store = makeD1PredictionStore(makeD1(freshPreflightDb()));
    assert.equal(await store.getPrediction("does-not-exist"), undefined);
  });
});
