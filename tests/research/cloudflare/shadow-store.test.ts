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
import { makeD1ShadowStore, type D1Binding, type RecordGroundTruthInput, type RecordPredictionInput } from "../../../src/research/cloudflare/shadow-store.js";

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
    "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql",
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

// --- Task 2 (2026-08-21) additions: reconciliation observability + idempotency + discriminative-scoped safety ---

function groundTruth(overrides: Partial<RecordGroundTruthInput> & { logicalEventKey: string; logicalDeltaKey: string }): RecordGroundTruthInput {
  return {
    repository: "acme/web",
    headSha: "head",
    workflowRunAttempt: 1,
    eventType: "poll-detected",
    groundTruthStatus: "COMPLETE",
    relevantFailuresObserved: 0,
    relevantFailuresEvaluable: 0,
    failuresPreservedByDiffci: 0,
    failuresPreservedByPath: 0,
    predictionPrecededGroundTruth: true,
    groundTruthFetchedAt: "2026-08-21T12:00:00.000Z",
    ...overrides,
  };
}

describe("shadow-store: recordReconcileAttempt + getReconcileDiagnostics", () => {
  it("recordReconcileAttempt persists the reason and timestamp of the most recent STILL_PENDING attempt", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");
    await store.recordReconcileAttempt("p1", "ci_queued", "2026-08-21T12:30:00.000Z");

    const row = db.prepare(`SELECT last_reconcile_reason, last_reconcile_attempted_at FROM shadow_predictions WHERE logical_delta_key = ?`).get("p1") as {
      last_reconcile_reason: string; last_reconcile_attempted_at: string;
    };
    assert.equal(row.last_reconcile_reason, "ci_queued");
    assert.equal(row.last_reconcile_attempted_at, "2026-08-21T12:30:00.000Z");
  });

  it("a later attempt's reason overwrites an earlier one - only the most recent classification is kept", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");
    await store.recordReconcileAttempt("p1", "no_matching_workflow", "2026-08-21T12:00:00.000Z");
    await store.recordReconcileAttempt("p1", "ci_in_progress", "2026-08-21T12:10:00.000Z");

    const row = db.prepare(`SELECT last_reconcile_reason FROM shadow_predictions WHERE logical_delta_key = ?`).get("p1") as { last_reconcile_reason: string };
    assert.equal(row.last_reconcile_reason, "ci_in_progress");
  });

  it("getReconcileDiagnostics reports total/reconciled/pending and groups pending predictions by reason", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "reconciled-1" }), "r2/reconciled-1");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "reconciled-1" }), "r2/ge1");
    await store.recordPrediction(prediction({ logicalDeltaKey: "pending-queued" }), "r2/pending-queued");
    await store.recordReconcileAttempt("pending-queued", "ci_queued", "2026-08-21T12:00:00.000Z");
    await store.recordPrediction(prediction({ logicalDeltaKey: "pending-fresh" }), "r2/pending-fresh"); // never attempted

    const diagnostics = await store.getReconcileDiagnostics({ nowIso: "2026-08-21T12:00:00.000Z", stuckThresholdMs: 4 * 60 * 60 * 1000, stuckLimit: 20 });
    assert.equal(diagnostics.total, 3);
    assert.equal(diagnostics.reconciled, 1);
    assert.equal(diagnostics.pending, 2);
    assert.equal(diagnostics.terminalUnevaluable, 0);
    const byReason = Object.fromEntries(diagnostics.pendingReasons.map((r) => [r.reason, r.count]));
    assert.equal(byReason.ci_queued, 1);
    assert.equal(byReason.not_yet_attempted, 1, "a prediction with no reconcile attempt yet must be its own honest bucket, not lumped into a GitHub-derived reason");
  });

  it("computes oldest pending age from prediction_created_at, and flags predictions past the stuck threshold", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "old", predictionCreatedAt: "2026-08-21T02:00:00.000Z" }), "r2/old");
    await store.recordPrediction(prediction({ logicalDeltaKey: "recent", predictionCreatedAt: "2026-08-21T11:30:00.000Z" }), "r2/recent");

    const now = "2026-08-21T12:00:00.000Z"; // old = 10h ago, recent = 30m ago
    const diagnostics = await store.getReconcileDiagnostics({ nowIso: now, stuckThresholdMs: 4 * 60 * 60 * 1000, stuckLimit: 20 });

    assert.equal(diagnostics.oldestPendingAgeMs, 10 * 60 * 60 * 1000);
    assert.equal(diagnostics.stuck.length, 1, "only the 10h-old prediction exceeds the 4h stuck threshold");
    assert.equal(diagnostics.stuck[0]!.logicalDeltaKey, "old");
    assert.equal(diagnostics.stuck[0]!.ageMs, 10 * 60 * 60 * 1000);
  });

  it("never labels a prediction stuck merely for being old if it has already been reconciled", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "very-old", predictionCreatedAt: "2026-08-01T00:00:00.000Z" }), "r2/very-old");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge-old", logicalDeltaKey: "very-old" }), "r2/ge-old");

    const diagnostics = await store.getReconcileDiagnostics({ nowIso: "2026-08-21T12:00:00.000Z", stuckThresholdMs: 4 * 60 * 60 * 1000, stuckLimit: 20 });
    assert.equal(diagnostics.stuck.length, 0);
    assert.equal(diagnostics.pending, 0);
  });

  it("scopes correctly to one repository when `repository` is supplied", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.ensureRepository("acme/api", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "web-1", repository: "acme/web" }), "r2/web-1");
    await store.recordPrediction(prediction({ logicalDeltaKey: "api-1", repository: "acme/api" }), "r2/api-1");

    const webOnly = await store.getReconcileDiagnostics({ repository: "acme/web", nowIso: "2026-08-21T12:00:00.000Z", stuckThresholdMs: 1000, stuckLimit: 20 });
    assert.equal(webOnly.total, 1);
    const all = await store.getReconcileDiagnostics({ nowIso: "2026-08-21T12:00:00.000Z", stuckThresholdMs: 1000, stuckLimit: 20 });
    assert.equal(all.total, 2);
  });
});

