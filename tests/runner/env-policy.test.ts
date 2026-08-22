import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSanitizedWorkloadEnv, checkForEnvLeak, isForbiddenEnvKey, SAFE_ENV_ALLOWLIST } from "../../src/runner/env-policy.js";

describe("buildSanitizedWorkloadEnv - Part 8", () => {
  it("only copies allowlisted keys from the source env, dropping everything else", () => {
    const source = { PATH: "/usr/bin", HOME: "/root", DIFFCI_RUNNER_TOKEN: "super-secret", RUNNER_CONTROL_TOKEN: "also-secret", RANDOM_JUNK: "x" };
    const env = buildSanitizedWorkloadEnv({ sourceEnv: source });
    assert.equal(env.PATH, "/usr/bin");
    assert.equal(env.HOME, "/root");
    assert.equal(env.DIFFCI_RUNNER_TOKEN, undefined);
    assert.equal(env.RUNNER_CONTROL_TOKEN, undefined);
    assert.equal(env.RANDOM_JUNK, undefined);
  });

  it("real R1/R2 credential names are never copied through, by construction (not by a blocklist)", () => {
    const source: Record<string, string> = {
      DIFFCI_RUNNER_TOKEN: "x",
      RUNNER_CONTROL_TOKEN: "x",
      CLOUDFLARE_API_TOKEN: "x",
      LEMONSQUEEZY_API_KEY: "x",
      GITHUB_OAUTH_CLIENT_SECRET: "x",
      CSRF_SECRET: "x",
      PRODUCT_DB: "x",
    };
    const env = buildSanitizedWorkloadEnv({ sourceEnv: source });
    for (const key of Object.keys(source)) assert.equal(env[key], undefined, `${key} must never appear in the workload env`);
  });

  it("always sets CI=true", () => {
    assert.equal(buildSanitizedWorkloadEnv({ sourceEnv: {} }).CI, "true");
  });

  it("includes safe extra metadata when explicitly passed", () => {
    const env = buildSanitizedWorkloadEnv({ sourceEnv: {}, extra: { DIFFCI_JOB_ID: "abc-123" } });
    assert.equal(env.DIFFCI_JOB_ID, "abc-123");
  });

  it("throws if extra metadata has a forbidden-shaped key, rather than silently including or dropping it", () => {
    assert.throws(() => buildSanitizedWorkloadEnv({ sourceEnv: {}, extra: { SOME_TOKEN: "x" } }), /forbidden/);
  });

  it("the allowlist itself contains no credential-shaped keys", () => {
    for (const key of SAFE_ENV_ALLOWLIST) assert.equal(isForbiddenEnvKey(key), false, key);
  });
});

describe("isForbiddenEnvKey", () => {
  it("flags common credential-shaped key patterns", () => {
    for (const key of ["RUNNER_CONTROL_TOKEN", "API_KEY", "MY_SECRET", "DB_PASSWORD", "GITHUB_CREDENTIAL", "PRIVATE_KEY_PEM", "AUTH_HEADER"]) {
      assert.equal(isForbiddenEnvKey(key), true, key);
    }
  });
  it("does not flag ordinary safe keys", () => {
    for (const key of ["PATH", "HOME", "CI", "NODE_ENV", "LANG"]) assert.equal(isForbiddenEnvKey(key), false, key);
  });
});

describe("checkForEnvLeak - Part 9", () => {
  it("passes when no observed value matches a known secret and no forbidden key is present", () => {
    const result = checkForEnvLeak({ PATH: "/usr/bin", CI: "true" }, ["real-secret-value"]);
    assert.equal(result.pass, true);
    assert.deepEqual(result.leakedKeys, []);
  });

  it("fails and reports the KEY (never the value) when a secret value leaked", () => {
    const result = checkForEnvLeak({ PATH: "/usr/bin", SOME_VAR: "real-secret-value" }, ["real-secret-value"]);
    assert.equal(result.pass, false);
    assert.deepEqual(result.leakedKeys, ["SOME_VAR"]);
  });

  it("fails when a forbidden-shaped key is present even if its value doesn't match a known secret", () => {
    const result = checkForEnvLeak({ RUNNER_CONTROL_TOKEN: "some-other-value-not-in-the-known-list" }, ["real-secret-value"]);
    assert.equal(result.pass, false);
    assert.deepEqual(result.forbiddenKeysPresent, ["RUNNER_CONTROL_TOKEN"]);
  });

  it("real regression scenario: the exact token minted for a job must never appear in the workload's observed env", () => {
    const mintedToken = "cbJV6_eZqsW-4_rLuXola118ofxCtpD5YRUjtShs96E";
    const workloadEnv = buildSanitizedWorkloadEnv({ sourceEnv: { DIFFCI_RUNNER_TOKEN: mintedToken, PATH: "/usr/bin" } });
    const result = checkForEnvLeak(workloadEnv, [mintedToken]);
    assert.equal(result.pass, true);
    assert.equal(workloadEnv.PATH, "/usr/bin");
  });
});
