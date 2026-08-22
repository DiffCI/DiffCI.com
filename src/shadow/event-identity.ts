/**
 * Stage 2 event-identity model (docs/research/2026-08-21-stage2-architecture.md §Phase 2). Two distinct
 * keys, deliberately not one - see the schema comment in
 * src/research/cloudflare/schema-migration-2026-08-21-stage2-shadow.sql for the full rationale:
 *
 * - logicalDeltaKey identifies a PREDICTION: a pure function of (repository, baseSha, headSha, DiffCI's
 *   own analysis/graph version). A workflow retry of the same commit must reuse the same prediction, not
 *   recompute it - re-deriving a prediction after possibly having seen a real outcome is exactly what
 *   Phase 5 forbids ("the shadow prediction must not be influenced by the result it will later be
 *   compared against").
 * - logicalEventKey identifies one REAL OBSERVED CI ATTEMPT for a commit: repository + headSha +
 *   workflowRunId + workflowRunAttempt (the exact identity the task specification itself suggested).
 *   Deliberately one row per attempt, not deduped to one per commit, so a flaky retry's different real
 *   outcome is visible rather than silently overwritten.
 */

export interface PredictionIdentityInput {
  repository: string;
  baseSha: string;
  headSha: string;
  diffciAnalysisVersion: string;
  graphVersion: string;
}

export interface GroundTruthIdentityInput {
  repository: string;
  headSha: string;
  /** The real GitHub Actions run id, when the ground truth came from a specific known run. */
  workflowRunId?: string;
  workflowRunAttempt?: number;
}

/** Colon-delimited, deliberately not JSON/base64 - kept human-readable in R2 keys and D1 primary keys
 * (see the module doc comment above for the full identity rationale). Field order is part of the
 * contract: callers must not reorder it without also bumping graphVersion/diffciAnalysisVersion,
 * since a reordering would silently change existing keys' meaning for already-recorded predictions. */
export function computeLogicalDeltaKey(input: PredictionIdentityInput): string {
  return `${input.repository}:${input.baseSha}:${input.headSha}:${input.diffciAnalysisVersion}:${input.graphVersion}`;
}

export function computeLogicalEventKey(input: GroundTruthIdentityInput): string {
  const runPart = input.workflowRunId ?? "poll";
  const attemptPart = input.workflowRunAttempt ?? 1;
  return `${input.repository}:${input.headSha}:${runPart}:${attemptPart}`;
}

/**
 * The prospectiveness proof (Phase 5): true iff the prediction is provably older than the ground truth
 * it's being compared against. Prefers the workflow's own completion timestamp; falls back to the time
 * ground truth was fetched (a conservative substitute - always >= the real completion time, so it can
 * only ever make this check STRICTER, never looser, when the real completion timestamp is unavailable).
 */
export function predictionPrecededGroundTruth(
  predictionCreatedAt: string,
  groundTruth: { workflowCompletedAt?: string; groundTruthFetchedAt: string },
): boolean {
  const predictedAtMs = Date.parse(predictionCreatedAt);
  const observedAtMs = Date.parse(groundTruth.workflowCompletedAt ?? groundTruth.groundTruthFetchedAt);
  if (Number.isNaN(predictedAtMs) || Number.isNaN(observedAtMs)) return false;
  return predictedAtMs > observedAtMs;
}
