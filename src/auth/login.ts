/**
 * Orchestrates the full GitHub OAuth callback (Part 6, steps 4-9): validate state -> exchange code ->
 * fetch identity -> resolve/create user -> create session. Decoupled from the Worker's HTTP layer for
 * direct testability (tests/auth/login.test.ts), same pattern as billing's checkout.ts/portal.ts.
 */
import { exchangeCodeForToken, fetchGithubIdentity, type GithubOAuthConfig } from "./oauth.js";
import type { OAuthStore } from "./oauth-store.js";
import type { SessionStore } from "./sessions.js";
import type { ProductStore } from "../product/store.js";

export type GithubLoginOutcome =
  | { ok: true; userId: string; sessionId: string; rawSessionToken: string; sessionExpiresAt: string; redirectTo?: string; wasNewUser: boolean }
  | { ok: false; error: "invalid_or_replayed_state" | "token_exchange_failed" | "user_fetch_failed" };

export interface GithubLoginDeps {
  oauthConfig: GithubOAuthConfig;
  oauthStore: OAuthStore;
  sessionStore: SessionStore;
  productStore: ProductStore;
  sessionTtlMs: number;
  fetchFn?: typeof fetch;
}

export async function handleGithubCallback(deps: GithubLoginDeps, params: { state: string; code: string }): Promise<GithubLoginOutcome> {
  // Step 4 (Part 6): validate the returned state - single-use, expiry-checked (Part 11: mismatch/replay/expired all land here as one rejected outcome).
  const consumedState = await deps.oauthStore.consumeState(params.state);
  if (!consumedState) return { ok: false, error: "invalid_or_replayed_state" };

  // Step 5: exchange code server-side. The access token never leaves this function.
  let accessToken: string;
  try {
    accessToken = await exchangeCodeForToken(deps.oauthConfig, params.code, deps.fetchFn);
  } catch {
    return { ok: false, error: "token_exchange_failed" };
  }

  // Step 6: fetch GitHub identity.
  let identity;
  try {
    identity = await fetchGithubIdentity(accessToken, deps.fetchFn);
  } catch {
    return { ok: false, error: "user_fetch_failed" };
  }
  // accessToken is now discarded - nothing below this line references it, and it is never stored.

  // Step 7: resolve or create the local DiffCI user, keyed by GitHub's immutable numeric id (Part 7),
  // never by login (which can be renamed - keeping provider_login fresh on every login without changing
  // the lookup key handles a rename transparently: the same providerUserId still resolves to the same
  // DiffCI user, and the display name is simply refreshed).
  let userId = await deps.oauthStore.getUserIdForProviderIdentity("github", identity.providerUserId);
  let wasNewUser = false;
  if (userId) {
    await deps.oauthStore.touchProviderLogin("github", identity.providerUserId, identity.providerLogin);
  } else {
    const user = await deps.productStore.createUser({ email: identity.email, name: identity.name });
    await deps.oauthStore.linkProviderIdentity(user.id, "github", identity.providerUserId, identity.providerLogin);
    userId = user.id;
    wasNewUser = true;
  }

  // Step 8: create a DiffCI session.
  const { rawToken, session } = await deps.sessionStore.createSession(userId, deps.sessionTtlMs);

  return { ok: true, userId, sessionId: session.sessionId, rawSessionToken: rawToken, sessionExpiresAt: session.expiresAt, redirectTo: consumedState.redirectTo, wasNewUser };
}
