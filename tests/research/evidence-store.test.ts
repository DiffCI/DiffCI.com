import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { LocalEvidenceStore } from "../../src/research/store/evidence.js";

describe("LocalEvidenceStore", () => {
  let dir: string;
  let store: LocalEvidenceStore;

  beforeEach(() => {
    dir = mkdtempSync(resolve(tmpdir(), "evidence-store-test-"));
    store = new LocalEvidenceStore(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips put/get/exists for a simple key", async () => {
    await store.put("manifest.json", { a: 1 });
    assert.equal(await store.exists("manifest.json"), true);
    assert.deepEqual(await store.get("manifest.json"), { a: 1 });
    assert.equal(await store.exists("nope.json"), false);
    assert.equal(await store.get("nope.json"), undefined);
  });

  it("preserves nested directory structure so list(prefix) can enumerate it", async () => {
    await store.put("commits/a.json", { n: 1 });
    await store.put("commits/b.json", { n: 2 });
    await store.put("reports/summary.json", { n: 3 });

    const commitKeys = await store.list("commits");
    assert.equal(commitKeys.length, 2);
    assert.ok(commitKeys.includes("commits/a"));
    assert.ok(commitKeys.includes("commits/b"));

    const reportKeys = await store.list("reports");
    assert.deepEqual(reportKeys, ["reports/summary"]);
  });

  it("recursively lists keys nested more than one level deep (e.g. owner/repo-shaped keys)", async () => {
    // logicalDeltaKey embeds "owner/name" directly, so a real commit key looks like this.
    const key = "commits/pmndrs/zustand:abc123:def456:0.6.0:schema-2";
    await store.put(`${key}.json`, { record: true });

    const keys = await store.list("commits");
    assert.equal(keys.length, 1);
    // ":" is sanitized within each segment, but the "/" nesting is preserved.
    assert.ok(keys[0]!.startsWith("commits/pmndrs/zustand_abc123_def456"));
  });

  it("returns an empty list for a prefix with no entries", async () => {
    assert.deepEqual(await store.list("nothing-here"), []);
  });

  it("sanitizes filesystem-unsafe characters within a segment without colliding across different keys", async () => {
    await store.put("commits/repo:sha1:sha2.json", { which: "one" });
    await store.put("commits/repo:sha1:sha3.json", { which: "two" });
    assert.deepEqual(await store.get("commits/repo:sha1:sha2.json"), { which: "one" });
    assert.deepEqual(await store.get("commits/repo:sha1:sha3.json"), { which: "two" });
  });
});
