import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSourceIntegrity, isValidSha, sourceIsUsable, type SourceArchiveMeta } from "../../../src/research/cloudflare/shadow-source-integrity.js";

const SHA_A = "aaaa111111111111111111111111111111111111"; // 40 hex chars
const SHA_B = "bbbb222222222222222222222222222222222222"; // 40 hex chars, deliberately different

function meta(overrides: Partial<SourceArchiveMeta> = {}): SourceArchiveMeta {
  return {
    sourceSha: SHA_A,
    archiveHash: "deadbeef",
    archiveKey: `shadow/source/by-sha/${SHA_A}.tgz`,
    uploadedAt: "2026-08-21T12:00:00.000Z",
    sizeBytes: 1234,
    ...overrides,
  };
}

describe("isValidSha", () => {
  it("accepts a full lowercase 40-hex SHA", () => {
    assert.equal(isValidSha(SHA_A), true);
  });
  it("rejects a short SHA (the git-rev-parse --short default that predated this fix)", () => {
    assert.equal(isValidSha("e58fdfb"), false);
  });
  it("rejects uppercase hex", () => {
    assert.equal(isValidSha(SHA_A.toUpperCase()), false);
  });
  it("rejects non-hex, empty, undefined, and null", () => {
    assert.equal(isValidSha("not-a-sha-at-all"), false);
    assert.equal(isValidSha(""), false);
    assert.equal(isValidSha(undefined), false);
    assert.equal(isValidSha(null as unknown as undefined), false);
  });
});

describe("computeSourceIntegrity", () => {
  it("CURRENT: expected and archive SHAs match, archive bytes exist - the only status a poll may proceed under", () => {
    const result = computeSourceIntegrity(SHA_A, meta({ sourceSha: SHA_A }), true);
    assert.equal(result.status, "CURRENT");
    assert.equal(result.expectedSha, SHA_A);
    assert.equal(result.archiveSha, SHA_A);
    assert.equal(sourceIsUsable(result), true);
  });

  it("STALE: expected and archive SHAs are both valid but differ - this is the exact bug this fix closes", () => {
    // Reproduces the real incident: main at SHA_B, R2 archive still stamped SHA_A (e58fdfb-shaped).
    const result = computeSourceIntegrity(SHA_B, meta({ sourceSha: SHA_A }), true);
    assert.equal(result.status, "STALE");
    assert.equal(result.expectedSha, SHA_B);
    assert.equal(result.archiveSha, SHA_A);
    assert.equal(sourceIsUsable(result), false);
    assert.match(result.detail, /expects source/);
  });

  it("MISSING: no archive metadata has ever been uploaded", () => {
    const result = computeSourceIntegrity(SHA_A, undefined, false);
    assert.equal(result.status, "MISSING");
    assert.equal(result.expectedSha, SHA_A);
    assert.equal(result.archiveSha, undefined);
  });

  it("MISSING: metadata exists but its sourceSha is malformed - never trust a partially-written pointer", () => {
    const result = computeSourceIntegrity(SHA_A, meta({ sourceSha: "not-a-real-sha" }), true);
    assert.equal(result.status, "MISSING");
    assert.equal(result.archiveSha, undefined, "a malformed sourceSha must not be surfaced as if it were valid");
  });

  it("MISSING: metadata is well-formed and names a matching expected SHA, but the archive bytes are gone", () => {
    const result = computeSourceIntegrity(SHA_A, meta({ sourceSha: SHA_A }), false);
    assert.equal(result.status, "MISSING");
    assert.match(result.detail, /no archive object exists/);
  });

  it("UNKNOWN: the deployed Worker has no EXPECTED_SOURCE_SHA at all (never deployed via the canonical script)", () => {
    const result = computeSourceIntegrity(undefined, meta({ sourceSha: SHA_A }), true);
    assert.equal(result.status, "UNKNOWN");
    assert.equal(result.expectedSha, undefined);
    assert.equal(sourceIsUsable(result), false);
  });

  it("UNKNOWN: EXPECTED_SOURCE_SHA is set but malformed (e.g. someone hand-edited a short SHA in)", () => {
    const result = computeSourceIntegrity("e58fdfb", meta({ sourceSha: SHA_A }), true);
    assert.equal(result.status, "UNKNOWN");
  });

  it("never returns CURRENT unless every one of expected/archive/bytes-exist independently checks out", () => {
    // A deliberately exhaustive sweep of "almost right" combinations - none of these may be CURRENT.
    const almostRight = [
      computeSourceIntegrity(SHA_A, meta({ sourceSha: SHA_B }), true), // wrong archive
      computeSourceIntegrity(SHA_B, meta({ sourceSha: SHA_A }), true), // wrong expectation
      computeSourceIntegrity(SHA_A, meta({ sourceSha: SHA_A }), false), // bytes missing
      computeSourceIntegrity(undefined, meta({ sourceSha: SHA_A }), true), // no expectation configured
      computeSourceIntegrity(SHA_A, undefined, true), // no metadata despite bytes somehow existing
    ];
    for (const result of almostRight) {
      assert.notEqual(result.status, "CURRENT");
      assert.equal(sourceIsUsable(result), false);
    }
  });
});

describe("sourceIsUsable", () => {
  it("is true only for CURRENT, false for every other status value", () => {
    for (const status of ["STALE", "MISSING", "UNKNOWN"] as const) {
      assert.equal(sourceIsUsable({ status, detail: "x" }), false);
    }
    assert.equal(sourceIsUsable({ status: "CURRENT", detail: "x" }), true);
  });
});
