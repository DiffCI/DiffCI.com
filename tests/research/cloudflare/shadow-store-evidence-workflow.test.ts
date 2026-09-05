/**
 * shadow-store.ts workflow identity additions (2026-09-05, measurement-integrity repair step 2):
 * per-repository evidence workflow configuration and the ground-truth validity label. Real SQLite via
 * node:sqlite, real migration files, same harness as shadow-store.test.ts.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ShadowStore, type D1Binding, type RecordGroundTruthInput, type RecordPredictionInput } from "../../../src/research/cloudflare/shadow-store.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/research/cloudflare");
const MIGRATIONS_BEFORE_IDENTITY = [
  "schema-migration-2026-08-21-stage2-shadow.sql",
  "schema-migration-2026-08-21-shadow-cron.sql",
  "schema-migration-2026-08-21-shadow-webhook.sql",
  "schema-migration-2026-08-21-shadow-source-integrity.sql",
  "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql",
  "schema-migration-2026-08-25-shadow-economics.sql",
  "schema-migration-2026-08-26-shadow-liveness.sql",
  "schema-migration-2026-09-04-shadow-push-polls.sql",
  "schema-migration-2026-09-05-shadow-reconcile-terminal.sql",
];
const IDENTITY_MIGRATION = "schema-migration-2026-09-05-shadow-evidence-workflow.sql";

function dbWith(files: string[]): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of files) db.exec(readFileSync(join(SCHEMA_DIR, file), "utf8"));
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
    testsTotalFull: 10, diffciAnalysisOverheadMs: 100, predictionCreatedAt: "2026-08-21T12:00:00.000Z", ...overrides,
  };
}

function groundTruth(overrides: Partial<RecordGroundTruthInput> & { logicalEventKey: string; logicalDeltaKey: string }): RecordGroundTruthInput {
  return {
    repository: "acme/web", headSha: "head", workflowRunAttempt: 1, eventType: "poll-detected", groundTruthStatus: "COMPLETE",
    relevantFailuresObserved: 0, relevantFailuresEvaluable: 0, failuresPreservedByDiffci: 0, failuresPreservedByPath: 0,
    predictionPrecededGroundTruth: true, groundTruthFetchedAt: "2026-08-21T12:00:00.000Z", ...overrides,
  };
}

describe("shadow-store: evidence workflow identity", () => {
  it("evidence workflow paths are unconfigured until explicitly set, then round-trip", async () => {
    const db = dbWith([...MIGRATIONS_BEFORE_IDENTITY, IDENTITY_MIGRATION]);
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "github-app-webhook");
    assert.equal(await store.getEvidenceWorkflowPaths("acme/web"), undefined);
    assert.deepEqual(await store.setEvidenceWorkflowPaths("acme/web", [".github/workflows/ci.yml"]), { changed: true });
    assert.deepEqual(await store.getEvidenceWorkflowPaths("acme/web"), [".github/workflows/ci.yml"]);
    assert.deepEqual(await store.setEvidenceWorkflowPaths("acme/none", [".github/workflows/ci.yml"]), { changed: false }, "an unenrolled repository cannot be configured");
    db.prepare(`UPDATE shadow_repositories SET evidence_workflow_paths = ? WHERE repository = ?`).run("not json", "acme/web");
    assert.equal(await store.getEvidenceWorkflowPaths("acme/web"), undefined, "garbage reads as unconfigured, never as a workflow");
  });

  it("recordGroundTruth stores VERIFIED with the evidence workflow path under identity mode, UNVERIFIED without it", async () => {
    const db = dbWith([...MIGRATIONS_BEFORE_IDENTITY, IDENTITY_MIGRATION]);
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p2", headSha: "h2" }), "r2/p2");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "p1", evidenceWorkflowPath: ".github/workflows/ci.yml" }), "r2/ge1");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge2", logicalDeltaKey: "p2" }), "r2/ge2");
    // node:sqlite rows have a null prototype - re-materialise as plain objects before deep-equal.
    const rows = (db.prepare(`SELECT logical_event_key k, evidence_workflow_path p, evidence_validity v FROM shadow_ground_truth ORDER BY k`).all() as { k: string; p: string | null; v: string }[]).map((r) => ({ k: r.k, p: r.p, v: r.v }));
    assert.deepEqual(rows, [
      { k: "ge1", p: ".github/workflows/ci.yml", v: "VERIFIED" },
      { k: "ge2", p: null, v: "UNVERIFIED" },
    ]);
  });

  it("the migration labels every pre-existing ground-truth row UNVERIFIED, and setGroundTruthValidity re-labels without deleting", async () => {
    const db = dbWith(MIGRATIONS_BEFORE_IDENTITY);
    const before = makeD1ShadowStore(makeD1(db));
    await before.ensureRepository("acme/web", "cloudflare-poll");
    await before.recordPrediction(prediction({ logicalDeltaKey: "old" }), "r2/old");
    // A row exactly as the pre-identity reconciler wrote it (raw SQL: the current store already names
    // the new columns, which is also why the migration is applied BEFORE the Worker is deployed).
    db.prepare(
      `INSERT INTO shadow_ground_truth (logical_event_key, logical_delta_key, repository, head_sha, workflow_run_attempt, event_type, ground_truth_status,
         relevant_failures_observed, relevant_failures_evaluable, failures_preserved_by_diffci, failures_preserved_by_path, prediction_preceded_ground_truth,
         r2_evidence_key, ground_truth_fetched_at, created_at)
       VALUES ('ge-old', 'old', 'acme/web', 'head', 1, 'poll-detected', 'COMPLETE', 0, 0, 0, 0, 1, 'r2/ge-old', '2026-08-21T12:00:00.000Z', '2026-08-21T12:00:00.000Z')`,
    ).run();

    db.exec(readFileSync(join(SCHEMA_DIR, IDENTITY_MIGRATION), "utf8"));
    const after = makeD1ShadowStore(makeD1(db));
    const read = () => {
      const r = db.prepare(`SELECT evidence_validity v, evidence_workflow_path p FROM shadow_ground_truth WHERE logical_event_key = 'ge-old'`).get() as { v: string; p: string | null };
      return { v: r.v, p: r.p };
    };
    assert.deepEqual(read(), { v: "UNVERIFIED", p: null });
    assert.deepEqual(await after.setGroundTruthValidity("ge-old", "CONTAMINATED_WORKFLOW_IDENTITY", ".github/workflows/codeql.yml"), { changed: true });
    assert.deepEqual(read(), { v: "CONTAMINATED_WORKFLOW_IDENTITY", p: ".github/workflows/codeql.yml" });
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM shadow_ground_truth`).get() as { n: number }).n, 1, "never deleted");
  });
});
