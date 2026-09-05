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
    "schema-migration-2026-08-25-shadow-economics.sql",
    "schema-migration-2026-08-26-shadow-liveness.sql",
    "schema-migration-2026-09-04-shadow-push-polls.sql",
    "schema-migration-2026-09-05-shadow-reconcile-terminal.sql",
    "schema-migration-2026-09-05-shadow-evidence-workflow.sql",
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
    // 2026-09-05 workflow identity: rows written with an evidence workflow are VERIFIED, and only
    // VERIFIED rows count in getRepositorySummary's recall figures. These tests are about counting
    // semantics on evidence that counts, so the fixture is verified by default; the identity-specific
    // cases live in shadow-store-evidence-workflow.test.ts.
    evidenceWorkflowPath: ".github/workflows/ci.yml",
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

/** Inserts directly into shadow_economics_observations - no ShadowStore write method exists for it
 * (that table is written by shadow-economics-store.ts in production), so these tests build the row
 * shape by hand, matching schema-migration-2026-08-25-shadow-economics.sql exactly. */
function insertEconomicsRow(db: DatabaseSync, overrides: { logicalDeltaKey: string; repository: string; observedAt?: string }): void {
  db.prepare(
    `INSERT INTO shadow_economics_observations (
       logical_delta_key, stage, repository, head_sha, workflow_run_ids, job_ids, full_workload_ms,
       tests_total_full, selected_workload_ms, selected_workload_confidence, avoidable_ms,
       avoidable_tier, estimation_method, schema_version, observed_at
     ) VALUES (?, 'test', ?, 'head', '[]', '[]', 1000, 10, NULL, NULL, NULL, 'UNKNOWN', NULL, 1, ?)`,
  ).run(overrides.logicalDeltaKey, overrides.repository, overrides.observedAt ?? "2026-08-21T12:00:00.000Z");
}

