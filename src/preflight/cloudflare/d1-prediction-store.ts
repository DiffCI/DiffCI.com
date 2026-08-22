/**
 * D1-backed PredictionStore (Preflight P1 Part D/M) - implements the same interface and enforces the
 * same invariants as src/preflight/prediction-store.ts's InMemoryPredictionStore (structural
 * immutability: no UPDATE statement anywhere in this file touches preflight_predictions; temporal
 * enforcement: createLivePrediction refuses when ground truth is already known). Same D1Binding idiom
 * the rest of the codebase uses (src/runner/store.ts).
 *
 * Talks to its OWN `diffci-preflight` D1 database (src/preflight/cloudflare/schema.sql) - never
 * diffci-product's or diffci-research's databases, preserving the storage separation Part D's own
 * header comment establishes.
 */
import {
  GroundTruthAlreadyKnownError,
  FutureReplayError,
  type PredictionStore,
  type PredictionRecord,
  type CreatePredictionInput,
  type CreateReplayPredictionInput,
} from "../prediction-store.js";

export interface D1Binding {
  prepare(query: string): {
    bind(...values: unknown[]): {
      run(): Promise<{ meta?: { changes?: number } }>;
      all<T = unknown>(): Promise<{ results: T[] }>;
      first<T = unknown>(): Promise<T | null>;
    };
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToPrediction(row: Record<string, unknown>): PredictionRecord {
  return {
    id: row.id as string,
    repositoryOwnerName: row.repository_owner_name as string,
    commitSha: row.commit_sha as string,
    createdAt: row.created_at as string,
    mode: row.mode as "LIVE" | "REPLAY",
    // Omit the key entirely for LIVE predictions (mirrors CreatePredictionInput's own shape, which
    // never sets replayedAt) rather than an explicit `replayedAt: undefined` - keeps a round-tripped
    // record deep-equal to the one createLivePrediction() returned, not just value-equal per field.
    ...(row.replayed_at ? { replayedAt: row.replayed_at as string } : {}),
    changedFiles: JSON.parse(row.changed_files_json as string),
    riskScore: row.risk_score as number,
    riskReasons: JSON.parse(row.risk_reasons_json as string),
    recommendedChecks: JSON.parse(row.recommended_checks_json as string),
    predictedFailureClasses: JSON.parse(row.predicted_failure_classes_json as string),
    expectedEarlyDetectionStrategy: row.expected_early_detection_strategy as string,
    evidenceVersion: row.evidence_version as string,
    algorithmVersion: row.algorithm_version as string,
  };
}

async function insertPrediction(db: D1Binding, record: PredictionRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO preflight_predictions (id, repository_owner_name, commit_sha, created_at, mode, replayed_at, changed_files_json, risk_score, risk_reasons_json, recommended_checks_json, predicted_failure_classes_json, expected_early_detection_strategy, evidence_version, algorithm_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      record.id,
      record.repositoryOwnerName,
      record.commitSha,
      record.createdAt,
      record.mode,
      record.replayedAt ?? null,
      JSON.stringify(record.changedFiles),
      record.riskScore,
      JSON.stringify(record.riskReasons),
      JSON.stringify(record.recommendedChecks),
      JSON.stringify(record.predictedFailureClasses),
      record.expectedEarlyDetectionStrategy,
      record.evidenceVersion,
      record.algorithmVersion,
    )
    .run();
}

export function makeD1PredictionStore(db: D1Binding): PredictionStore {
  const store: PredictionStore = {
    async createLivePrediction(input: CreatePredictionInput): Promise<PredictionRecord> {
      if (await store.hasGroundTruthKnown(input.repositoryOwnerName, input.commitSha)) {
        throw new GroundTruthAlreadyKnownError(input.repositoryOwnerName, input.commitSha);
      }

      const record: PredictionRecord = { id: crypto.randomUUID(), createdAt: nowIso(), mode: "LIVE", ...input };
      await insertPrediction(db, record);
      return record;
    },

    async createReplayPrediction(input: CreateReplayPredictionInput): Promise<PredictionRecord> {
      const now = nowIso();
      if (input.simulatedCreatedAt > now) throw new FutureReplayError(input.simulatedCreatedAt, now);
      const { simulatedCreatedAt, ...rest } = input;
      const record: PredictionRecord = { id: crypto.randomUUID(), createdAt: simulatedCreatedAt, mode: "REPLAY", replayedAt: now, ...rest };
      await insertPrediction(db, record);
      return record;
    },

    async getPrediction(id: string): Promise<PredictionRecord | undefined> {
      const row = await db.prepare(`SELECT * FROM preflight_predictions WHERE id = ?`).bind(id).first<Record<string, unknown>>();
      return row ? rowToPrediction(row) : undefined;
    },

    async listPredictions(): Promise<readonly PredictionRecord[]> {
      const { results } = await db.prepare(`SELECT * FROM preflight_predictions ORDER BY created_at ASC`).bind().all<Record<string, unknown>>();
      return results.map(rowToPrediction);
    },

    // Real ground-truth-known state lives in preflight_reconciliations itself (a real JOIN query, see
    // hasGroundTruthKnown below) rather than a separate tracked set (unlike InMemoryPredictionStore,
    // which has no reconciliations table to query against) - recordGroundTruthKnown is a genuine no-op
    // here by design, kept only to satisfy the shared PredictionStore interface: writing a
    // preflight_reconciliations row (via the reconciliation flow, elsewhere) IS what makes ground truth
    // "known" for this store, so there is nothing additional to record.
    async recordGroundTruthKnown(): Promise<void> {
      // intentionally no-op - see comment above
    },

    async hasGroundTruthKnown(repositoryOwnerName: string, commitSha: string): Promise<boolean> {
      const row = await db
        .prepare(`SELECT 1 FROM preflight_reconciliations r JOIN preflight_predictions p ON p.id = r.prediction_id WHERE p.repository_owner_name = ? AND p.commit_sha = ? LIMIT 1`)
        .bind(repositoryOwnerName, commitSha)
        .first();
      return row !== null;
    },
  };
  return store;
}
