import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  batchDeltas,
  persistBatchResults,
  planResumableWork,
  type CompletedDeltaLookup,
  type DeltaCandidate,
  type PersistableResult,
  type PersistenceStore,
  type ResumabilityStore,
} from "../../../src/research/cloudflare/resumable-batch.js";

// Built for the 2026-08-21 Stage 0 medium batch, whose spec called cross-container resumability
// BLOCKING and required simulating: container A completing some deltas, container A disappearing,
// container B resuming, already-completed deltas being skipped, incomplete records being handled
// safely, no duplicate aggregation, repository isolation, experiment-version/schema mismatch.

/** In-memory fake standing in for D1's completed_deltas table + R2 evidence objects, so a "container
 * disappearing" is modeled exactly as it really works: state lives in this shared store, not in any
 * process, so a fresh planResumableWork() call against the SAME store sees whatever survived. */
class FakeDurableStore implements ResumabilityStore, PersistenceStore {
  private readonly completed = new Map<string, string>(); // logicalDeltaKey -> r2EvidenceKey
  private readonly evidence = new Map<string, unknown>(); // r2EvidenceKey -> record (or absent = missing/corrupt)

  async findCompleted(logicalDeltaKeys: string[]): Promise<CompletedDeltaLookup[]> {
    const keys = new Set(logicalDeltaKeys);
    const out: CompletedDeltaLookup[] = [];
    for (const [logicalDeltaKey, r2EvidenceKey] of this.completed) {
      if (keys.has(logicalDeltaKey)) out.push({ logicalDeltaKey, r2EvidenceKey });
    }
    return out;
  }

  async evidenceIsValid(r2EvidenceKey: string): Promise<boolean> {
    return this.evidence.has(r2EvidenceKey);
  }

  async putEvidence(r2EvidenceKey: string, record: unknown): Promise<void> {
    this.evidence.set(r2EvidenceKey, record);
  }

  async recordCompleted(logicalDeltaKey: string, r2EvidenceKey: string): Promise<{ inserted: boolean }> {
    if (this.completed.has(logicalDeltaKey)) return { inserted: false };
    this.completed.set(logicalDeltaKey, r2EvidenceKey);
    return { inserted: true };
  }

  // Test-only helpers to simulate corruption/partial-write scenarios directly.
  simulateCorruptCheckpoint(logicalDeltaKey: string, r2EvidenceKey: string): void {
    this.completed.set(logicalDeltaKey, r2EvidenceKey); // D1 row exists...
    this.evidence.delete(r2EvidenceKey); // ...but the R2 object it points at does not (or never landed).
  }
}

function candidate(owner: string, name: string, baseSha: string, headSha: string, diffciVersion = "0.6.0", schemaVersion = "v1"): DeltaCandidate {
  return {
    baseSha,
    headSha,
    logicalDeltaKey: `${owner}/${name}:${baseSha}:${headSha}:${diffciVersion}:${schemaVersion}`,
  };
}

function toResult(c: DeltaCandidate, runId: string): PersistableResult {
  return { logicalDeltaKey: c.logicalDeltaKey, r2EvidenceKey: `validation/${runId}/commits/${c.logicalDeltaKey}`, record: { headSha: c.headSha } };
}

