/**
 * Read-only boundary onto Stage 2F's shadow evidence (Part 20). This is the ONLY file in the product
 * layer allowed to query the diffci-research D1 database (shadow_predictions/shadow_ground_truth,
 * schema in src/research/cloudflare/schema-migration-2026-08-21-stage2-shadow.sql) - every method here
 * is a SELECT, nothing here ever writes to diffci-research. The Worker wiring (product-worker.ts) binds
 * diffci-research as a SEPARATE, additional D1 binding purely for this boundary; nothing else in the
 * product/billing/usage/runner modules may touch it directly.
 *
 * Chosen approach (Part 20's "smallest safe implementation"): a direct read-only D1Binding to the
 * existing database, not a replicated copy or an internal service call - there is no new infrastructure
 * to stand up, and a read-only SQL binding cannot mutate shadow_predictions/shadow_ground_truth by
 * construction (this module simply never issues an INSERT/UPDATE/DELETE against it). A future move to a
 * replicated summary table or an internal service call remains possible without changing this
 * interface's shape.
 */
export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

export interface ShadowPredictionSummary {
  logicalDeltaKey: string;
  repository: string; // "owner/name" - shadow's own key, not a product repositoryId
  /** Widened onto the existing head_sha column (2026-08-23, src/usage/duration-capture-job.ts) - a pure
   * read-projection change, no schema change, no write path touched. Lets the duration-capture pipeline
   * independently re-fetch real GitHub job timing for this exact commit without needing any other source
   * of "which commits to check." */
  headSha: string;
  planMode: "FULL" | "SELECTIVE";
  opportunityCategory: "MANDATORY_FALLBACK" | "BASELINE_ALREADY_OPTIMAL" | "DISCRIMINATIVE_OPPORTUNITY";
  testsSelectedDiffci: number;
  testsTotalFull: number;
  createdAt: string;
}

export interface ShadowGroundTruthSummary {
  logicalDeltaKey: string;
  relevantFailuresObserved: number;
  relevantFailuresEvaluable: number;
  failuresPreservedByDiffci: number;
  workflowConclusion?: string;
  predictionPrecededGroundTruth: boolean;
}

export interface ShadowSafetySnapshot {
  evaluableFailures: number;
  failuresPreserved: number;
  falseNegatives: number;
}

export interface ShadowReadBoundary {
  /** Predictions for a repository (identified by "owner/name", the only key shadow_repositories has -
   * see the Part 1 audit) within a time window. Read-only. */
  listPredictions(ownerName: string, startIso: string, endIso: string): Promise<ShadowPredictionSummary[]>;
  getGroundTruthForDelta(logicalDeltaKey: string): Promise<ShadowGroundTruthSummary | null>;
  /** The dashboard "Safety" section's numbers (Part 21) - deliberately scoped to a repository (or, if
   * ownerName is omitted, the whole shadow system) since Stage 2 has no organization concept to scope by
   * directly. */
  getSafetySnapshot(ownerName?: string): Promise<ShadowSafetySnapshot>;
  /** Repositories currently in an active shadow-observation state (SHADOW_ACTIVE/SHADOW_LIMITED) -
   * External Shadow Pilot M1 (2026-08-25). Deliberately excludes INSTALLING/VALIDATING (not yet producing
   * trustworthy predictions), PAUSED/REMOVED (no longer observed), and UNSUPPORTED/
   * READY_FOR_ENFORCEMENT_REVIEW (different concerns entirely) - a repository must be genuinely, actively
   * observed before any economics capture spends a real GitHub API call on it. */
  listEnrolledRepositories(): Promise<string[]>;
}

export function makeD1ShadowReadBoundary(db: D1Binding): ShadowReadBoundary {
  return {
    async listPredictions(ownerName, startIso, endIso) {
      const { results } = await db
        .prepare(
          `SELECT logical_delta_key, repository, head_sha, plan_mode, opportunity_category, tests_selected_diffci, tests_total_full, created_at
           FROM shadow_predictions
           WHERE repository = ? AND created_at >= ? AND created_at < ?
           ORDER BY created_at DESC`,
        )
        .bind(ownerName, startIso, endIso)
        .all<Record<string, unknown>>();
      return results.map((row) => ({
        logicalDeltaKey: row.logical_delta_key as string,
        repository: row.repository as string,
        headSha: row.head_sha as string,
        planMode: row.plan_mode as "FULL" | "SELECTIVE",
        opportunityCategory: row.opportunity_category as ShadowPredictionSummary["opportunityCategory"],
        testsSelectedDiffci: row.tests_selected_diffci as number,
        testsTotalFull: row.tests_total_full as number,
        createdAt: row.created_at as string,
      }));
    },

    async getGroundTruthForDelta(logicalDeltaKey) {
      const row = await db
        .prepare(
          `SELECT logical_delta_key, relevant_failures_observed, relevant_failures_evaluable, failures_preserved_by_diffci, workflow_conclusion, prediction_preceded_ground_truth
           FROM shadow_ground_truth WHERE logical_delta_key = ?`,
        )
        .bind(logicalDeltaKey)
        .first<Record<string, unknown>>();
      if (!row) return null;
      return {
        logicalDeltaKey: row.logical_delta_key as string,
        relevantFailuresObserved: row.relevant_failures_observed as number,
        relevantFailuresEvaluable: row.relevant_failures_evaluable as number,
        failuresPreservedByDiffci: row.failures_preserved_by_diffci as number,
        workflowConclusion: (row.workflow_conclusion as string | null) ?? undefined,
        predictionPrecededGroundTruth: Boolean(row.prediction_preceded_ground_truth),
      };
    },

    async getSafetySnapshot(ownerName) {
      const row = ownerName
        ? await db
            .prepare(
              `SELECT COALESCE(SUM(g.relevant_failures_evaluable), 0) as evaluable,
                      COALESCE(SUM(g.failures_preserved_by_diffci), 0) as preserved
               FROM shadow_ground_truth g JOIN shadow_predictions p ON p.logical_delta_key = g.logical_delta_key
               WHERE p.repository = ?`,
            )
            .bind(ownerName)
            .first<{ evaluable: number; preserved: number }>()
        : await db.prepare(`SELECT COALESCE(SUM(relevant_failures_evaluable), 0) as evaluable, COALESCE(SUM(failures_preserved_by_diffci), 0) as preserved FROM shadow_ground_truth`).bind().first<{ evaluable: number; preserved: number }>();
      const evaluableFailures = row?.evaluable ?? 0;
      const failuresPreserved = row?.preserved ?? 0;
      return { evaluableFailures, failuresPreserved, falseNegatives: Math.max(0, evaluableFailures - failuresPreserved) };
    },

    async listEnrolledRepositories() {
      const { results } = await db
        .prepare(`SELECT repository FROM shadow_repositories WHERE state IN ('SHADOW_ACTIVE', 'SHADOW_LIMITED') ORDER BY repository`)
        .bind()
        .all<{ repository: string }>();
      return results.map((r) => r.repository);
    },
  };
}
