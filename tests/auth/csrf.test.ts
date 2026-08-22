import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateCsrfToken, verifyCsrfToken } from "../../src/auth/csrf.js";

const SECRET = "test-csrf-secret";

describe("CSRF double-submit token - Part 9", () => {
  it("valid: a freshly generated token verifies when cookie and header match and the session matches", async () => {
    const token = await generateCsrfToken(SECRET, "session_1");
    assert.equal(await verifyCsrfToken(SECRET, "session_1", token, token), true);
  });

  it("missing: no cookie or no header both fail", async () => {
    const token = await generateCsrfToken(SECRET, "session_1");
    assert.equal(await verifyCsrfToken(SECRET, "session_1", undefined, token), false);
    assert.equal(await verifyCsrfToken(SECRET, "session_1", token, undefined), false);
    assert.equal(await verifyCsrfToken(SECRET, "session_1", undefined, undefined), false);
  });

  it("invalid: cookie and header present but not equal to each other", async () => {
    const tokenA = await generateCsrfToken(SECRET, "session_1");
    const tokenB = await generateCsrfToken(SECRET, "session_1");
    assert.equal(await verifyCsrfToken(SECRET, "session_1", tokenA, tokenB), false);
  });

  it("invalid: a token generated for a DIFFERENT session does not verify (bound to session, not just double-submitted)", async () => {
    const token = await generateCsrfToken(SECRET, "session_attacker");
    assert.equal(await verifyCsrfToken(SECRET, "session_victim", token, token), false);
  });

  it("invalid: a token signed with a different secret does not verify", async () => {
    const token = await generateCsrfToken("other-secret", "session_1");
    assert.equal(await verifyCsrfToken(SECRET, "session_1", token, token), false);
  });

  it("invalid: a malformed token (no separator) does not verify", async () => {
    assert.equal(await verifyCsrfToken(SECRET, "session_1", "not-a-valid-token", "not-a-valid-token"), false);
  });
});
