/**
 * buildLiveShadowReport against REAL SQLite with the REAL migration files (2026-09-05). The fake-D1
 * test cannot catch a malformed SQL literal - the live route shipped one ('[' lost its quotes and D1
 * answered "no such column") and only the deployed Worker noticed. This runs every query for real.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { buildLiveShadowReport, type D1Binding } from "../../../src/research/cloudflare/shadow-report-query.js";
import { renderShadowReport } from "../../../src/usage/shadow-report-render.js";

const SCHEMA_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../src/research/cloudflare");
const MIGRATIONS = [
  "schema-migration-2026-08-21-stage2-shadow.sql",
  "schema-migration-2026-08-21-shadow-cron.sql",
  "schema-migration-2026-08-21-shadow-webhook.sql",
  "schema-migration-2026-08-21-shadow-source-integrity.sql",
  "schema-migration-2026-08-21-shadow-reconcile-diagnostics.sql",
  "schema-migration-2026-08-25-shadow-economics.sql",
  "schema-migration-2026-08-26-shadow-economics-estimator-v2.sql",
  "schema-migration-2026-08-26-shadow-liveness.sql",
  "schema-migration-2026-09-03-shadow-economics-path-comparator.sql",
  "schema-migration-2026-09-04-shadow-push-polls.sql",
  "schema-migration-2026-09-05-shadow-reconcile-terminal.sql",
  "schema-migration-2026-09-05-shadow-evidence-workflow.sql",
  "schema-migration-2026-09-05-shadow-stage-economics.sql",
];

function freshDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  for (const f of MIGRATIONS) db.exec(readFileSync(join(SCHEMA_DIR, f), "utf8"));
  return db;
}

function makeD1(db: DatabaseSync): D1Binding {
  return {
    prepare(query: string) {
      return {
        bind(...values: unknown[]) {
          return {
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

const NOW = new Date();
const recent = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString();

function seed(db: DatabaseSync, repository: string, opts: { evidencePaths?: string[]; withEvidence: boolean }) {
  db.prepare(`INSERT INTO shadow_repositories (repository, state, observation_source, enrolled_at, evidence_workflow_paths) VALUES (?, 'SHADOW_ACTIVE', 'github-app-webhook', ?, ?)`)
    .run(repository, recent, opts.evidencePaths ? JSON.stringify(opts.evidencePaths) : null);
  db.prepare(
    `INSERT INTO shadow_predictions (logical_delta_key, repository, base_sha, head_sha, diffci_analysis_version, graph_version, shadow_schema_version, observation_source, plan_mode, fallback, effective_graph_confidence, opportunity_category, tests_selected_diffci, tests_selected_path, tests_total_full, diffci_analysis_overhead_ms, r2_evidence_key, prediction_created_at, created_at)
     VALUES ('k1', ?, 'b', 'h1', 'v', 'v', 's', 'github-app-webhook', 'SELECTIVE', 0, 'COMPLETE', 'DISCRIMINATIVE_OPPORTUNITY', 2, 50, 100, 500, 'r2/k1', ?, ?)`,
  ).run(repository, recent, recent);
  if (!opts.withEvidence) return;
  db.prepare(
    `INSERT INTO shadow_ground_truth (logical_event_key, logical_delta_key, repository, head_sha, workflow_run_id, workflow_run_attempt, event_type, ground_truth_status, relevant_failures_observed, relevant_failures_evaluable, failures_preserved_by_diffci, failures_preserved_by_path, prediction_preceded_ground_truth, r2_evidence_key, ground_truth_fetched_at, created_at, evidence_workflow_path, evidence_validity)
     VALUES ('e1', 'k1', ?, 'h1', '900', 1, 'poll-detected', 'COMPLETE', 1, 1, 1, 1, 1, 'r2/e1', ?, ?, '.github/workflows/ci.yml', 'VERIFIED')`,
  ).run(repository, recent, recent);
  db.prepare(
    `INSERT INTO shadow_ground_truth (logical_event_key, logical_delta_key, repository, head_sha, workflow_run_id, workflow_run_attempt, event_type, ground_truth_status, relevant_failures_observed, relevant_failures_evaluable, failures_preserved_by_diffci, failures_preserved_by_path, prediction_preceded_ground_truth, r2_evidence_key, ground_truth_fetched_at, created_at, evidence_workflow_path, evidence_validity)
     VALUES ('e-bad', 'k1', ?, 'h1', '901', 1, 'poll-detected', 'COMPLETE', 7, 7, 0, 0, 1, 'r2/e-bad', ?, ?, '.github/workflows/codeql.yml', 'CONTAMINATED_WORKFLOW_IDENTITY')`,
  ).run(repository, recent, recent);
  db.prepare(
    `INSERT INTO shadow_stage_economics (logical_delta_key, stage, classification_basis, classifier_version, repository, head_sha, evidence_run_id, evidence_workflow_path, evidence_validity, job_ids, step_refs, full_workload_ms, tests_total_full, tests_selected_diffci, tests_selected_path, plan_mode, diffci_analysis_overhead_ms, selected_workload_ms, selected_workload_confidence, avoidable_ms, avoidable_tier, estimation_method, estimator_version, observed_at)
     VALUES ('k1', 'test', 'explicit_step', 1, ?, 'h1', '900', '.github/workflows/ci.yml', 'VERIFIED', '[1]', '["check :: Test"]', 120000, 100, 2, 50, 'SELECTIVE', 500, 2400, 'count_based_estimate', 117600, 'ESTIMATED', 'linear_within_commit_ratio_v2:2/100', 2, ?)`,
  ).run(repository, recent);
  // A legacy economics row for the same prediction - must never reach the report.
  db.prepare(
    `INSERT INTO shadow_economics_observations (logical_delta_key, stage, repository, head_sha, workflow_run_ids, job_ids, full_workload_ms, avoidable_tier, schema_version, observed_at, evidence_validity)
     VALUES ('k1', 'other', ?, 'h1', '[900,901]', '[1,2]', 999999, 'UNKNOWN', 1, ?, 'LEGACY_UNVERIFIED')`,
  ).run(repository, recent);
}

describe("buildLiveShadowReport on real SQLite", () => {
  it("an identified repository: stage economics from the new table, safety over VERIFIED rows, legacy rows invisible", async () => {
    const db = freshDb();
    seed(db, "acme/web", { evidencePaths: [".github/workflows/ci.yml"], withEvidence: true });
    const r = await buildLiveShadowReport(makeD1(db), "acme/web", 7);
    assert.deepEqual(r.evidenceWorkflow, { state: "IDENTIFIED", paths: [".github/workflows/ci.yml"] });
    assert.equal(r.hasSufficientData, true);
    assert.equal(r.totalObservedMs, 120_000, "the 999999 ms legacy row must not appear");
    assert.deepEqual(r.stages.map((s) => s.stage), ["test"]);
    assert.equal(r.workflowRunsObserved, 1);
    assert.equal(r.safety.evaluableFailures, 1, "the contaminated row's 7 failures never count");
    assert.equal(r.safety.falseNegatives, 0);
    const text = renderShadowReport(r);
    assert.ok(text.includes("Evidence workflow: .github/workflows/ci.yml"));
    assert.ok(text.includes("[ESTIMATED]"));
  });

  it("an unconfigured repository with predictions: AWAITING_IDENTIFICATION, never zeros", async () => {
    const db = freshDb();
    seed(db, "acme/new", { withEvidence: false });
    const r = await buildLiveShadowReport(makeD1(db), "acme/new", 7);
    assert.equal(r.evidenceWorkflow.state, "AWAITING_IDENTIFICATION");
    assert.equal(r.evidence.eligiblePredictions, 1);
    const text = renderShadowReport(r);
    assert.ok(text.includes("AWAITING CI EVIDENCE WORKFLOW IDENTIFICATION"));
    assert.ok(text.includes("(1 in this window)"));
  });
});
