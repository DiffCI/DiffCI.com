/**
 * Step 3 persistence (2026-09-05): the shadow_stage_economics migration, the stage store, the
 * repository stage-classification config, the verified-ground-truth read, and the self-health
 * invariants - all against real SQLite with the real migration files in production order.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ShadowStore, type D1Binding, type RecordGroundTruthInput, type RecordPredictionInput } from "../../../src/research/cloudflare/shadow-store.js";
import { makeD1ShadowStageEconomicsStore } from "../../../src/usage/shadow-stage-economics-store.js";
import { makeD1ShadowReadBoundary } from "../../../src/product/shadow-read-boundary.js";
import type { StageEconomicsObservation } from "../../../src/usage/shadow-stage-economics.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/research/cloudflare");
const MIGRATIONS = [
  "schema-migration-2026-08-21-stage2-shadow.sql",
  "schema-migration-2026-08-21-shadow-cron.sql",
  "schema-migration-2026-08-21-shadow-webhook.sql",
  "schema-migration-2026-08-21-shadow-source-integrity.sql",
  "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql",
  "schema-migration-2026-08-25-shadow-economics.sql",
  "schema-migration-2026-08-26-shadow-liveness.sql",
  "schema-migration-2026-09-04-shadow-push-polls.sql",
  "schema-migration-2026-09-05-shadow-reconcile-terminal.sql",
  "schema-migration-2026-09-05-shadow-evidence-workflow.sql",
  "schema-migration-2026-09-05-shadow-stage-economics.sql",
];

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of MIGRATIONS) db.exec(readFileSync(join(SCHEMA_DIR, file), "utf8"));
  return db;
}

function makeD1(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
            async run() {
              const result = db.prepare(query).run(...(values as never[]));
              return { meta: { changes: Number(result.changes) } };
            },
            async all<T = unknown>() {
              return { results: db.prepare(query).all(...(values as never[])) as T[] };
            },
            async first<T = unknown>() {
              return (db.prepare(query).get(...(values as never[])) ?? null) as T | null;
            },
          };
        },
      };
    },
  };
}

function prediction(overrides: Partial<RecordPredictionInput> & { logicalDeltaKey: string }): RecordPredictionInput {
  return {
    repository: "acme/web", baseSha: "base", headSha: "head", diffciAnalysisVersion: "v1", graphVersion: "v1",
    shadowSchemaVersion: "stage2-shadow-poll-1", observationSource: "cloudflare-poll", planMode: "SELECTIVE", fallback: false,
    effectiveGraphConfidence: "COMPLETE", opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY", testsSelectedDiffci: 1, testsSelectedPath: 2,
    testsTotalFull: 10, diffciAnalysisOverheadMs: 100, predictionCreatedAt: "2026-09-04T12:00:00.000Z", ...overrides,
  };
}

function groundTruth(overrides: Partial<RecordGroundTruthInput> & { logicalEventKey: string; logicalDeltaKey: string }): RecordGroundTruthInput {
  return {
    repository: "acme/web", headSha: "head", workflowRunId: "555", workflowRunAttempt: 1, eventType: "poll-detected", groundTruthStatus: "COMPLETE",
    relevantFailuresObserved: 0, relevantFailuresEvaluable: 0, failuresPreservedByDiffci: 0, failuresPreservedByPath: 0,
    predictionPrecededGroundTruth: true, groundTruthFetchedAt: "2026-09-04T12:05:00.000Z", ...overrides,
  };
}

function observation(overrides: Partial<StageEconomicsObservation> & { logicalDeltaKey: string; stage: StageEconomicsObservation["stage"] }): StageEconomicsObservation {
  return {
    classificationBasis: "explicit_step", classifierVersion: 1, repository: "acme/web", headSha: "head", evidenceRunId: "555",
    evidenceWorkflowPath: ".github/workflows/ci.yml", evidenceValidity: "VERIFIED", jobIds: [1], stepRefs: ["check :: Test"], fullWorkloadMs: 80_000,
    testsTotalFull: 10, testsSelectedDiffci: 1, testsSelectedPath: 2, planMode: "SELECTIVE", diffciAnalysisOverheadMs: 100,
    selectedWorkloadMs: 8_000, selectedWorkloadConfidence: "count_based_estimate", avoidableMs: 72_000, avoidableTier: "ESTIMATED",
    estimationMethod: "own_commit_test_ratio", estimatorVersion: 2, observedAt: "2026-09-05T07:00:00.000Z", ...overrides,
  };
}

describe("step 3 persistence", () => {
  it("the migration labels legacy economics rows LEGACY_UNVERIFIED and creates the admitted table", () => {
    const db = freshDb();
    db.prepare(`INSERT INTO shadow_economics_observations (logical_delta_key, stage, repository, head_sha, full_workload_ms, avoidable_tier, schema_version, observed_at) VALUES ('legacy','other','acme/web','h',1000,'UNKNOWN',1,'2026-09-01T00:00:00Z')`).run();
    // The UPDATE in the migration ran before this insert; the column exists and a re-run of the migration's UPDATE labels it.
    db.exec(`UPDATE shadow_economics_observations SET evidence_validity = 'LEGACY_UNVERIFIED' WHERE evidence_validity IS NULL`);
    const row = db.prepare(`SELECT evidence_validity v FROM shadow_economics_observations WHERE logical_delta_key = 'legacy'`).get() as { v: string };
    assert.equal(row.v, "LEGACY_UNVERIFIED");
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM shadow_stage_economics`).get() as { n: number }).n, 0);
  });

  it("stage store: recordIfNew dedups on (delta, stage), listRecordedDeltaKeys and the prediction-window read round-trip", async () => {
    const db = freshDb();
    const shadow = makeD1ShadowStore(makeD1(db));
    const stage = makeD1ShadowStageEconomicsStore(makeD1(db));
    await shadow.ensureRepository("acme/web", "github-app-webhook");
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "k1" }), "r2/k1");
    assert.equal(await stage.recordIfNew(observation({ logicalDeltaKey: "k1", stage: "test" })), true);
    assert.equal(await stage.recordIfNew(observation({ logicalDeltaKey: "k1", stage: "test", fullWorkloadMs: 1 })), false, "never overwritten");
    assert.equal(await stage.recordIfNew(observation({ logicalDeltaKey: "k1", stage: "other", classificationBasis: "unclassified", avoidableTier: "UNKNOWN", avoidableMs: undefined })), true);
    assert.deepEqual(await stage.listRecordedDeltaKeys("acme/web"), ["k1"]);
    const rows = await stage.listForPredictionWindow("acme/web", "2026-09-01T00:00:00.000Z", "2099-01-01T00:00:00.000Z"); // created_at is write time
    assert.equal(rows.length, 2);
    const test = rows.find((r) => r.stage === "test")!;
    assert.equal(test.fullWorkloadMs, 80_000);
    assert.equal(test.classificationBasis, "explicit_step");
    assert.deepEqual(test.stepRefs, ["check :: Test"]);
    assert.equal(test.evidenceRunId, "555");
    assert.equal(test.evidenceValidity, "VERIFIED");
    assert.deepEqual(await stage.listForPredictionWindow("acme/web", "2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z"), [], "selected by the prediction window, not capture time");
  });

  it("listVerifiedGroundTruth admits VERIFIED rows only, with the evidence run", async () => {
    const db = freshDb();
    const shadow = makeD1ShadowStore(makeD1(db));
    await shadow.ensureRepository("acme/web", "github-app-webhook");
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "v", headSha: "hv" }), "r2/v");
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "u", headSha: "hu" }), "r2/u");
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "c", headSha: "hc" }), "r2/c");
    await shadow.recordGroundTruth(groundTruth({ logicalEventKey: "ge-v", logicalDeltaKey: "v", workflowRunId: "901", evidenceWorkflowPath: ".github/workflows/ci.yml" }), "r2/ge-v");
    await shadow.recordGroundTruth(groundTruth({ logicalEventKey: "ge-u", logicalDeltaKey: "u", workflowRunId: "902" }), "r2/ge-u");
    await shadow.recordGroundTruth(groundTruth({ logicalEventKey: "ge-c", logicalDeltaKey: "c", workflowRunId: "903", evidenceWorkflowPath: ".github/workflows/ci.yml" }), "r2/ge-c");
    await shadow.setGroundTruthValidity("ge-c", "CONTAMINATED_WORKFLOW_IDENTITY");
    const boundary = makeD1ShadowReadBoundary(makeD1(db) as never);
    const rows = await boundary.listVerifiedGroundTruth("acme/web", "2026-09-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z");
    assert.deepEqual(rows.map((r) => [r.logicalDeltaKey, r.evidenceRunId, r.evidenceWorkflowPath]), [["v", "901", ".github/workflows/ci.yml"]]);
    assert.equal(rows[0]!.testsTotalFull, 10);
  });

  it("stage classification config is unconfigured until set, then round-trips as raw JSON", async () => {
    const db = freshDb();
    const shadow = makeD1ShadowStore(makeD1(db));
    await shadow.ensureRepository("acme/web", "github-app-webhook");
    assert.equal(await shadow.getStageClassificationRaw("acme/web"), undefined);
    const json = JSON.stringify({ version: 1, jobs: [{ job: "check", stage: "test", inseparable: true }], steps: [] });
    assert.deepEqual(await shadow.setStageClassificationRaw("acme/web", json), { changed: true });
    assert.equal(await shadow.getStageClassificationRaw("acme/web"), json);
    assert.deepEqual(await shadow.setStageClassificationRaw("acme/none", json), { changed: false });
  });

  it("self-health invariants surface the never-attempted backlog, unlabelled rows, the stage backlog, and unconfigured / unverified repositories", async () => {
    const db = freshDb();
    const shadow = makeD1ShadowStore(makeD1(db));
    const stage = makeD1ShadowStageEconomicsStore(makeD1(db));
    await shadow.ensureRepository("acme/web", "github-app-webhook");
    await shadow.ensureRepository("acme/api", "cloudflare-poll");
    await shadow.setRepositoryState("acme/web", "SHADOW_ACTIVE");
    await shadow.setRepositoryState("acme/api", "SHADOW_ACTIVE");
    await shadow.setEvidenceWorkflowPaths("acme/web", [".github/workflows/ci.yml"]);
    // web: one verified row with stage economics, one verified row without, one never-attempted prediction.
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "w1", headSha: "w1" }), "r2/w1");
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "w2", headSha: "w2" }), "r2/w2");
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "w3", headSha: "w3", predictionCreatedAt: "2026-09-04T00:00:00.000Z" }), "r2/w3");
    await shadow.recordGroundTruth(groundTruth({ logicalEventKey: "ge-w1", logicalDeltaKey: "w1", evidenceWorkflowPath: ".github/workflows/ci.yml" }), "r2/ge-w1");
    await shadow.recordGroundTruth(groundTruth({ logicalEventKey: "ge-w2", logicalDeltaKey: "w2", evidenceWorkflowPath: ".github/workflows/ci.yml" }), "r2/ge-w2");
    await stage.recordIfNew(observation({ logicalDeltaKey: "w1", stage: "test" }));
    // api: predictions but nothing verified, and no evidence workflow.
    await shadow.recordPrediction(prediction({ logicalDeltaKey: "a1", repository: "acme/api", headSha: "a1" }), "r2/a1");
    await shadow.recordReconcileAttempt("a1", "evidence_workflow_unconfigured", "2026-09-05T06:00:00.000Z");
    // a row written in the migration/deploy race: no label at all.
    db.prepare(`UPDATE shadow_ground_truth SET evidence_validity = NULL WHERE logical_event_key = 'ge-w2'`).run();

    const h = await shadow.getSelfHealth("2026-09-05T06:00:00.000Z");
    assert.equal(h.neverAttemptedPredictions, 1, "w3 only - a1 was attempted (and held)");
    assert.equal(h.oldestNeverAttemptedAgeMs, 30 * 60 * 60 * 1000);
    assert.equal(h.unlabelledGroundTruthRows, 1);
    assert.equal(h.verifiedWithoutStageEconomics, 0, "w1 is measured; w2 is no longer VERIFIED once unlabelled");
    assert.deepEqual(h.unconfiguredEvidenceRepositories, ["acme/api"]);
    assert.deepEqual(h.observedWithoutVerifiedGroundTruth, ["acme/api"]);
  });
});
