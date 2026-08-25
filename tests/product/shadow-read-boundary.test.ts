/**
 * Real-SQLite-backed tests for src/product/shadow-read-boundary.ts, applied against the REAL Stage 2F
 * research schema files (src/research/cloudflare/schema-migration-2026-08-21-stage2-shadow.sql etc.) -
 * proves this boundary's queries are actually compatible with Stage 2F's real, committed schema, and
 * (by construction - every method here issues only SELECT statements) that it cannot mutate it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { makeD1ShadowReadBoundary, type D1Binding } from "../../src/product/shadow-read-boundary.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../src/research/cloudflare");

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const file of ["schema-migration-2026-08-21-stage2-shadow.sql", "schema-migration-2026-08-21-shadow-cron.sql", "schema-migration-2026-08-21-shadow-webhook.sql", "schema-migration-2026-08-21-shadow-source-integrity.sql", "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql"]) {
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

function seedShadowRepository(db: DatabaseSync, repository: string) {
  db.prepare(`INSERT OR IGNORE INTO shadow_repositories (repository, state, observation_source, enrolled_at) VALUES (?, 'SHADOW_ACTIVE', 'github-app-webhook', ?)`).run(repository, "2026-08-21T00:00:00Z");
}

function seedPrediction(db: DatabaseSync, overrides: Record<string, unknown> = {}) {
  seedShadowRepository(db, (overrides.repository as string) ?? "acme/web"); // shadow_predictions.repository has a real FK to shadow_repositories(repository)
  const base = {
    logical_delta_key: "k1",
    repository: "acme/web",
    base_sha: "b1",
    head_sha: "h1",
    diffci_analysis_version: "v1",
    graph_version: "v1",
    shadow_schema_version: "s1",
    observation_source: "github-app-webhook",
    plan_mode: "SELECTIVE",
    fallback: 0,
    effective_graph_confidence: "COMPLETE",
    opportunity_category: "DISCRIMINATIVE_OPPORTUNITY",
    tests_selected_diffci: 9,
    tests_selected_path: 46,
    tests_total_full: 46,
    diffci_analysis_overhead_ms: 100,
    r2_evidence_key: "r2/key",
    prediction_created_at: "2026-08-22T00:00:00Z",
    created_at: "2026-08-22T00:00:00Z",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO shadow_predictions (logical_delta_key, repository, base_sha, head_sha, diffci_analysis_version, graph_version, shadow_schema_version, observation_source, plan_mode, fallback, effective_graph_confidence, opportunity_category, tests_selected_diffci, tests_selected_path, tests_total_full, diffci_analysis_overhead_ms, r2_evidence_key, prediction_created_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...(Object.values(base) as never[]));
}

function seedGroundTruth(db: DatabaseSync, overrides: Record<string, unknown> = {}) {
  const base = {
    logical_event_key: "e1",
    logical_delta_key: "k1",
    repository: "acme/web",
    head_sha: "h1",
    workflow_run_attempt: 1,
    event_type: "push",
    ground_truth_status: "COMPLETE",
    relevant_failures_observed: 1,
    relevant_failures_evaluable: 1,
    failures_preserved_by_diffci: 1,
    failures_preserved_by_path: 1,
    prediction_preceded_ground_truth: 1,
    r2_evidence_key: "r2/key2",
    ground_truth_fetched_at: "2026-08-22T00:05:00Z",
    created_at: "2026-08-22T00:05:00Z",
    workflow_conclusion: "failure",
    ...overrides,
  };
  db.prepare(
    `INSERT INTO shadow_ground_truth (logical_event_key, logical_delta_key, repository, head_sha, workflow_run_attempt, event_type, ground_truth_status, relevant_failures_observed, relevant_failures_evaluable, failures_preserved_by_diffci, failures_preserved_by_path, prediction_preceded_ground_truth, r2_evidence_key, ground_truth_fetched_at, created_at, workflow_conclusion)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(...(Object.values(base) as never[]));
}

describe("ShadowReadBoundary - Part 20 (read-only, real Stage 2F schema)", () => {
  it("listPredictions returns predictions scoped to the requested repository and time window", async () => {
    const db = freshDb();
    seedPrediction(db);
    seedPrediction(db, { logical_delta_key: "k2", repository: "acme/other", head_sha: "h2" });
    const boundary = makeD1ShadowReadBoundary(makeD1(db));
    const results = await boundary.listPredictions("acme/web", "2026-08-01T00:00:00Z", "2026-09-01T00:00:00Z");
    assert.equal(results.length, 1);
    assert.equal(results[0]?.repository, "acme/web");
    assert.equal(results[0]?.headSha, "h1", "head_sha is projected through - needed for real duration-capture correlation (src/usage/duration-capture-job.ts)");
  });

  it("getGroundTruthForDelta returns the matching ground truth row", async () => {
    const db = freshDb();
    seedPrediction(db);
    seedGroundTruth(db);
    const boundary = makeD1ShadowReadBoundary(makeD1(db));
    const gt = await boundary.getGroundTruthForDelta("k1");
    assert.equal(gt?.relevantFailuresEvaluable, 1);
    assert.equal(gt?.failuresPreservedByDiffci, 1);
    assert.equal(gt?.predictionPrecededGroundTruth, true);
  });

  it("getSafetySnapshot aggregates evaluable/preserved and derives false negatives, scoped by repository when given", async () => {
    const db = freshDb();
    seedPrediction(db);
    seedGroundTruth(db);
    seedPrediction(db, { logical_delta_key: "k2", repository: "acme/other", head_sha: "h2" });
    seedGroundTruth(db, { logical_event_key: "e2", logical_delta_key: "k2", repository: "acme/other", head_sha: "h2", relevant_failures_evaluable: 2, failures_preserved_by_diffci: 1 }); // a false negative on a DIFFERENT repo
    const boundary = makeD1ShadowReadBoundary(makeD1(db));

    const scoped = await boundary.getSafetySnapshot("acme/web");
    assert.equal(scoped.evaluableFailures, 1);
    assert.equal(scoped.falseNegatives, 0, "acme/web itself has no false negative");

    const global = await boundary.getSafetySnapshot();
    assert.equal(global.evaluableFailures, 3);
    assert.equal(global.falseNegatives, 1, "the acme/other false negative must be visible in the unscoped snapshot");
  });

  // 2026-08-25 (External Shadow Pilot M1) - listEnrolledRepositories
  it("listEnrolledRepositories returns only SHADOW_ACTIVE/SHADOW_LIMITED repositories, excluding every other state", async () => {
    const db = freshDb();
    seedShadowRepository(db, "acme/active");
    db.prepare(`INSERT INTO shadow_repositories (repository, state, observation_source, enrolled_at) VALUES (?, 'SHADOW_LIMITED', 'cloudflare-poll', ?)`).run("acme/limited", "2026-08-21T00:00:00Z");
    db.prepare(`INSERT INTO shadow_repositories (repository, state, observation_source, enrolled_at) VALUES (?, 'PAUSED', 'cloudflare-poll', ?)`).run("acme/paused", "2026-08-21T00:00:00Z");
    db.prepare(`INSERT INTO shadow_repositories (repository, state, observation_source, enrolled_at) VALUES (?, 'REMOVED', 'cloudflare-poll', ?)`).run("acme/removed", "2026-08-21T00:00:00Z");
    db.prepare(`INSERT INTO shadow_repositories (repository, state, observation_source, enrolled_at) VALUES (?, 'VALIDATING', 'cloudflare-poll', ?)`).run("acme/validating", "2026-08-21T00:00:00Z");
    const boundary = makeD1ShadowReadBoundary(makeD1(db));
    const repos = await boundary.listEnrolledRepositories();
    assert.deepEqual(repos.sort(), ["acme/active", "acme/limited"]);
  });

  it("listEnrolledRepositories returns an empty array, not an error, when nothing is enrolled", async () => {
    const db = freshDb();
    const boundary = makeD1ShadowReadBoundary(makeD1(db));
    assert.deepEqual(await boundary.listEnrolledRepositories(), []);
  });
});