describe("planResumableWork / persistBatchResults - cross-container resumability", () => {
  it("container A completes some deltas, disappears, container B resuming recognizes them and skips them", async () => {
    const store = new FakeDurableStore();
    const candidates = [
      candidate("pmndrs", "zustand", "a1", "a2"),
      candidate("pmndrs", "zustand", "a2", "a3"),
      candidate("pmndrs", "zustand", "a3", "a4"),
    ];

    // Container A: plans, completes only the first two (then "disappears" - nothing more happens).
    const planA = await planResumableWork(candidates, store);
    assert.equal(planA.todo.length, 3);
    assert.equal(planA.resumedDeltas, 0);
    const completedByA = [toResult(candidates[0]!, "runA"), toResult(candidates[1]!, "runA")];
    const outcomeA = await persistBatchResults(completedByA, store);
    assert.equal(outcomeA.newDeltasAnalyzed, 2);
    assert.equal(outcomeA.duplicateDeltasPrevented, 0);

    // Container B: a FRESH plan against the SAME durable store (this is what "another Sandbox/container
    // instance" resuming looks like - no in-process state carried over, only what's in the store).
    const planB = await planResumableWork(candidates, store);
    assert.equal(planB.resumedDeltas, 2, "the two deltas container A finished must be recognized as already done");
    assert.equal(planB.resumed.length, 2, "plan.resumed must carry the actual checkpoints, not just a count, so a caller can fetch their full evidence");
    assert.deepEqual(new Set(planB.resumed.map((r) => r.logicalDeltaKey)), new Set([candidates[0]!.logicalDeltaKey, candidates[1]!.logicalDeltaKey]));
    assert.equal(planB.todo.length, 1, "only the one delta container A never got to should remain");
    assert.equal(planB.todo[0]!.headSha, "a4");
  });

  it("incomplete/corrupt checkpoints (D1 row with no matching R2 evidence) are re-analyzed, not silently trusted", async () => {
    const store = new FakeDurableStore();
    const good = candidate("unjs", "h3", "b1", "b2");
    const corrupt = candidate("unjs", "h3", "b2", "b3");

    await persistBatchResults([toResult(good, "run1")], store);
    store.simulateCorruptCheckpoint(corrupt.logicalDeltaKey, `validation/run1/commits/${corrupt.logicalDeltaKey}`);

    const plan = await planResumableWork([good, corrupt], store);
    assert.equal(plan.resumedDeltas, 1, "only the genuinely valid checkpoint should be skipped");
    assert.equal(plan.invalidCheckpoints, 1, "the corrupt checkpoint must be flagged, not silently skipped or silently trusted");
    assert.equal(plan.todo.length, 1);
    assert.equal(plan.todo[0]!.headSha, "b3", "the corrupt-checkpoint delta must go back into the todo list for real re-analysis");
  });

  it("prevents duplicate aggregation - persisting the same logicalDeltaKey twice only counts once as new", async () => {
    const store = new FakeDurableStore();
    const c = candidate("pmndrs", "jotai", "c1", "c2");
    const result = toResult(c, "runX");

    const first = await persistBatchResults([result], store);
    assert.equal(first.newDeltasAnalyzed, 1);
    assert.equal(first.duplicateDeltasPrevented, 0);

    // Same delta submitted again (e.g. two batches both picked it up due to an overlap, or a retried
    // batch re-submits work that actually landed just before the failure that triggered the retry).
    const second = await persistBatchResults([result], store);
    assert.equal(second.newDeltasAnalyzed, 0, "must not double-count an already-completed delta as newly analyzed");
    assert.equal(second.duplicateDeltasPrevented, 1);

    const finalPlan = await planResumableWork([c], store);
    assert.equal(finalPlan.resumedDeltas, 1, "the delta must appear exactly once in the completed index despite two persist attempts");
  });

  it("repository isolation - two different repositories' candidates never cross-contaminate the same store", async () => {
    const store = new FakeDurableStore();
    // Same base/head SHA pair, deliberately, to prove isolation comes from the repository being part
    // of the logicalDeltaKey, not from any accidental SHA-based bucketing.
    const zustandDelta = candidate("pmndrs", "zustand", "shared-sha-1", "shared-sha-2");
    const jotaiDelta = candidate("pmndrs", "jotai", "shared-sha-1", "shared-sha-2");

    await persistBatchResults([toResult(zustandDelta, "runZ")], store);

    const jotaiPlan = await planResumableWork([jotaiDelta], store);
    assert.equal(jotaiPlan.resumedDeltas, 0, "jotai's identically-shaped delta must NOT be considered complete just because zustand's was");
    assert.equal(jotaiPlan.todo.length, 1);

    const zustandPlan = await planResumableWork([zustandDelta], store);
    assert.equal(zustandPlan.resumedDeltas, 1, "zustand's own delta must still be recognized as complete");
  });

  it("experiment-version/schema mismatch - a version bump produces a different key, so old evidence is never mistaken for current", async () => {
    const store = new FakeDurableStore();
    const oldVersion = candidate("pmndrs", "zustand", "d1", "d2", "0.5.0", "v1");
    const newVersion = candidate("pmndrs", "zustand", "d1", "d2", "0.6.0", "v1");
    assert.notEqual(oldVersion.logicalDeltaKey, newVersion.logicalDeltaKey);

    await persistBatchResults([toResult(oldVersion, "runOld")], store);

    const planForNewVersion = await planResumableWork([newVersion], store);
    assert.equal(planForNewVersion.resumedDeltas, 0, "evidence from an old diffciVersion/schemaVersion must not be trusted for the current version");
    assert.equal(planForNewVersion.todo.length, 1);
  });

  it("handles an empty candidate list without error", async () => {
    const store = new FakeDurableStore();
    const plan = await planResumableWork([], store);
    assert.deepEqual(plan, { todo: [], resumed: [], resumedDeltas: 0, invalidCheckpoints: 0 });
  });
});

describe("batchDeltas", () => {
  it("splits into fixed-size batches, with a shorter final batch", () => {
    const items = [1, 2, 3, 4, 5, 6, 7];
    assert.deepEqual(batchDeltas(items, 3), [[1, 2, 3], [4, 5, 6], [7]]);
  });

  it("handles an exact multiple with no short final batch", () => {
    assert.deepEqual(batchDeltas([1, 2, 3, 4], 2), [[1, 2], [3, 4]]);
  });

  it("handles an empty list", () => {
    assert.deepEqual(batchDeltas([], 5), []);
  });

  it("throws on a non-positive batch size rather than looping forever", () => {
    assert.throws(() => batchDeltas([1, 2, 3], 0), /positive/);
    assert.throws(() => batchDeltas([1, 2, 3], -1), /positive/);
  });
});
