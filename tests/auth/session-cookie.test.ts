import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildCsrfCookie, buildExpiredSessionCookie, buildSessionCookie } from "../../src/auth/session-cookie.js";

describe("buildSessionCookie - Part 8 (required production cookie properties)", () => {
  it("includes HttpOnly, Secure, SameSite, and a Max-Age derived from expiresAt", () => {
    const expiresAt = new Date(Date.now() + 3600_000).toISOString();
    const cookie = buildSessionCookie("raw-token-value", expiresAt);
    assert.match(cookie, /^diffci_session=raw-token-value;/);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\//);
    assert.match(cookie, /Max-Age=\d+/);
  });

  it("Max-Age is clamped to 0, never negative, for an already-expired session", () => {
    const cookie = buildSessionCookie("token", new Date(Date.now() - 1000).toISOString());
    assert.match(cookie, /Max-Age=0/);
  });
});

describe("buildExpiredSessionCookie - Part 8 logout", () => {
  it("clears the cookie with Max-Age=0 and an empty value", () => {
    const cookie = buildExpiredSessionCookie();
    assert.match(cookie, /^diffci_session=;/);
    assert.match(cookie, /Max-Age=0/);
    assert.match(cookie, /HttpOnly/);
  });
});

describe("buildCsrfCookie", () => {
  it("is Secure/SameSite but NOT HttpOnly (client JS must read it)", () => {
    const cookie = buildCsrfCookie("csrf-token-value");
    assert.match(cookie, /^diffci_csrf=csrf-token-value;/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.doesNotMatch(cookie, /HttpOnly/);
  });
});
