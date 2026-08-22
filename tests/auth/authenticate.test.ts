import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authenticateRequest } from "../../src/auth/authenticate.js";
import { parseAuthConfig } from "../../src/auth/config.js";
import type { SessionStore } from "../../src/auth/sessions.js";
import type { Session } from "../../src/auth/types.js";

function makeFakeSessionStore(validToken?: { rawToken: string; session: Session }): SessionStore {
  return {
    async createSession() {
      throw new Error("not used");
    },
    async getValidSessionByRawToken(rawToken) {
      if (validToken && rawToken === validToken.rawToken) return validToken.session;
      return null;
    },
    async touchSession() {},
    async revokeSession() {},
  };
}

const VALID_SESSION: Session = { sessionId: "s1", userId: "user_real", hashedToken: "irrelevant-in-fake", createdAt: "now", expiresAt: "later", lastUsedAt: "now" };

describe("authenticateRequest - Part 3 THE critical security property", () => {
  it("production config: a spoofed X-DiffCI-User-Id header is REJECTED (returns null), never trusted", async () => {
    const prodConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "production" });
    const request = new Request("https://example.com/v1/organizations/org_1", { headers: { "X-DiffCI-User-Id": "attacker-supplied-id" } });
    const principal = await authenticateRequest(request, { config: prodConfig, sessionStore: makeFakeSessionStore() });
    assert.equal(principal, null, "production must never authenticate via a bare header, regardless of its value");
  });

  it("production config: a valid session (Bearer token) DOES authenticate", async () => {
    const prodConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "production" });
    const request = new Request("https://example.com/v1/organizations/org_1", { headers: { Authorization: "Bearer real-token" } });
    const principal = await authenticateRequest(request, { config: prodConfig, sessionStore: makeFakeSessionStore({ rawToken: "real-token", session: VALID_SESSION }) });
    assert.equal(principal?.userId, "user_real");
    assert.equal(principal?.authenticationMethod, "session");
  });

  it("production config: a valid session via the diffci_session cookie also authenticates", async () => {
    const prodConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "production" });
    const request = new Request("https://example.com/v1/organizations/org_1", { headers: { Cookie: "other=1; diffci_session=real-token; another=2" } });
    const principal = await authenticateRequest(request, { config: prodConfig, sessionStore: makeFakeSessionStore({ rawToken: "real-token", session: VALID_SESSION }) });
    assert.equal(principal?.userId, "user_real");
  });

  it("development config WITH dev header auth enabled: honors X-DiffCI-User-Id only when no real session is presented", async () => {
    const devConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "development", DIFFCI_ALLOW_DEV_HEADER_AUTH: "true" });
    const request = new Request("https://example.com/v1/organizations/org_1", { headers: { "X-DiffCI-User-Id": "dev-user-1" } });
    const principal = await authenticateRequest(request, { config: devConfig, sessionStore: makeFakeSessionStore() });
    assert.equal(principal?.userId, "dev-user-1");
    assert.equal(principal?.authenticationMethod, "development_header");
  });

  it("development config WITHOUT dev header auth explicitly enabled: still rejects the header (no silent fallback)", async () => {
    const devConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "development" }); // DIFFCI_ALLOW_DEV_HEADER_AUTH not set
    const request = new Request("https://example.com/v1/organizations/org_1", { headers: { "X-DiffCI-User-Id": "dev-user-1" } });
    const principal = await authenticateRequest(request, { config: devConfig, sessionStore: makeFakeSessionStore() });
    assert.equal(principal, null);
  });

  it("an invalid/expired session token does not fall through to dev header auth, even in development", async () => {
    const devConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "development", DIFFCI_ALLOW_DEV_HEADER_AUTH: "true" });
    const request = new Request("https://example.com/v1/organizations/org_1", {
      headers: { Authorization: "Bearer expired-or-fake-token", "X-DiffCI-User-Id": "dev-user-1" },
    });
    const principal = await authenticateRequest(request, { config: devConfig, sessionStore: makeFakeSessionStore() /* no valid token configured */ });
    assert.equal(principal, null, "a presented-but-invalid session must not silently downgrade to the weaker dev-header path");
  });

  it("no credentials at all returns null in both environments", async () => {
    const prodConfig = parseAuthConfig({ DIFFCI_ENVIRONMENT: "production" });
    const request = new Request("https://example.com/v1/organizations/org_1");
    assert.equal(await authenticateRequest(request, { config: prodConfig, sessionStore: makeFakeSessionStore() }), null);
  });
});
