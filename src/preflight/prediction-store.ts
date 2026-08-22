/**
 * Shadow Preflight prediction storage (Preflight P1 Part D) - SEPARATE from Stage 2F's own
 * shadow_predictions/shadow_ground_truth (src/research/cloudflare/schema-migration-2026-08-21-stage2-shadow.sql).
 * See src/preflight/cloudflare/schema.sql for the real D1 table shape this mirrors.
 *
 * The hard requirement this module exists to satisfy: "prediction must be provably created before CI
 * ground truth is read, immutable except reconciliation fields." Two separate mechanisms enforce this:
 *
 *  1. STRUCTURAL immutability - PredictionRecord has no method anywhere in this file that mutates an
 *     existing record. Once created, a prediction is only ever read, never written again. Reconciliation
 *     data (Part E) is intentionally modeled as a wholly separate concept in reconciliation.ts, not a
 *     field on this record - there is nothing here to accidentally mutate.
 *
 *  2. TEMPORAL enforcement for LIVE predictions - createLivePrediction() refuses to create a prediction
 *     for a (repository, commit) pair that this store has already been told has known ground truth
 *     (via recordGroundTruthKnown(), which the reconciliation flow calls once it reads a real CI
 *     result). This makes "created before ground truth" a real, testable invariant rather than a
 *     documentation promise - see tests/preflight/prediction-store.test.ts.
 *
 * REPLAY predictions (Part G's historical chronological replay) are exempt from #2 by design - replay
 * necessarily runs long after the historical ground truth exists. What replay must NOT do is feed the
 * prediction algorithm any evidence from after `simulatedCreatedAt` - that leakage-safety property is
 * the replay ENGINE's job (Part G), not this store's; this store only records both timestamps honestly
 * (`createdAt` = the simulated as-of time being represented, `replayedAt` = the real wall-clock time
 * the replay actually executed) so a reader can always tell which kind of prediction they're looking at.
 */
import type { RiskReason } from "./risk-model.js";
import type { FailureClass } from "./taxonomy.js";

export interface PredictionRecord {
  id: string;
  repositoryOwnerName: string;
  commitSha: string;
  createdAt: string; // ISO 8601
  mode: "LIVE" | "REPLAY";
  replayedAt?: string; // ISO 8601, set only for REPLAY
  changedFiles: string[];
  riskScore: number;
  riskReasons: RiskReason[];
  recommendedChecks: string[];
  predictedFailureClasses: FailureClass[];
  expectedEarlyDetectionStrategy: string;
  evidenceVersion: string;
  algorithmVersion: string;
}

export interface CreatePredictionInput {
  repositoryOwnerName: string;
  commitSha: string;
  changedFiles: string[];
  riskScore: number;
  riskReasons: RiskReason[];
  recommendedChecks: string[];
  predictedFailureClasses: FailureClass[];
  expectedEarlyDetectionStrategy: string;
  evidenceVersion: string;
  algorithmVersion: string;
}

export interface CreateReplayPredictionInput extends CreatePredictionInput {
  /** The historical moment this replayed prediction claims to represent - "as of this point in the
   * past, here is what the algorithm would have predicted." */
  simulatedCreatedAt: string;
}

export class GroundTruthAlreadyKnownError extends Error {
  constructor(repositoryOwnerName: string, commitSha: string) {
    super(
      `refusing to create a LIVE prediction for ${repositoryOwnerName}@${commitSha}: ground truth for this commit is already known to this store, so a new LIVE prediction now would not genuinely precede CI - this would violate Preflight P1's "prediction must be created before ground truth" invariant`,
    );
    this.name = "GroundTruthAlreadyKnownError";
  }
}

export class FutureReplayError extends Error {
  constructor(simulatedCreatedAt: string, now: string) {
    super(`a REPLAY prediction's simulatedCreatedAt (${simulatedCreatedAt}) is after the real wall-clock time this replay is running (${now}) - a replay cannot claim to represent a moment in its own future`);
    this.name = "FutureReplayError";
  }
}

export interface PredictionStore {
  createLivePrediction(input: CreatePredictionInput): Promise<PredictionRecord>;
  createReplayPrediction(input: CreateReplayPredictionInput): Promise<PredictionRecord>;
  getPrediction(id: string): Promise<PredictionRecord | undefined>;
  listPredictions(): Promise<readonly PredictionRecord[]>;
  /** Called by the reconciliation flow once real CI ground truth has been read for this commit -
   * after this call, createLivePrediction() for the same (repo, commit) pair is refused. Idempotent. */
  recordGroundTruthKnown(repositoryOwnerName: string, commitSha: string): void;
  hasGroundTruthKnown(repositoryOwnerName: string, commitSha: string): boolean;
}

function defaultId(): string {
  return crypto.randomUUID();
}

/** Reference implementation - real enough to back tests and a real Worker's request-scoped state, but
 * not durable; a D1-backed implementation (mirroring src/preflight/cloudflare/schema.sql) implements
 * the same PredictionStore interface for production use, sharing every invariant enforced here since
 * they live in this interface's contract, not in any one implementation. */
export class InMemoryPredictionStore implements PredictionStore {
  private readonly predictions = new Map<string, PredictionRecord>();
  private readonly groundTruthKnownCommits = new Set<string>();

  constructor(
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly generateId: () => string = defaultId,
  ) {}

  private commitKey(repositoryOwnerName: string, commitSha: string): string {
    return `${repositoryOwnerName}@${commitSha}`;
  }

  async createLivePrediction(input: CreatePredictionInput): Promise<PredictionRecord> {
    const key = this.commitKey(input.repositoryOwnerName, input.commitSha);
    if (this.groundTruthKnownCommits.has(key)) {
      throw new GroundTruthAlreadyKnownError(input.repositoryOwnerName, input.commitSha);
    }
    const record: PredictionRecord = { id: this.generateId(), createdAt: this.now(), mode: "LIVE", ...input };
    this.predictions.set(record.id, record);
    return record;
  }

  async createReplayPrediction(input: CreateReplayPredictionInput): Promise<PredictionRecord> {
    const nowIso = this.now();
    if (input.simulatedCreatedAt > nowIso) throw new FutureReplayError(input.simulatedCreatedAt, nowIso);
    const { simulatedCreatedAt, ...rest } = input;
    const record: PredictionRecord = { id: this.generateId(), createdAt: simulatedCreatedAt, mode: "REPLAY", replayedAt: nowIso, ...rest };
    this.predictions.set(record.id, record);
    return record;
  }

  async getPrediction(id: string): Promise<PredictionRecord | undefined> {
    return this.predictions.get(id);
  }

  async listPredictions(): Promise<readonly PredictionRecord[]> {
    return [...this.predictions.values()];
  }

  recordGroundTruthKnown(repositoryOwnerName: string, commitSha: string): void {
    this.groundTruthKnownCommits.add(this.commitKey(repositoryOwnerName, commitSha));
  }

  hasGroundTruthKnown(repositoryOwnerName: string, commitSha: string): boolean {
    return this.groundTruthKnownCommits.has(this.commitKey(repositoryOwnerName, commitSha));
  }
}
