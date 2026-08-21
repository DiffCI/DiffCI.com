/**
 * Real-SQLite-backed tests for shadow-store.ts (2026-08-21 source-integrity fix added the engine_source_sha
 * / source_integrity_status columns tested here). Uses node:sqlite's DatabaseSync rather than a hand-rolled
 * fake: D1 is SQLite-compatible, so this both exercises the real query strings AND validates that the
 * actual committed migration .sql files apply cleanly in the real order they'd be applied in production -
 * a fake object graph couldn't catch a typo in the migration files themselves.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ShadowStore, type D1Binding, type RecordPredictionInput } from "../../../src/research/cloudflare/shadow-store.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/research/cloudflare");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  // Real production apply order (see each file's own header comment for the `wrangler d1 execute` command
  // this mirrors) - if any of these files had a typo or ordering dependency violation, this throws.
  for (const file of [
    "schema-migration-2026-08-21-stage2-shadow.sql",
    "schema-migration-2026-08-21-shadow-cron.sql",
    "schema-migration-2026-08-21-shadow-webhook.sql",
    "schema-migration-2026-08-21-shadow-source-integrity.sql",
  ]) {
    db.exec(readFileSync(join(SCHEMA_DIR, file), "utf8"));
  }
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
              const rows = db.prepare(query).all(...(values as never[]));
              return { results: rows as T[] };
            },
            async first<T = unknown>() {
              const row = db.prepare(query).get(...(values as never[]));
              return (row ?? null) as T | null;
            },
          };
        },
      };
    },
  };
}

function prediction(overrides: Partial<RecordPredictionInput> & { logicalDeltaKey: string }): RecordPredictionInput {
  return {
    repository: "acme/web",
    baseSha: "base",
    headSha: "head",
    diffciAnalysisVersion: "v1",
    graphVersion: "v1",
    shadowSchemaVersion: "stage2-shadow-poll-1",
    observationSource: "cloudflare-poll",
    planMode: "SELECTIVE",
    fallback: false,
    effectiveGraphConfidence: "COMPLETE",
    opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY",
    testsSelectedDiffci: 1,
    testsSelectedPath: 2,
    testsTotalFull: 10,
    diffciAnalysisOverheadMs: 100,
    predictionCreatedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

const ENGINE_SHA = "aaaa111111111111111111111111111111111111";

describe("shadow-store: engine_source_sha", () => {
  it("recordPrediction persists a supplied engineSourceSha", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "k1", engineSourceSha: ENGINE_SHA }), "r2/k1");

    const row = db.prepare(`SELECT engine_source_sha FROM shadow_predictions WHERE logical_delta_key = ?`).get("k1") as { engine_source_sha: string | null };
    assert.equal(row.engine_source_sha, ENGINE_SHA);
  });

  it("recordPrediction stores NULL (not a placeholder string) when engineSourceSha is omitted - genuine uncertainty is preserved, never guessed", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "k2" }), "r2/k2");

    const row = db.prepare(`SELECT engine_source_sha FROM shadow_predictions WHERE logical_delta_key = ?`).get("k2") as { engine_source_sha: string | null };
    assert.equal(row.engine_source_sha, null);
  });

  it("getRepositorySummary reports the most recent prediction's engine SHA", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "older", engineSourceSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }), "r2/older");
    db.prepare(`UPDATE shadow_predictions SET created_at = ? WHERE logical_delta_key = ?`).run("2026-08-21T10:00:00.000Z", "older");
    await store.recordPrediction(prediction({ logicalDeltaKey: "newer", engineSourceSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }), "r2/newer");
    db.prepare(`UPDATE shadow_predictions SET created_at = ? WHERE logical_delta_key = ?`).run("2026-08-21T11:00:00.000Z", "newer");

    const summary = await store.getRepositorySummary("acme/web");
    assert.equal(summary?.predictionsRecorded, 2);
    assert.equal(summary?.latestEngineSourceSha, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });

  it("a prediction row that predates this fix (NULL engine_source_sha, exactly what the migration leaves existing rows as) remains fully readable", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    // Insert with the pre-fix column list, exactly simulating a row written before this migration ran -
    // engine_source_sha is never mentioned, so SQLite defaults it to NULL.
    db.prepare(
      `INSERT INTO shadow_predictions (
         logical_delta_key, repository, base_sha, head_sha, diffci_analysis_version, graph_version,
         shadow_schema_version, observation_source, plan_mode, fallback, effective_graph_confidence,
         opportunity_category, tests_selected_diffci, tests_selected_path, tests_total_full,
         diffci_analysis_overhead_ms, r2_evidence_key, prediction_created_at, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "pre-fix-row", "acme/web", "base", "head", "stage2-shadow-poll-1", "stage2-shadow-poll-1",
      "stage2-shadow-poll-1", "cloudflare-poll", "FULL", 1, "PARTIAL",
      "MANDATORY_FALLBACK", 0, 3, 10, 50, "r2/pre-fix-row", "2026-08-20T00:00:00.000Z", "2026-08-20T00:00:00.000Z",
    );

    const summary = await store.getRepositorySummary("acme/web");
    assert.equal(summary?.predictionsRecorded, 1, "the pre-fix row must still count normally");
    assert.equal(summary?.latestEngineSourceSha, undefined, "no engine SHA is known for it - reported as absent, not fabricated");

    const pending = await store.findPendingPredictions("acme/web", 10);
    assert.equal(pending.length, 1, "findPendingPredictions must not choke on a NULL engine_source_sha column it doesn't even select");
  });

  it("ON CONFLICT DO NOTHING idempotency still holds with the new column present", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    const first = await store.recordPrediction(prediction({ logicalDeltaKey: "dup", engineSourceSha: ENGINE_SHA }), "r2/dup");
    const second = await store.recordPrediction(prediction({ logicalDeltaKey: "dup", engineSourceSha: "dddd000000000000000000000000000000000000" }), "r2/dup");
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false, "a retried prediction for the same logical key must never overwrite the original");

    const row = db.prepare(`SELECT engine_source_sha FROM shadow_predictions WHERE logical_delta_key = ?`).get("dup") as { engine_source_sha: string };
    assert.equal(row.engine_source_sha, ENGINE_SHA, "the original SHA must survive, not the conflicting retry's");
  });
});

describe("shadow-store: source_integrity_status on shadow_cron_runs", () => {
  it("recordCronRun persists a supplied sourceIntegrityStatus", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.recordCronRun({
      startedAt: "2026-08-21T12:00:00.000Z", finishedAt: "2026-08-21T12:00:05.000Z", trigger: "cron",
      reposConsidered: 1, headChecksSkipped: 0, reposPolled: ["acme/web"], predictionsRecorded: 1,
      reposReconciled: 1, groundTruthReconciled: 0, stillPending: 1, errors: [],
      sourceIntegrityStatus: "CURRENT",
    });
    const runs = (await store.listRecentCronRuns(10)) as Array<{ source_integrity_status: string | null }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.source_integrity_status, "CURRENT");
  });

  it("stores NULL when a run never reached a poll attempt (sourceIntegrityStatus omitted)", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.recordCronRun({
      startedAt: "2026-08-21T12:00:00.000Z", finishedAt: "2026-08-21T12:00:01.000Z", trigger: "cron",
      reposConsidered: 1, headChecksSkipped: 1, reposPolled: [], predictionsRecorded: 0,
      reposReconciled: 0, groundTruthReconciled: 0, stillPending: 0, errors: [],
    });
    const runs = (await store.listRecentCronRuns(10)) as Array<{ source_integrity_status: string | null }>;
    assert.equal(runs[0]!.source_integrity_status, null);
  });

  it("an old cron_runs row written before this migration (no source_integrity_status) is still readable", async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO shadow_cron_runs (
         started_at, finished_at, trigger_source, repos_considered, head_checks_skipped, repos_polled,
         predictions_recorded, repos_reconciled, ground_truth_reconciled, still_pending, errors
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("2026-08-20T00:00:00.000Z", "2026-08-20T00:00:01.000Z", "cron", 1, 0, "[]", 0, 0, 0, 0, "[]");
    const store = makeD1ShadowStore(makeD1(db));
    const runs = (await store.listRecentCronRuns(10)) as Array<{ source_integrity_status: string | null }>;
    assert.equal(runs.length, 1);
    assert.equal(runs[0]!.source_integrity_status, null);
  });
});
