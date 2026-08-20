/**
 * Cross-container-instance resumability core. Deliberately dependency-free from @cloudflare/sandbox
 * (same reason as retry.ts/session-id.ts) so the actual crash/resume DECISION LOGIC is unit-testable in
 * plain Node against fake in-memory D1/R2 implementations, not just exercised live.
 *
 * Built 2026-08-21 for the Stage 0 medium batch, whose spec explicitly called cross-container
 * resumability BLOCKING: "A container crash after delta N must not require recomputing deltas 1...N.
 * A retry from another Sandbox/container instance must recognize previously completed work."
 *
 * Design: the container clones+samples commits (cheap, ~1-3s) and returns CANDIDATE deltas without
 * analyzing them. This module (running in the WORKER, which holds the real D1/R2 bindings) then decides
 * which candidates are already done - by checking D1's completed_deltas table (the resumability index
 * schema.sql already describes: "single indexed lookup on the primary key... before re-running
 * expensive analysis") AND verifying the R2 evidence a D1 row points at actually exists and parses,
 * since a D1 row alone doesn't prove the evidence survived (a crash between the R2 write and the D1
 * write, or between two separate writes, would leave an inconsistent checkpoint). Only the confirmed-
 * complete subset is skipped; everything else - including "checkpoint says done but evidence is
 * missing/corrupt" - is real analysis work, dispatched to the container in small batches so a mid-run
 * failure only loses the CURRENT in-flight batch, not everything before it. A fresh top-level retry
 * (real container B) re-runs planResumableWork() from scratch and, because completed work is already in
 * D1/R2, naturally recovers where the previous attempt left off - no separate "resume" code path needed.
 */

export interface DeltaCandidate {
  baseSha: string;
  headSha: string;
  logicalDeltaKey: string;
}

export interface CompletedDeltaLookup {
  logicalDeltaKey: string;
  r2EvidenceKey: string;
}

/** Minimal abstraction over the real D1Database/R2Bucket bindings, so the decision logic here can be
 * tested against fake in-memory implementations without touching Cloudflare at all. */
export interface ResumabilityStore {
  /** D1 SELECT logical_delta_key, r2_evidence_key FROM completed_deltas WHERE logical_delta_key IN (...) */
  findCompleted(logicalDeltaKeys: string[]): Promise<CompletedDeltaLookup[]>;
  /** R2 existence + parseability check for the evidence a D1 row claims exists. */
  evidenceIsValid(r2EvidenceKey: string): Promise<boolean>;
}

export interface ResumabilityPlan {
  todo: DeltaCandidate[];
  /** The valid, confirmed-complete checkpoints - not just a count, so a caller that wants the full
   * evidence for every candidate (not only the newly-analyzed ones) can fetch it by r2EvidenceKey
   * without a second D1 round-trip. */
  resumed: CompletedDeltaLookup[];
  resumedDeltas: number;
  invalidCheckpoints: number;
}

export async function planResumableWork(candidates: DeltaCandidate[], store: ResumabilityStore): Promise<ResumabilityPlan> {
  if (candidates.length === 0) return { todo: [], resumed: [], resumedDeltas: 0, invalidCheckpoints: 0 };

  const found = await store.findCompleted(candidates.map((c) => c.logicalDeltaKey));
  const foundByKey = new Map(found.map((f) => [f.logicalDeltaKey, f]));

  const todo: DeltaCandidate[] = [];
  const resumed: CompletedDeltaLookup[] = [];
  let invalidCheckpoints = 0;

  for (const candidate of candidates) {
    const checkpoint = foundByKey.get(candidate.logicalDeltaKey);
    if (!checkpoint) {
      todo.push(candidate);
      continue;
    }
    const valid = await store.evidenceIsValid(checkpoint.r2EvidenceKey);
    if (valid) {
      resumed.push(checkpoint);
    } else {
      // A D1 row exists (something started or claimed to finish this delta) but the R2 evidence it
      // points at is missing or unparseable - a crashed/partial write, not a real completion. Treat as
      // not-done and re-analyze, rather than silently trusting a checkpoint that can't be verified.
      invalidCheckpoints++;
      todo.push(candidate);
    }
  }

  return { todo, resumed, resumedDeltas: resumed.length, invalidCheckpoints };
}

export interface PersistableResult {
  logicalDeltaKey: string;
  r2EvidenceKey: string;
  record: unknown;
}

/** Minimal abstraction over the write side (R2 put + D1 insert with ON CONFLICT DO NOTHING). */
export interface PersistenceStore {
  putEvidence(r2EvidenceKey: string, record: unknown): Promise<void>;
  /** Returns whether the D1 row was actually inserted (false = a row for this key already existed -
   * ON CONFLICT DO NOTHING fired, i.e. a duplicate was prevented, not a new completion). */
  recordCompleted(logicalDeltaKey: string, r2EvidenceKey: string): Promise<{ inserted: boolean }>;
}

export interface PersistBatchOutcome {
  newDeltasAnalyzed: number;
  duplicateDeltasPrevented: number;
}

export async function persistBatchResults(results: PersistableResult[], store: PersistenceStore): Promise<PersistBatchOutcome> {
  let newDeltasAnalyzed = 0;
  let duplicateDeltasPrevented = 0;

  for (const result of results) {
    // Evidence is written before the D1 completion row, not after - a crash between these two writes
    // leaves an R2 object with no matching D1 row, which is simply invisible to findCompleted() on the
    // next attempt (that delta will just be re-analyzed and overwritten) - safe, if slightly wasteful.
    // The dangerous direction (a D1 row claiming completion with no real evidence behind it) is exactly
    // what evidenceIsValid() in planResumableWork() guards against, which is why write order matters.
    await store.putEvidence(result.r2EvidenceKey, result.record);
    const { inserted } = await store.recordCompleted(result.logicalDeltaKey, result.r2EvidenceKey);
    if (inserted) {
      newDeltasAnalyzed++;
    } else {
      duplicateDeltasPrevented++;
    }
  }

  return { newDeltasAnalyzed, duplicateDeltasPrevented };
}

/** Splits a todo list into fixed-size batches for incremental dispatch+persistence - the mechanism that
 * bounds how much work a mid-run failure can lose to one batch's worth, not the whole repository. */
export function batchDeltas<T>(items: T[], batchSize: number): T[][] {
  if (batchSize <= 0) throw new Error(`batchDeltas: batchSize must be positive, got ${batchSize}`);
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += batchSize) batches.push(items.slice(i, i + batchSize));
  return batches;
}