describe("shadow-store: erasure (site/data-handling.html's two deletion commitments)", () => {
  it("listRepositoriesByInstallation returns only repositories attributed to that installation id", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "github-app-webhook");
    await store.ensureRepository("acme/api", "github-app-webhook");
    await store.ensureRepository("other/repo", "github-app-webhook");
    await store.setInstallationId("acme/web", "111");
    await store.setInstallationId("acme/api", "111");
    await store.setInstallationId("other/repo", "222");

    const repos = await store.listRepositoriesByInstallation("111");
    assert.deepEqual(repos.sort(), ["acme/api", "acme/web"]);
  });

  it("collectEvidenceKeys gathers r2_evidence_key from both predictions and ground truth for one repository", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "k1" }), "r2/prediction/k1");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "k1" }), "r2/ground-truth/ge1");

    const keys = await store.collectEvidenceKeys("acme/web");
    assert.deepEqual(keys.sort(), ["r2/ground-truth/ge1", "r2/prediction/k1"]);
  });

  it("eraseAnalysisRecordsForRepository deletes predictions, ground truth, and economics rows for ONE repository only, leaving another repository's rows and the shadow_repositories row itself untouched", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.ensureRepository("other/repo", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "k1", repository: "acme/web" }), "r2/k1");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "k1", repository: "acme/web" }), "r2/ge1");
    insertEconomicsRow(db, { logicalDeltaKey: "k1", repository: "acme/web" });
    await store.recordPrediction(prediction({ logicalDeltaKey: "k2", repository: "other/repo" }), "r2/k2");
    insertEconomicsRow(db, { logicalDeltaKey: "k2", repository: "other/repo" });

    const counts = await store.eraseAnalysisRecordsForRepository("acme/web");
    assert.equal(counts.predictionsDeleted, 1);
    assert.equal(counts.groundTruthDeleted, 1);
    assert.equal(counts.economicsDeleted, 1);

    const countOf = (table: string, repository: string): number => (db.prepare(`SELECT COUNT(*) as n FROM ${table} WHERE repository = ?`).get(repository) as { n: number }).n;
    assert.equal(countOf("shadow_predictions", "acme/web"), 0);
    assert.equal(countOf("shadow_ground_truth", "acme/web"), 0);
    assert.equal(countOf("shadow_economics_observations", "acme/web"), 0);
    // The other repository's analysis records must survive untouched.
    assert.equal(countOf("shadow_predictions", "other/repo"), 1);
    assert.equal(countOf("shadow_economics_observations", "other/repo"), 1);
    // The repository's own enrollment row is untouched here - markRepositoryRemoved is a separate call.
    const repoRow = db.prepare(`SELECT state FROM shadow_repositories WHERE repository = 'acme/web'`).get() as { state: string };
    assert.equal(repoRow.state, "VALIDATING");
  });

  it("markRepositoryRemoved sets state=REMOVED, records removed_at, and clears installation_id", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "github-app-webhook");
    await store.setInstallationId("acme/web", "12345");

    await store.markRepositoryRemoved("acme/web", "2026-09-04T00:00:00.000Z");

    const row = db.prepare(`SELECT state, removed_at, installation_id FROM shadow_repositories WHERE repository = 'acme/web'`).get() as {
      state: string;
      removed_at: string | null;
      installation_id: string | null;
    };
    assert.equal(row.state, "REMOVED");
    assert.equal(row.removed_at, "2026-09-04T00:00:00.000Z");
    assert.equal(row.installation_id, null, "a stale installation id must never survive removal");
  });

  it("listExpiredEvidenceKeys / eraseExpiredAnalysisRecords use the PREDICTION's created_at as the cutoff, never the ground-truth or economics row's own timestamp", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");

    // Old prediction (91 days before "now"), but its ground truth was only just recorded - the ground
    // truth's own freshness must NOT save the pair from the 90-day cap; the prediction's age governs.
    await store.recordPrediction(prediction({ logicalDeltaKey: "old", predictionCreatedAt: "2026-06-05T00:00:00.000Z" }), "r2/old-prediction");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge-old", logicalDeltaKey: "old", groundTruthFetchedAt: "2026-09-03T00:00:00.000Z" }), "r2/old-ground-truth");
    insertEconomicsRow(db, { logicalDeltaKey: "old", repository: "acme/web", observedAt: "2026-09-03T00:00:00.000Z" });

    // Recent prediction (5 days before "now") - must survive.
    await store.recordPrediction(prediction({ logicalDeltaKey: "fresh", predictionCreatedAt: "2026-08-30T00:00:00.000Z" }), "r2/fresh-prediction");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge-fresh", logicalDeltaKey: "fresh" }), "r2/fresh-ground-truth");
    insertEconomicsRow(db, { logicalDeltaKey: "fresh", repository: "acme/web" });

    const nowIso = "2026-09-04T00:00:00.000Z";
    const cutoffIso = new Date(Date.parse(nowIso) - 90 * 86_400_000).toISOString();

    const expiredKeys = await store.listExpiredEvidenceKeys(cutoffIso);
    assert.deepEqual(expiredKeys.sort(), ["r2/old-ground-truth", "r2/old-prediction"]);

    const counts = await store.eraseExpiredAnalysisRecords(cutoffIso);
    assert.equal(counts.predictionsDeleted, 1);
    assert.equal(counts.groundTruthDeleted, 1);
    assert.equal(counts.economicsDeleted, 1);

    const remaining = db.prepare(`SELECT logical_delta_key FROM shadow_predictions`).all() as Array<{ logical_delta_key: string }>;
    assert.deepEqual(remaining.map((r) => r.logical_delta_key), ["fresh"]);
    const remainingEconomics = db.prepare(`SELECT logical_delta_key FROM shadow_economics_observations`).all() as Array<{ logical_delta_key: string }>;
    assert.deepEqual(remainingEconomics.map((r) => r.logical_delta_key), ["fresh"]);
  });
});

