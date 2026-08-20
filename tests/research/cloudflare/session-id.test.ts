import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSandboxSessionId, shortHash } from "../../../src/research/cloudflare/session-id.js";

// Real finding, 2026-08-20 larger-study run: spring-projects/spring-petclinic failed outright with
// "Sandbox ID must be 1-63 characters long" - the naive session-id construction overflowed 63 chars
// for that owner/name combination. See diffci/docs/research/2026-08-20-stage0-small-batch-report.md.

describe("shortHash", () => {
  it("is deterministic - the same input always hashes to the same output", async () => {
    const a = await shortHash("pmndrs/zustand");
    const b = await shortHash("pmndrs/zustand");
    assert.equal(a, b);
  });

  it("differs for different inputs", async () => {
    const a = await shortHash("pmndrs/zustand");
    const b = await shortHash("pmndrs/jotai");
    assert.notEqual(a, b);
  });

  it("returns a fixed-length hex string regardless of input length", async () => {
    const short = await shortHash("a");
    const long = await shortHash("spring-projects/spring-petclinic-with-an-even-longer-suffix-than-the-real-one");
    assert.equal(short.length, 12);
    assert.equal(long.length, 12);
    assert.match(short, /^[0-9a-f]{12}$/);
  });
});

describe("buildSandboxSessionId", () => {
  it("stays well under the 63-character Sandbox ID limit for the exact repo that failed live", async () => {
    // The real failing case: owner "spring-projects", name "spring-petclinic".
    const id = await buildSandboxSessionId("spring-projects", "spring-petclinic", 1, 1787203000000);
    assert.ok(id.length <= 63, `expected <= 63 chars, got ${id.length}: "${id}"`);
  });

  it("stays under the limit even for an artificially very long owner/name pair", async () => {
    const owner = "a".repeat(100);
    const name = "b".repeat(100);
    const id = await buildSandboxSessionId(owner, name, 3, 1787203000000);
    assert.ok(id.length <= 63, `expected <= 63 chars, got ${id.length}: "${id}"`);
  });

  it("is deterministic per (owner, name) - same repo hashes to the same prefix across attempts", async () => {
    const first = await buildSandboxSessionId("pmndrs", "zustand", 1, 1000);
    const second = await buildSandboxSessionId("pmndrs", "zustand", 2, 2000);
    const firstPrefix = first.split("-a")[0];
    const secondPrefix = second.split("-a")[0];
    assert.equal(firstPrefix, secondPrefix);
  });

  it("is unique per attempt and per timestamp, even for the same repository", async () => {
    const a = await buildSandboxSessionId("pmndrs", "zustand", 1, 1000);
    const b = await buildSandboxSessionId("pmndrs", "zustand", 2, 1000);
    const c = await buildSandboxSessionId("pmndrs", "zustand", 1, 2000);
    assert.notEqual(a, b);
    assert.notEqual(a, c);
  });
});
