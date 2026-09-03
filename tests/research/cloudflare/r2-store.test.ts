import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { R2EvidenceStore, type R2Binding } from "../../../src/research/cloudflare/r2-store.js";

function fakeBucket(overrides: Partial<R2Binding> = {}): { bucket: R2Binding; deleteCalls: string[][] } {
  const deleteCalls: string[][] = [];
  const bucket: R2Binding = {
    async get() {
      return null;
    },
    async put() {},
    async list() {
      return { objects: [] };
    },
    async delete(keys) {
      deleteCalls.push(keys);
    },
    ...overrides,
  };
  return { bucket, deleteCalls };
}

describe("R2EvidenceStore.deleteMany", () => {
  it("no-ops and returns 0 for an empty key list, without calling the binding at all", async () => {
    const { bucket, deleteCalls } = fakeBucket();
    const store = new R2EvidenceStore(bucket);
    const n = await store.deleteMany([]);
    assert.equal(n, 0);
    assert.deepEqual(deleteCalls, []);
  });

  it("deletes every key in one call when under the chunk size", async () => {
    const { bucket, deleteCalls } = fakeBucket();
    const store = new R2EvidenceStore(bucket);
    const n = await store.deleteMany(["a", "b", "c"]);
    assert.equal(n, 3);
    assert.deepEqual(deleteCalls, [["a", "b", "c"]]);
  });

  it("chunks a large key list at 500 per call", async () => {
    const { bucket, deleteCalls } = fakeBucket();
    const store = new R2EvidenceStore(bucket);
    const keys = Array.from({ length: 1200 }, (_, i) => `k${i}`);
    const n = await store.deleteMany(keys);
    assert.equal(n, 1200);
    assert.equal(deleteCalls.length, 3, "1200 keys at 500/chunk is 3 calls");
    assert.equal(deleteCalls[0]!.length, 500);
    assert.equal(deleteCalls[1]!.length, 500);
    assert.equal(deleteCalls[2]!.length, 200);
  });

  it("throws rather than silently succeeding when the binding has no delete() at all", async () => {
    const bucket: R2Binding = {
      async get() {
        return null;
      },
      async put() {},
      async list() {
        return { objects: [] };
      },
      // delete deliberately omitted
    };
    const store = new R2EvidenceStore(bucket);
    await assert.rejects(() => store.deleteMany(["a"]), /R2Binding\.delete is not implemented/);
  });
});