describe("shadow-store: push-triggered polls (schema-migration-2026-09-04-shadow-push-polls)", () => {
  it("listPollableRepositories includes webhook-enrolled repositories so the cron sweep is their safety net", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/webhook", "github-app-webhook");
    await store.ensureRepository("acme/polled", "cloudflare-poll");
    await store.ensureRepository("acme/step", "github-actions-step");
    await store.ensureRepository("acme/paused", "github-app-webhook");
    await store.pauseRepository("acme/paused", "test");

    const pollable = (await store.listPollableRepositories()).map((r) => r.repository).sort();
    assert.deepEqual(pollable, ["acme/polled", "acme/webhook"]);
  });

  it("beginPushPoll leaves an in-flight row that finishPushPoll closes; hasInFlightPushPoll honours the window", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    const id = await store.beginPushPoll({ kind: "poll", repository: "acme/web", headSha: "a".repeat(40), enqueuedAt: "2026-09-04T10:00:00.000Z", startedAt: "2026-09-04T10:00:01.000Z" });
    assert.equal(typeof id, "number");

    assert.equal(await store.hasInFlightPushPoll("acme/web", "2026-09-04T09:45:00.000Z"), true);
    assert.equal(await store.hasInFlightPushPoll("acme/web", "2026-09-04T10:30:00.000Z"), false, "started before the window - presumed dead");
    assert.equal(await store.hasInFlightPushPoll("acme/other", "2026-09-04T09:45:00.000Z"), false);

    await store.finishPushPoll(id, {
      kind: "poll", repository: "acme/web", headSha: "a".repeat(40), enqueuedAt: "2026-09-04T10:00:00.000Z", startedAt: "2026-09-04T10:00:01.000Z",
      finishedAt: "2026-09-04T10:03:00.000Z", outcome: "succeeded", predictionsRecorded: 2, slotNo: 4, autoPaused: false, error: "poll acme/web: one commit skipped",
    });
    assert.equal(await store.hasInFlightPushPoll("acme/web", "2026-09-04T09:45:00.000Z"), false);

    const rows = (await store.listRecentPushPolls(10)) as Array<Record<string, unknown>>;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.outcome, "succeeded");
    assert.equal(rows[0]!.predictions_recorded, 2);
    assert.equal(rows[0]!.slot_no, 4);
    assert.equal(rows[0]!.finished_at, "2026-09-04T10:03:00.000Z");
    assert.match(String(rows[0]!.error), /one commit skipped/);
  });

  it("a bridge row never counts as an in-flight analysis poll", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.beginPushPoll({ kind: "ci-reproduction-bridge", repository: "acme/web", enqueuedAt: "2026-09-04T10:00:00.000Z", startedAt: "2026-09-04T10:00:01.000Z" });
    assert.equal(await store.hasInFlightPushPoll("acme/web", "2026-09-04T09:45:00.000Z"), false);
  });
});

