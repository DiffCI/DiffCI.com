import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getAllowedRepository, isValidFullCommitSha, verifyCommitBelongsToAllowedRepository, R2_REPOSITORY_ALLOWLIST } from "../../src/runner/repository-policy.js";

const R2_REPO = "deepseek-ai/deepseek-harness";
const RUN_LIVE_GITHUB_TESTS = process.env.DIFFCI_RUN_LIVE_GITHUB_TESTS === "1";

describe("R2 repository allowlist - Part 12", () => {
  it("deepseek-ai/deepseek-harness is the only allowed repository", () => {
    assert.equal(R2_REPOSITORY_ALLOWLIST.length, 1);
    assert.equal(R2_REPOSITORY_ALLOWLIST[0]!.ownerName, R2_REPO);
  });

  it("getAllowedRepository returns undefined for anything not on the allowlist - no substitution possible", () => {
    assert.equal(getAllowedRepository("attacker/repository"), undefined);
    assert.equal(getAllowedRepository("adityankale190895/DiffCI.com"), undefined, "DiffCI.com is private - deliberately not on the R2 allowlist");
  });

  it("the allowed clone URL is public and credential-free", () => {
    const url = getAllowedRepository(R2_REPO)!.cloneUrl;
    assert.equal(url, "https://github.com/deepseek-ai/deepseek-harness.git");
    assert.ok(!url.includes("@"), "no embedded credentials in the clone URL");
  });
});

describe("isValidFullCommitSha - Part 10 exact-SHA requirement", () => {
  it("accepts a real, full 40-hex-char SHA", () => {
    assert.equal(isValidFullCommitSha("843aa1eaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"), true);
  });
  it("rejects an abbreviated SHA", () => {
    assert.equal(isValidFullCommitSha("843aa1e"), false);
  });
  it("rejects a branch/ref name", () => {
    assert.equal(isValidFullCommitSha("main"), false);
    assert.equal(isValidFullCommitSha("HEAD"), false);
  });
  it("rejects uppercase hex (git SHAs are lowercase)", () => {
    assert.equal(isValidFullCommitSha("843AA1EAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), false);
  });
});

describe("verifyCommitBelongsToAllowedRepository - Part 13", () => {
  it("rejects a repository not on the allowlist without ever making a network call", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await verifyCommitBelongsToAllowedRepository("attacker/repository", "a".repeat(40), fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "repository_not_allowed");
    assert.equal(called, false, "must reject server-side before ever calling out - the allowlist check comes first");
  });

  it("rejects DiffCI.com specifically - real repo, but not on the R2 allowlist (it's private anyway)", async () => {
    const result = await verifyCommitBelongsToAllowedRepository("adityankale190895/DiffCI.com", "a".repeat(40));
    assert.equal(result.ok, false);
    assert.equal(result.reason, "repository_not_allowed");
  });

  it("rejects a malformed SHA without making a network call", async () => {
    let called = false;
    const fakeFetch = (async () => {
      called = true;
      return new Response("{}", { status: 200 });
    }) as typeof fetch;
    const result = await verifyCommitBelongsToAllowedRepository(R2_REPO, "not-a-real-sha", fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "invalid_sha_format");
    assert.equal(called, false);
  });

  it("rejects when GitHub returns 404 (commit does not exist in this repo)", async () => {
    const fakeFetch = (async () => new Response("{}", { status: 404 })) as typeof fetch;
    const result = await verifyCommitBelongsToAllowedRepository(R2_REPO, "a".repeat(40), fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "commit_not_found");
  });

  it("rejects when GitHub's returned sha doesn't exactly match the requested sha (short-SHA resolution mismatch guard)", async () => {
    const fakeFetch = (async () => new Response(JSON.stringify({ sha: "b".repeat(40) }), { status: 200 })) as typeof fetch;
    const result = await verifyCommitBelongsToAllowedRepository(R2_REPO, "a".repeat(40), fakeFetch);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "sha_mismatch");
  });

  it("accepts when GitHub confirms the exact sha", async () => {
    const sha = "a".repeat(40);
    const fakeFetch = (async () => new Response(JSON.stringify({ sha }), { status: 200 })) as typeof fetch;
    const result = await verifyCommitBelongsToAllowedRepository(R2_REPO, sha, fakeFetch);
    assert.equal(result.ok, true);
  });

  it("REAL live proof: a real, known commit SHA of deepseek-ai/deepseek-harness verifies successfully against the real GitHub API", { skip: !RUN_LIVE_GITHUB_TESTS }, async () => {
    // No mock - genuinely calls api.github.com. This SHA was fetched live via `gh api
    // repos/deepseek-ai/deepseek-harness/commits/HEAD` at the time R2's repository allowlist was set
    // (2026-08-22) - a real, permanent commit in a real repository's history, not a moving target.
    const realKnownSha = "b150a551b8d465e31e418e1b2eaf5e79bbb7d28e";
    const result = await verifyCommitBelongsToAllowedRepository(R2_REPO, realKnownSha);
    assert.equal(result.ok, true, `expected the real, known commit ${realKnownSha} to verify against the real GitHub API`);
  });

  it("REAL live proof: a SHA that has never existed in this repository is genuinely rejected by the real GitHub API", { skip: !RUN_LIVE_GITHUB_TESTS }, async () => {
    const fakeSha = "0".repeat(40);
    const result = await verifyCommitBelongsToAllowedRepository(R2_REPO, fakeSha);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "commit_not_found");
  });
});

