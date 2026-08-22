import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildGithubAuthorizeUrl, exchangeCodeForToken, fetchGithubIdentity, GithubOAuthError } from "../../src/auth/oauth.js";

const CONFIG = { clientId: "client_1", clientSecret: "secret_1", redirectUri: "https://app.diffci.com/auth/github/callback" };

function fakeFetch(responses: Record<string, { status: number; body: unknown }>): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url).split("?")[0]!;
    const match = responses[key];
    if (!match) throw new Error(`Unmocked request: ${url}`);
    return new Response(JSON.stringify(match.body), { status: match.status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
}

describe("buildGithubAuthorizeUrl - Part 6", () => {
  it("includes client_id, redirect_uri, state, and a minimal read-only scope", () => {
    const url = new URL(buildGithubAuthorizeUrl(CONFIG, "state-123"));
    assert.equal(url.searchParams.get("client_id"), "client_1");
    assert.equal(url.searchParams.get("redirect_uri"), CONFIG.redirectUri);
    assert.equal(url.searchParams.get("state"), "state-123");
    assert.equal(url.searchParams.get("scope"), "read:user user:email");
  });
});

describe("exchangeCodeForToken - Part 6/11", () => {
  it("returns the access token on success", async () => {
    const fetchMock = fakeFetch({ "https://github.com/login/oauth/access_token": { status: 200, body: { access_token: "gho_real_token", token_type: "bearer", scope: "read:user" } } });
    const token = await exchangeCodeForToken(CONFIG, "auth-code", fetchMock);
    assert.equal(token, "gho_real_token");
  });

  it("throws GithubOAuthError('token_exchange') when GitHub reports an error in the body", async () => {
    const fetchMock = fakeFetch({ "https://github.com/login/oauth/access_token": { status: 200, body: { error: "bad_verification_code", error_description: "The code passed is incorrect or expired." } } });
    await assert.rejects(() => exchangeCodeForToken(CONFIG, "bad-code", fetchMock), (err: unknown) => {
      assert.ok(err instanceof GithubOAuthError);
      assert.equal(err.stage, "token_exchange");
      return true;
    });
  });

  it("throws when GitHub responds with a non-2xx status (provider exchange failure)", async () => {
    const fetchMock = fakeFetch({ "https://github.com/login/oauth/access_token": { status: 503, body: {} } });
    await assert.rejects(() => exchangeCodeForToken(CONFIG, "code", fetchMock), GithubOAuthError);
  });
});

describe("fetchGithubIdentity - Part 7 (immutable numeric id, never username)", () => {
  it("resolves providerUserId as GitHub's numeric id (stringified) and providerLogin as the username", async () => {
    const fetchMock = fakeFetch({ "https://api.github.com/user": { status: 200, body: { id: 12345, login: "octocat", name: "The Octocat", email: "octocat@example.com" } } });
    const identity = await fetchGithubIdentity("token", fetchMock);
    assert.equal(identity.providerUserId, "12345");
    assert.equal(identity.providerLogin, "octocat");
    assert.equal(identity.email, "octocat@example.com");
  });

  it("falls back to /user/emails when /user's email is null", async () => {
    const fetchMock = fakeFetch({
      "https://api.github.com/user": { status: 200, body: { id: 1, login: "a", name: null, email: null } },
      "https://api.github.com/user/emails": { status: 200, body: [{ email: "not-primary@example.com", primary: false, verified: true }, { email: "primary@example.com", primary: true, verified: true }] },
    });
    const identity = await fetchGithubIdentity("token", fetchMock);
    assert.equal(identity.email, "primary@example.com");
  });

  it("falls back to a synthesized noreply address when no email is available anywhere", async () => {
    const fetchMock = fakeFetch({
      "https://api.github.com/user": { status: 200, body: { id: 999, login: "private-user", name: null, email: null } },
      "https://api.github.com/user/emails": { status: 200, body: [] },
    });
    const identity = await fetchGithubIdentity("token", fetchMock);
    assert.equal(identity.email, "999+private-user@users.noreply.github.com");
  });

  it("throws GithubOAuthError('user_fetch') on a non-2xx /user response (unknown/failed lookup)", async () => {
    const fetchMock = fakeFetch({ "https://api.github.com/user": { status: 401, body: {} } });
    await assert.rejects(() => fetchGithubIdentity("bad-token", fetchMock), (err: unknown) => {
      assert.ok(err instanceof GithubOAuthError);
      assert.equal(err.stage, "user_fetch");
      return true;
    });
  });
});
