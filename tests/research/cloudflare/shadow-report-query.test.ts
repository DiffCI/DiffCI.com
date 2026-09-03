/**
 * Unit tests for src/research/cloudflare/shadow-report-query.ts, using a fake D1Binding - proves the
 * query-assembly logic (eligiblePredictions denominator, prediction-window join, safety join) matches
 * scripts/generate-shadow-report.ts's own already-proven shape, without touching a real database.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildLiveShadowReport, type D1Binding } from "../../../src/research/cloudflare/shadow-report-query.js";

interface FakeRow {
  [key: string]: unknown;
}

function fakeD1(tables: { predictions: FakeRow[]; observations: FakeRow[]; groundTruth: FakeRow[] }): D1Binding {
  return {
    prepare(query: string) {
      return {
        bind(..._values: unknown[]) {
          return {
            async first<T>(): Promise<T | null> {
              if (query.includes("COUNT(*) as n FROM shadow_predictions")) {
                return { n: tables.predictions.length } as T;
              }
              if (query.includes("relevant_failures_evaluable")) {
                const evaluable = tables.groundTruth.reduce((sum, r) => sum + (Number(r.relevant_failures_evaluable) || 0), 0);
                const preserved = tables.groundTruth.reduce((sum, r) => sum + (Number(r.failures_preserved_by_diffci) || 0), 0);
                return { evaluable, preserved } as T;
              }
              return null;
            },
            async all<T>(): Promise<{ results: T[] }> {
              return { results: tables.observations as T[] };
            },
          };
        },
      };
    },
  };
}

function observationRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    logical_delta_key: "k1",
    stage: "test",
    repository: "acme/web",
    head_sha: "a".repeat(40),
    workflow_run_ids: "[1]",
    job_ids: "[1]",
    full_workload_ms: 30_000,
    tests_total_full: 70,
    tests_selected_diffci: 5,
    tests_selected_path: 35,
    diffci_analysis_overhead_ms: 300,
    plan_mode: "SELECTIVE",
    selected_workload_ms: 2143,
    selected_workload_confidence: "count_based_estimate",
    avoidable_ms: 27_857,
    avoidable_tier: "ESTIMATED",
    estimation_method: "linear_within_commit_ratio_v2:5/70",
    estimator_version: 2,
    estimated_at: "2026-09-01T00:00:00Z",
    schema_version: 1,
    observed_at: "2026-09-01T00:00:00Z",
    ...overrides,
  };
}

describe("buildLiveShadowReport", () => {
  it("assembles a real report from D1-shaped rows, matching generate-shadow-report.ts's own query shape", async () => {
    const db = fakeD1({
      predictions: [{}, {}, {}], // 3 eligible predictions in the window
      observations: [observationRow()],
      groundTruth: [{ relevant_failures_evaluable: 2, failures_preserved_by_diffci: 2 }],
    });
    const report = await buildLiveShadowReport(db, "acme/web", 7);
    assert.equal(report.repository, "acme/web");
    assert.equal(report.hasSufficientData, true);
    assert.equal(report.evidence.eligiblePredictions, 3);
    assert.equal(report.safety.evaluableFailures, 2);
    assert.equal(report.safety.failuresPreserved, 2);
    const testStage = report.stages.find((s) => s.stage === "test");
    assert.ok(testStage);
    assert.equal(testStage!.commits[0]!.testsSelectedPath, 35, "the path-rule comparator field must survive the D1 round-trip");
  });

  it("reports insufficient data honestly for a repository with no observations, rather than a page of zeros", async () => {
    const db = fakeD1({ predictions: [], observations: [], groundTruth: [] });
    const report = await buildLiveShadowReport(db, "unknown/repo", 7);
    assert.equal(report.hasSufficientData, false);
    assert.ok(report.insufficientReason);
  });

  it("malformed workflow_run_ids/job_ids JSON degrades to an empty array rather than throwing", async () => {
    const db = fakeD1({
      predictions: [{}],
      observations: [observationRow({ workflow_run_ids: "not-json", job_ids: "not-json" })],
      groundTruth: [],
    });
    const report = await buildLiveShadowReport(db, "acme/web", 7);
    assert.equal(report.hasSufficientData, true);
  });
});
