import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { AuthConfigError, parseAuthConfig } from "../../src/auth/config.js";

describe("parseAuthConfig - Part 3 (dev header auth must be impossible in production)", () => {
  it("throws when DIFFCI_ENVIRONMENT is unset", () => {
    assert.throws(() => parseAuthConfig({}), AuthConfigError);
  });

  it("throws when DIFFCI_ENVIRONMENT is an unrecognized value", () => {
    assert.throws(() => parseAuthConfig({ DIFFCI_ENVIRONMENT: "staging" }), AuthConfigError);
  });

  it("THE critical case: throws when dev header auth is requested together with production", () => {
    assert.throws(
      () => parseAuthConfig({ DIFFCI_ENVIRONMENT: "production", DIFFCI_ALLOW_DEV_HEADER_AUTH: "true" }),
      (err: unknown) => {
        assert.ok(err instanceof AuthConfigError);
        assert.match(err.message, /never permitted/);
        return true;
      },
    );
  });

  it("production with dev header auth NOT requested is fine and has allowDevHeaderAuth=false", () => {
    const cfg = parseAuthConfig({ DIFFCI_ENVIRONMENT: "production" });
    assert.equal(cfg.allowDevHeaderAuth, false);
  });

  it("development with dev header auth requested is allowed", () => {
    const cfg = parseAuthConfig({ DIFFCI_ENVIRONMENT: "development", DIFFCI_ALLOW_DEV_HEADER_AUTH: "true" });
    assert.equal(cfg.allowDevHeaderAuth, true);
  });

  it("development WITHOUT explicitly requesting dev header auth defaults to false (no silent fallback)", () => {
    const cfg = parseAuthConfig({ DIFFCI_ENVIRONMENT: "development" });
    assert.equal(cfg.allowDevHeaderAuth, false);
  });

  it("rejects a non-positive session TTL", () => {
    assert.throws(() => parseAuthConfig({ DIFFCI_ENVIRONMENT: "production", DIFFCI_SESSION_TTL_MS: "-1" }), AuthConfigError);
    assert.throws(() => parseAuthConfig({ DIFFCI_ENVIRONMENT: "production", DIFFCI_SESSION_TTL_MS: "not-a-number" }), AuthConfigError);
  });
});
