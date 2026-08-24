import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { hexMatches, isSha256Hex, normalizeHex, sha256Hex } from "../../src/analysis-fanout/checksum.js";

const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const ABC_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

describe("sha256Hex", () => {
  it("matches known SHA-256 vectors", async () => {
    assert.equal(await sha256Hex(new TextEncoder().encode("")), EMPTY_SHA256);
    assert.equal(await sha256Hex(new TextEncoder().encode("abc")), ABC_SHA256);
  });

  it("accepts both Uint8Array and ArrayBuffer", async () => {
    const bytes = new TextEncoder().encode("abc");
    assert.equal(await sha256Hex(bytes), ABC_SHA256);
    assert.equal(await sha256Hex(bytes.buffer.slice(0)), ABC_SHA256);
  });
});

describe("hexMatches", () => {
  it("is case- and whitespace-insensitive", () => {
    assert.equal(hexMatches(EMPTY_SHA256, EMPTY_SHA256), true);
    assert.equal(hexMatches(EMPTY_SHA256, EMPTY_SHA256.toUpperCase()), true);
    assert.equal(hexMatches(`  ${EMPTY_SHA256}\n`, EMPTY_SHA256), true);
    assert.equal(hexMatches(EMPTY_SHA256, "f".repeat(64)), false);
  });
});

describe("isSha256Hex", () => {
  it("accepts exactly 64 hex characters", () => {
    assert.equal(isSha256Hex("a".repeat(64)), true);
    assert.equal(isSha256Hex("A".repeat(64)), true);
    assert.equal(isSha256Hex(`  ${"a".repeat(64)}  `), true);
  });

  it("rejects non-hex and wrong-length strings", () => {
    assert.equal(isSha256Hex("g".repeat(64)), false);
    assert.equal(isSha256Hex("a".repeat(63)), false);
    assert.equal(isSha256Hex("a".repeat(65)), false);
    assert.equal(isSha256Hex(""), false);
    assert.equal(isSha256Hex("zzzz"), false);
  });
});

describe("normalizeHex", () => {
  it("trims and lowercases", () => {
    assert.equal(normalizeHex("  ABCD  "), "abcd");
  });
});