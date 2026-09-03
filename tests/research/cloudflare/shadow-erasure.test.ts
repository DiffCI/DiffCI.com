/**
 * Fake-store/fake-bucket tests for shadow-erasure.ts's orchestration - the D1 query correctness
 * itself is covered against real SQLite in shadow-store.test.ts ("shadow-store: erasure"). What this
 * file exists to prove: R2 keys are read and deleted BEFORE the D1 rows that name them are removed,
 * multiple repositories are each handled independently, and the retention sweep's cutoff math is
 * exercised end to end through the public sweepExpiredEvidence entry point.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eraseInstallation, sweepExpiredEvidence, type ErasureBucket, type ErasureStore } from "../../../src/research/cloudflare/shadow-erasure.js";

interface FakeState {
  reposByInstallation: Record<string, string[]>;
  evidenceKeysByRepo: Record<string, string[]>;
  erasedRepos: string[];
  removedRepos: Array<{ repository: string; removedAt: string }>;
  expiredEvidenceKeys: string[];
  expiredEraseCalls: number;
  deletedKeys: string[][];
}

function makeFakes(state: Partial<FakeState> = {}): { store: ErasureStore; bucket: ErasureBucket; calls: FakeState } {
  const calls: FakeState = {
    reposByInstallation: {},
    evidenceKeysByRepo: {},
    erasedRepos: [],
    removedRepos: [],
    expiredEvidenceKeys: [],
    expiredEraseCalls: 0,
    deletedKeys: [],
    ...state,
  };

  const store: ErasureStore = {
    async listRepositoriesByInstallation(installationId) {
      return calls.reposByInstallation[installationId] ?? [];
    },
    async collectEvidenceKeys(repository) {
      return calls.evidenceKeysByRepo[repository] ?? [];
    },
    async eraseAnalysisRecordsForRepository(repository) {
      calls.erasedRepos.push(repository);
      return { predictionsDeleted: 1, groundTruthDeleted: 1, economicsDeleted: 1 };
    },
    async markRepositoryRemoved(repository, removedAt) {
      calls.removedRepos.push({ repository, removedAt });
    },
    async listExpiredEvidenceKeys() {
      return calls.expiredEvidenceKeys;
    },
    async eraseExpiredAnalysisRecords() {
      calls.expiredEraseCalls++;
      return { predictionsDeleted: 2, groundTruthDeleted: 2, economicsDeleted: 2 };
    },
  };

  const bucket: ErasureBucket = {
    async deleteMany(keys) {
      calls.deletedKeys.push(keys);
      return keys.length;
    },
  };

  return { store, bucket, calls };
}

describe("eraseInstallation", () => {
  it("erases every repository attributed to the installation: R2 keys read+deleted BEFORE the D1 rows naming them", async () => {
    const { store, bucket, calls } = makeFakes({
      reposByInstallation: { "111": ["acme/web", "acme/api"] },
      evidenceKeysByRepo: { "acme/web": ["r2/w1", "r2/w2"], "acme/api": ["r2/a1"] },
    });

    const result = await eraseInstallation(store, bucket, "111", "2026-09-04T00:00:00.000Z");

    assert.deepEqual(result.repositories, ["acme/web", "acme/api"]);
    assert.equal(result.predictionsDeleted, 2, "one per repository, from the fake");
    assert.equal(result.groundTruthDeleted, 2);
    assert.equal(result.economicsDeleted, 2);
    assert.equal(result.evidenceObjectsDeleted, 3, "2 for acme/web + 1 for acme/api");

    // Order per repository: collect+delete R2 keys, THEN erase D1 rows, THEN mark removed.
    assert.deepEqual(calls.deletedKeys, [["r2/w1", "r2/w2"], ["r2/a1"]]);
    assert.deepEqual(calls.erasedRepos, ["acme/web", "acme/api"]);
    assert.deepEqual(calls.removedRepos, [
      { repository: "acme/web", removedAt: "2026-09-04T00:00:00.000Z" },
      { repository: "acme/api", removedAt: "2026-09-04T00:00:00.000Z" },
    ]);
  });

  it("an installation with no attributed repositories erases nothing and calls nothing further", async () => {
    const { store, bucket, calls } = makeFakes({ reposByInstallation: {} });
    const result = await eraseInstallation(store, bucket, "999", "2026-09-04T00:00:00.000Z");
    assert.deepEqual(result.repositories, []);
    assert.equal(result.evidenceObjectsDeleted, 0);
    assert.deepEqual(calls.erasedRepos, []);
    assert.deepEqual(calls.removedRepos, []);
  });

  it("a repository with zero stored evidence objects still gets its D1 rows erased and is marked removed", async () => {
    const { store, bucket, calls } = makeFakes({
      reposByInstallation: { "111": ["acme/empty"] },
      evidenceKeysByRepo: {},
    });
    const result = await eraseInstallation(store, bucket, "111", "2026-09-04T00:00:00.000Z");
    assert.equal(result.evidenceObjectsDeleted, 0);
    assert.deepEqual(calls.erasedRepos, ["acme/empty"]);
    assert.deepEqual(calls.removedRepos, [{ repository: "acme/empty", removedAt: "2026-09-04T00:00:00.000Z" }]);
  });
});

describe("sweepExpiredEvidence", () => {
  it("computes the cutoff as exactly maxAgeDays before nowIso and reads/deletes R2 keys before erasing D1 rows", async () => {
    const { store, bucket, calls } = makeFakes({ expiredEvidenceKeys: ["r2/old-1", "r2/old-2"] });

    const result = await sweepExpiredEvidence(store, bucket, "2026-09-04T00:00:00.000Z", 90);

    assert.equal(result.cutoffIso, "2026-06-06T00:00:00.000Z", "90 days before 2026-09-04 is 2026-06-06");
    assert.equal(result.evidenceObjectsDeleted, 2);
    assert.equal(result.predictionsDeleted, 2);
    assert.deepEqual(calls.deletedKeys, [["r2/old-1", "r2/old-2"]]);
    assert.equal(calls.expiredEraseCalls, 1);
  });

  it("defaults to a 90-day cap when maxAgeDays is not supplied", async () => {
    const { store, bucket } = makeFakes({ expiredEvidenceKeys: [] });
    const result = await sweepExpiredEvidence(store, bucket, "2026-09-04T00:00:00.000Z");
    assert.equal(result.cutoffIso, "2026-06-06T00:00:00.000Z");
  });

  it("nothing expired means zero R2 deletions but the D1 erase call still runs (idempotent no-op)", async () => {
    const { store, bucket, calls } = makeFakes({ expiredEvidenceKeys: [] });
    const result = await sweepExpiredEvidence(store, bucket, "2026-09-04T00:00:00.000Z");
    assert.equal(result.evidenceObjectsDeleted, 0);
    assert.deepEqual(calls.deletedKeys, [[]]);
    assert.equal(calls.expiredEraseCalls, 1);
  });
});