describe("shadow-store: ground-truth idempotency (duplicate webhook / cron-vs-webhook race)", () => {
  it("recordGroundTruth is idempotent on logicalEventKey - a duplicate insert (simulating a retried webhook delivery) does not create a second row or double-count metrics", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1", opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY" }), "r2/p1");

    const first = await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "p1", relevantFailuresObserved: 3, relevantFailuresEvaluable: 3, failuresPreservedByDiffci: 2 }), "r2/ge1");
    const second = await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "p1", relevantFailuresObserved: 999, relevantFailuresEvaluable: 999, failuresPreservedByDiffci: 999 }), "r2/ge1-retry");
    assert.equal(first.inserted, true);
    assert.equal(second.inserted, false, "the SAME logicalEventKey must never insert a second row - GitHub webhooks are not exactly-once");

    const summary = await store.getRepositorySummary("acme/web");
    assert.equal(summary?.groundTruthRecorded, 1, "exactly one ground-truth row, not two");
    assert.equal(summary?.relevantFailuresObserved, 3, "the retry's (bogus) numbers must never be double-counted or overwrite the original");
  });

  it("concurrent inserts racing on the same logicalEventKey (cron and webhook reconciling the same real outcome) still converge to exactly one row", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");

    const results = await Promise.all([
      store.recordGroundTruth(groundTruth({ logicalEventKey: "ge-race", logicalDeltaKey: "p1" }), "r2/ge-race-a"),
      store.recordGroundTruth(groundTruth({ logicalEventKey: "ge-race", logicalDeltaKey: "p1" }), "r2/ge-race-b"),
    ]);
    assert.equal(results.filter((r) => r.inserted).length, 1, "exactly one of the two racing writes must win");

    const summary = await store.getRepositorySummary("acme/web");
    assert.equal(summary?.groundTruthRecorded, 1);
  });

  it("a genuinely different workflow attempt for the SAME commit (a real retry, different logicalEventKey) is intentionally NOT deduped - both attempts' outcomes stay visible", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");

    await store.recordGroundTruth(groundTruth({ logicalEventKey: "acme/web:head:100:1", logicalDeltaKey: "p1", workflowRunId: "100", workflowConclusion: "failure" }), "r2/attempt1");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "acme/web:head:100:2", logicalDeltaKey: "p1", workflowRunId: "100", workflowConclusion: "success" }), "r2/attempt2");

    const summary = await store.getRepositorySummary("acme/web");
    assert.equal(summary?.groundTruthRecorded, 2, "a flaky retry's different real outcome must remain visible, not collapsed into one row");
  });
});

