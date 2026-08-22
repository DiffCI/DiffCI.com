import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { makeD1ProductStore } from "../../src/product/store.js";
import { makeD1OAuthStore } from "../../src/auth/oauth-store.js";
import { freshProductDb, makeD1 } from "../helpers/product-db.js";

describe("OAuthStore.consumeState - Part 6/11 (mismatch / replay / expired)", () => {
  it("consumes a valid, unexpired state exactly once", async () => {
    const db = freshProductDb(["auth"]);
    const store = makeD1OAuthStore(makeD1(db));
    const state = await store.createState(60_000, "/dashboard");
    const consumed = await store.consumeState(state);
    assert.equal(consumed?.state, state);
    assert.equal(consumed?.redirectTo, "/dashboard");
  });

  it("a state that was never created ('mismatch' - the browser presented something we never issued) returns null", async () => {
    const db = freshProductDb(["auth"]);
    const store = makeD1OAuthStore(makeD1(db));
    assert.equal(await store.consumeState("never-issued-state"), null);
  });

  it("replay: consuming the same state twice fails the second time", async () => {
    const db = freshProductDb(["auth"]);
    const store = makeD1OAuthStore(makeD1(db));
    const state = await store.createState(60_000);
    const first = await store.consumeState(state);
    const second = await store.consumeState(state);
    assert.ok(first);
    assert.equal(second, null, "a second use of the same state must be rejected");
  });

  it("expired: a state past its TTL is rejected even on first use", async () => {
    const db = freshProductDb(["auth"]);
    const store = makeD1OAuthStore(makeD1(db));
    const state = await store.createState(-1); // already expired
    assert.equal(await store.consumeState(state), null);
  });
});

describe("OAuthStore provider identity linkage - Part 7 (immutable id, renamed username)", () => {
  it("looks up by provider_user_id, not provider_login", async () => {
    const db = freshProductDb(["auth"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const oauthStore = makeD1OAuthStore(makeD1(db));
    const user = await productStore.createUser({ email: "a@example.com" });
    await oauthStore.linkProviderIdentity(user.id, "github", "12345", "old-username");

    const resolved = await oauthStore.getUserIdForProviderIdentity("github", "12345");
    assert.equal(resolved, user.id);
  });

  it("a renamed GitHub username still resolves to the same DiffCI user after touchProviderLogin", async () => {
    const db = freshProductDb(["auth"]);
    const productStore = makeD1ProductStore(makeD1(db));
    const oauthStore = makeD1OAuthStore(makeD1(db));
    const user = await productStore.createUser({ email: "b@example.com" });
    await oauthStore.linkProviderIdentity(user.id, "github", "999", "old-name");

    await oauthStore.touchProviderLogin("github", "999", "new-name"); // GitHub username rename event

    const resolved = await oauthStore.getUserIdForProviderIdentity("github", "999"); // still looked up by the SAME numeric id
    assert.equal(resolved, user.id, "the rename must not break identity resolution");
  });

  it("an unlinked provider_user_id resolves to null", async () => {
    const db = freshProductDb(["auth"]);
    const oauthStore = makeD1OAuthStore(makeD1(db));
    assert.equal(await oauthStore.getUserIdForProviderIdentity("github", "never-linked"), null);
  });
});
