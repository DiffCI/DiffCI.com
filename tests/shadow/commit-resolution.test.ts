import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { resolveCommitRange } from "../../src/shadow/commit-resolution.js";
import { EMPTY_TREE_SHA, ZERO_SHA } from "../../src/git/git-diff.js";

describe("resolveCommitRange", () => {
  it("prefers push event before -> sha", () => {
    const resolved = resolveCommitRange({
      eventName: "push",
      githubBefore: "base123",
      githubSha: "head456",
    });
    assert.strictEqual(resolved.type, "event");
    assert.strictEqual(resolved.baseSha, "base123");
    assert.strictEqual(resolved.headSha, "head456");
  });

  it("prefers PR base -> sha", () => {
    const resolved = resolveCommitRange({
      eventName: "pull_request",
      githubBaseSha: "prbase123",
      prBaseSha: "prbase456",
      githubSha: "head789",
    });
    assert.strictEqual(resolved.type, "event");
    assert.strictEqual(resolved.baseSha, "prbase456");
    assert.strictEqual(resolved.headSha, "head789");
  });

  it("falls back to empty tree on zero SHA push (branch creation / force-push)", () => {
    const resolved = resolveCommitRange({
      eventName: "push",
      githubBefore: ZERO_SHA,
      githubSha: "head000",
    });
    assert.strictEqual(resolved.type, "empty");
    assert.strictEqual(resolved.baseSha, EMPTY_TREE_SHA);
    assert.strictEqual(resolved.headSha, "head000");
    assert.ok(resolved.reason.includes("all-zero"));
  });

  it("returns missing when running in CI without event base", () => {
    const resolved = resolveCommitRange({
      eventName: "push",
      githubSha: "head000",
    });
    assert.strictEqual(resolved.type, "missing");
    assert.strictEqual(resolved.baseSha, undefined);
  });

  it("allows CLI base to override events", () => {
    const resolved = resolveCommitRange({
      baseArg: "clibase",
      eventName: "push",
      githubBefore: "eventbase",
      githubSha: "head",
    });
    assert.strictEqual(resolved.type, "cli");
    assert.strictEqual(resolved.baseSha, "clibase");
  });
});