describe("shadow-store: discriminative-scoped safety metrics (§8 fix - never let FULL/fallback runs inflate apparent selective safety)", () => {
  it("getRepositorySummary's discriminative* fields only reflect DISCRIMINATIVE_OPPORTUNITY predictions, not MANDATORY_FALLBACK ones", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");

    // A MANDATORY_FALLBACK prediction ran the FULL suite - it trivially "preserves" every real failure,
    // which must NOT be counted as evidence DiffCI's selective plan is safe.
    await store.recordPrediction(prediction({ logicalDeltaKey: "fallback-1", opportunityCategory: "MANDATORY_FALLBACK", planMode: "FULL" }), "r2/fallback-1");
    await store.recordGroundTruth(
      groundTruth({ logicalEventKey: "ge-fallback", logicalDeltaKey: "fallback-1", relevantFailuresObserved: 5, relevantFailuresEvaluable: 5, failuresPreservedByDiffci: 5, failuresPreservedByPath: 5 }),
      "r2/ge-fallback",
    );

    // A real DISCRIMINATIVE_OPPORTUNITY prediction where DiffCI's selective plan actually missed one.
    await store.recordPrediction(prediction({ logicalDeltaKey: "discriminative-1", opportunityCategory: "DISCRIMINATIVE_OPPORTUNITY" }), "r2/discriminative-1");
    await store.recordGroundTruth(
      groundTruth({ logicalEventKey: "ge-discriminative", logicalDeltaKey: "discriminative-1", relevantFailuresObserved: 1, relevantFailuresEvaluable: 1, failuresPreservedByDiffci: 0, failuresPreservedByPath: 1 }),
      "r2/ge-discriminative",
    );

    const summary = await store.getRepositorySummary("acme/web");
    // Unfiltered (existing) fields blend both - documented as such, not what a safety claim should use.
    assert.equal(summary?.relevantFailuresObserved, 6);
    assert.equal(summary?.failuresPreservedByDiffci, 5);
    // Discriminative-scoped fields must reflect ONLY the real test of selective safety.
    assert.equal(summary?.discriminativeRelevantFailuresObserved, 1);
    assert.equal(summary?.discriminativeRelevantFailuresEvaluable, 1);
    assert.equal(summary?.discriminativeFailuresPreservedByDiffci, 0, "DiffCI's selective plan genuinely missed this - the fallback case's trivial 5/5 must not hide it");
    assert.equal(summary?.discriminativeFailuresPreservedByPath, 1);
  });

  it("a BASELINE_ALREADY_OPTIMAL prediction is also excluded from the discriminative-scoped fields", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "optimal-1", opportunityCategory: "BASELINE_ALREADY_OPTIMAL" }), "r2/optimal-1");
    await store.recordGroundTruth(
      groundTruth({ logicalEventKey: "ge-optimal", logicalDeltaKey: "optimal-1", relevantFailuresObserved: 2, relevantFailuresEvaluable: 2, failuresPreservedByDiffci: 2, failuresPreservedByPath: 2 }),
      "r2/ge-optimal",
    );
    const summary = await store.getRepositorySummary("acme/web");
    assert.equal(summary?.discriminativeRelevantFailuresObserved, 0);
  });
});
