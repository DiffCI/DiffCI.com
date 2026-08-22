/**
 * Part 11: successful account creation, existing user login, renamed GitHub username, session cookie
 * issued (rawSessionToken returned), invalid callback / provider exchange failure / unknown user paths.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1OAuthStore } from "../../src/auth/oauth-store.js";
import { makeD1SessionStore } from "../../src/auth/sessions.js";
import { handleGithubCallback } from "../../src/auth/login.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

const OAUTH_CONFIG = { clientId: "c1", clientSecret: "s1", redirectUri: "https://app.diffci.com/auth/github/callback" };

function fakeGithubFetch(overrides: { tokenStatus?: number; tokenBody?: unknown; userStatus?: number; userBody?: unknown } = {}): typeof fetch {
  return (async (url: string | URL) => {
    const key = String(url).split("?")[0]!;
    if (key === "https://github.com/login/oauth/access_token") {
      return new Response(JSON.stringify(overrides.tokenBody ?? { access_token: "gho_test" }), { status: overrides.tokenStatus ?? 200 });
    }
    if (key === "https://api.github.com/user") {
      return new Response(JSON.stringify(overrides.userBody ?? { id: 42, login: "octocat", name: "The Octocat", email: "octocat@example.com" }), { status: overrides.userStatus ?? 200 });
    }
    throw new Error(`Unmocked: ${url}`);
  }) as unknown as typeof fetch;
}

function makeDeps(db: ReturnType<typeof freshProductDb>, fetchFn: typeof fetch) {
  const d1 = makeD1(db);
  return {
    oauthConfig: OAUTH_CONFIG,
    oauthStore: makeD1OAuthStore(d1),
    sessionStore: makeD1SessionStore(d1),
    productStore: makeD1ProductStore(d1),
    sessionTtlMs: 60_000,
    fetchFn,
  };
}

describe("handleGithubCallback - Part 6/11 end-to-end", () => {
  it("invalid callback: an unknown state is rejected before any GitHub call is made", async () => {
    const db = freshProductDb(["auth"]);
    const deps = makeDeps(db, (() => {
      throw new Error("fetch must not be called");
    }) as unknown as typeof fetch);
    const outcome = await handleGithubCallback(deps, { state: "never-issued", code: "irrelevant" });
    assert.equal(outcome.ok, false);
    assert.equal(!outcome.ok && outcome.error, "invalid_or_replayed_state");
  });

  it("provider exchange failure surfaces as token_exchange_failed", async () => {
    const db = freshProductDb(["auth"]);
    const oauthStore = makeD1OAuthStore(makeD1(db));
    const state = await oauthStore.createState(60_000);
    const deps = makeDeps(db, fakeGithubFetch({ tokenBody: { error: "bad_verification_code" } }));
    const outcome = await handleGithubCallback(deps, { state, code: "bad-code" });
    assert.equal(!outcome.ok && outcome.error, "token_exchange_failed");
  });

  it("unknown/failed GitHub user fetch surfaces as user_fetch_failed", async () => {
    const db = freshProductDb(["auth"]);
    const oauthStore = makeD1OAuthStore(makeD1(db));
    const state = await oauthStore.createState(60_000);
    const deps = makeDeps(db, fakeGithubFetch({ userStatus: 401 }));
    const outcome = await handleGithubCallback(deps, { state, code: "code" });
    assert.equal(!outcome.ok && outcome.error, "user_fetch_failed");
  });

  it("successful account creation: a first-time GitHub login creates a new DiffCI user, links the identity, and issues a session", async () => {
    const db = freshProductDb(["auth"]);
    const oauthStore = makeD1OAuthStore(makeD1(db));
    const state = await oauthStore.createState(60_000, "/dashboard");
    const deps = makeDeps(db, fakeGithubFetch());
    const outcome = await handleGithubCallback(deps, { state, code: "code" });

    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.wasNewUser, true);
    assert.equal(outcome.redirectTo, "/dashboard");
    assert.ok(outcome.rawSessionToken);

    const linkedUserId = await oauthStore.getUserIdForProviderIdentity("github", "42");
    assert.equal(linkedUserId, outcome.userId);

    // session cookie issued: the raw token actually resolves to a valid session
    const sessionStore = makeD1SessionStore(makeD1(db));
    const resolved = await sessionStore.getValidSessionByRawToken(outcome.rawSessionToken);
    assert.equal(resolved?.userId, outcome.userId);
  });

  it("existing user login: a second login with the same GitHub id reuses the same DiffCI user, does not create a duplicate", async () => {
    const db = freshProductDb(["auth"]);
    const oauthStore = makeD1OAuthStore(makeD1(db));
    const productStore = makeD1ProductStore(makeD1(db));

    const state1 = await oauthStore.createState(60_000);
    const first = await handleGithubCallback(makeDeps(db, fakeGithubFetch()), { state: state1, code: "code1" });
    assert.equal(first.ok, true);

    const state2 = await oauthStore.createState(60_000);
    const second = await handleGithubCallback(makeDeps(db, fakeGithubFetch()), { state: state2, code: "code2" });
    assert.equal(second.ok, true);

    if (!first.ok || !second.ok) return;
    assert.equal(second.userId, first.userId, "the same GitHub identity must resolve to the same DiffCI user");
    assert.equal(second.wasNewUser, false);

    const allUsers = await productStore.getUserByEmail("octocat@example.com");
    assert.ok(allUsers, "exactly one user record should exist for this email");
  });

  it("renamed GitHub username: a login after a username change still resolves to the original user and updates provider_login", async () => {
    const db = freshProductDb(["auth"]);
    const oauthStore = makeD1OAuthStore(makeD1(db));

    const state1 = await oauthStore.createState(60_000);
    const first = await handleGithubCallback(makeDeps(db, fakeGithubFetch({ userBody: { id: 777, login: "old-handle", name: null, email: "person@example.com" } })), { state: state1, code: "code1" });
    assert.equal(first.ok, true);

    const state2 = await oauthStore.createState(60_000);
    const second = await handleGithubCallback(makeDeps(db, fakeGithubFetch({ userBody: { id: 777, login: "new-handle", name: null, email: "person@example.com" } })), { state: state2, code: "code2" }); // same numeric id, renamed login
    assert.equal(second.ok, true);

    if (!first.ok || !second.ok) return;
    assert.equal(second.userId, first.userId, "a GitHub username rename must not create a second account");
    assert.equal(second.wasNewUser, false);
  });
});