describe("shadow-store: reconcile terminal state (2026-09-05, research note F1)", () => {
  it("findPendingPredictions orders never-attempted rows first, then least recently attempted - a permanently pending row can no longer monopolise the window", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    // The incident shape: ten old rows that have been attempted every sweep, one fresh row behind them.
    for (let i = 0; i < 10; i++) {
      await store.recordPrediction(prediction({ logicalDeltaKey: `stuck-${i}`, headSha: `stuck-${i}`, predictionCreatedAt: `2026-08-22T0${i}:00:00.000Z` }), `r2/stuck-${i}`);
      await store.recordReconcileAttempt(`stuck-${i}`, "no_matching_workflow", `2026-09-05T03:0${i}:00.000Z`);
    }
    await store.recordPrediction(prediction({ logicalDeltaKey: "fresh", headSha: "fresh", predictionCreatedAt: "2026-09-05T02:00:00.000Z" }), "r2/fresh");

    const window = await store.findPendingPredictions("acme/web", 10);
    assert.equal(window[0]!.logicalDeltaKey, "fresh", "the never-attempted row must be inside the window, ahead of every already-attempted row");
    assert.equal(window[1]!.logicalDeltaKey, "stuck-0", "then the least recently attempted");
    assert.equal(window.length, 10);
    assert.equal(window[0]!.lastReconcileAttemptedAt, undefined);
    assert.equal(window[1]!.lastReconcileReason, "no_matching_workflow", "the prior observation rides along for the terminal decision");
  });

  it("terminalizePrediction records reason/time/detail and removes the row from the pending window without touching the prediction", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p2", headSha: "head2" }), "r2/p2");

    const first = await store.terminalizePrediction("p1", "NO_MATCHING_WORKFLOW", "2026-09-05T04:00:00.000Z", { workflowRunsForHeadSha: 0 });
    assert.equal(first.changed, true);
    const again = await store.terminalizePrediction("p1", "NO_MATCHING_WORKFLOW", "2026-09-05T05:00:00.000Z", { workflowRunsForHeadSha: 0 });
    assert.equal(again.changed, false, "already terminal - never overwritten");

    const row = db.prepare(`SELECT reconcile_terminal_reason, reconcile_terminal_at, reconcile_terminal_detail, plan_mode, r2_evidence_key FROM shadow_predictions WHERE logical_delta_key = ?`).get("p1") as Record<string, string>;
    assert.equal(row.reconcile_terminal_reason, "NO_MATCHING_WORKFLOW");
    assert.equal(row.reconcile_terminal_at, "2026-09-05T04:00:00.000Z");
    assert.deepEqual(JSON.parse(row.reconcile_terminal_detail!), { workflowRunsForHeadSha: 0 });
    assert.equal(row.plan_mode, "SELECTIVE", "the prediction itself is untouched");
    assert.equal(row.r2_evidence_key, "r2/p1");

    const pending = await store.findPendingPredictions("acme/web", 10);
    assert.deepEqual(pending.map((p) => p.logicalDeltaKey), ["p2"]);
  });

  it("terminalizePrediction refuses to mark a prediction that already has ground truth", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "p1" }), "r2/p1");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge1", logicalDeltaKey: "p1" }), "r2/ge1");

    const result = await store.terminalizePrediction("p1", "NO_MATCHING_WORKFLOW", "2026-09-05T04:00:00.000Z", {});
    assert.equal(result.changed, false);
    const row = db.prepare(`SELECT reconcile_terminal_reason FROM shadow_predictions WHERE logical_delta_key = ?`).get("p1") as { reconcile_terminal_reason: string | null };
    assert.equal(row.reconcile_terminal_reason, null, "real evidence can never be shadowed by a terminal marker");
  });

  it("getReconcileDiagnostics counts terminal rows under terminalUnevaluable, never under pending/stuck, and keeps prediction made vs ground truth unavailable distinct", async () => {
    const db = freshDb();
    const store = makeD1ShadowStore(makeD1(db));
    await store.ensureRepository("acme/web", "cloudflare-poll");
    await store.recordPrediction(prediction({ logicalDeltaKey: "reconciled" }), "r2/reconciled");
    await store.recordGroundTruth(groundTruth({ logicalEventKey: "ge", logicalDeltaKey: "reconciled" }), "r2/ge");
    await store.recordPrediction(prediction({ logicalDeltaKey: "terminal", headSha: "t", predictionCreatedAt: "2026-08-22T00:00:00.000Z" }), "r2/terminal");
    await store.recordReconcileAttempt("terminal", "no_matching_workflow", "2026-09-05T03:00:00.000Z");
    await store.terminalizePrediction("terminal", "NO_MATCHING_WORKFLOW", "2026-09-05T04:00:00.000Z", {});
    await store.recordPrediction(prediction({ logicalDeltaKey: "pending", headSha: "p", predictionCreatedAt: "2026-09-05T03:30:00.000Z" }), "r2/pending");

    const d = await store.getReconcileDiagnostics({ nowIso: "2026-09-05T04:00:00.000Z", stuckThresholdMs: 4 * 60 * 60 * 1000, stuckLimit: 20 });
    assert.equal(d.total, 3, "the terminal prediction is still a prediction that was made");
    assert.equal(d.reconciled, 1);
    assert.equal(d.pending, 1);
    assert.equal(d.terminalUnevaluable, 1);
    assert.deepEqual(d.terminalReasons, [{ reason: "NO_MATCHING_WORKFLOW", count: 1 }]);
    assert.deepEqual(d.pendingReasons, [{ reason: "not_yet_attempted", count: 1 }], "the terminal row's old no_matching_workflow label must not linger in the pending breakdown");
    assert.equal(d.stuck.length, 0, "a terminal row is not stuck - it is resolved, explicitly");
    assert.equal(d.oldestPendingAgeMs, 30 * 60 * 1000);
  });
});
