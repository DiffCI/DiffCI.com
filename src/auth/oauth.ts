/**
 * GitHub OAuth flow (Part 6/7) - pure, injectable-fetch logic decoupled from the Worker's HTTP layer,
 * same pattern as src/billing/lemonsqueezy.ts. GitHub's OAuth endpoints/response shapes here are from
 * GitHub's own well-documented, stable public OAuth API (docs.github.com/en/apps/oauth-apps) - unlike
 * Lemon Squeezy's docs, this was not blocked from direct verification and matches the standard,
 * long-stable GitHub OAuth Apps flow. The access token is NEVER returned to the browser (Part 6) - it
 * is used exactly once, server-side, inside handleGithubCallback(), to fetch the user's identity, and is
 * discarded immediately after (never persisted).
 */

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_USER_URL = "https://api.github.com/user";
const GITHUB_USER_EMAILS_URL = "https://api.github.com/user/emails";

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function buildGithubAuthorizeUrl(config: GithubOAuthConfig, state: string): string {
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("scope", "read:user user:email"); // only what's needed to identify the user - never repo/org scopes here (this is login, not the separate GitHub App installation flow)
  return url.toString();
}

interface GithubTokenResponse {
  access_token?: string;
  token_type?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

interface GithubUserResponse {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
}

interface GithubEmailEntry {
  email: string;
  primary: boolean;
  verified: boolean;
}

export class GithubOAuthError extends Error {
  constructor(
    message: string,
    public readonly stage: "token_exchange" | "user_fetch",
  ) {
    super(message);
    this.name = "GithubOAuthError";
  }
}

/** Exchanges the authorization code for an access token. Throws GithubOAuthError on any failure
 * (network error, GitHub returning an `error` field, a non-2xx status) - callers must treat this as a
 * clean failure, never a partial success. */
export async function exchangeCodeForToken(config: GithubOAuthConfig, code: string, fetchFn: typeof fetch = fetch): Promise<string> {
  const res = await fetchFn(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "DiffCI" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri }),
  });
  if (!res.ok) throw new GithubOAuthError(`GitHub token exchange failed: HTTP ${res.status}`, "token_exchange");
  const body = (await res.json()) as GithubTokenResponse;
  if (body.error || !body.access_token) throw new GithubOAuthError(`GitHub token exchange failed: ${body.error ?? "no access_token in response"} ${body.error_description ?? ""}`.trim(), "token_exchange");
  return body.access_token;
}

export interface ResolvedGithubIdentity {
  providerUserId: string; // GitHub's numeric id, as a string - the immutable identity key (Part 7)
  providerLogin: string; // current username - display only
  email: string;
  name?: string;
}

/**
 * Fetches the user's GitHub identity using the access token, once. Prefers the primary verified email
 * from /user/emails (requires user:email scope); falls back to /user's own `email` field if that call
 * fails/returns nothing; falls back to GitHub's own noreply-email convention
 * (`{id}+{login}@users.noreply.github.com`) as a last resort so a NOT NULL users.email column always has
 * something usable - this is a synthesized placeholder identifier in that fallback case, not a claim
 * that it is a real, deliverable mailbox.
 */
export async function fetchGithubIdentity(accessToken: string, fetchFn: typeof fetch = fetch): Promise<ResolvedGithubIdentity> {
  const headers = { Authorization: `Bearer ${accessToken}`, Accept: "application/vnd.github+json", "User-Agent": "DiffCI" };
  const userRes = await fetchFn(GITHUB_USER_URL, { headers });
  if (!userRes.ok) throw new GithubOAuthError(`GitHub user fetch failed: HTTP ${userRes.status}`, "user_fetch");
  const user = (await userRes.json()) as GithubUserResponse;

  let email = user.email;
  if (!email) {
    try {
      const emailsRes = await fetchFn(GITHUB_USER_EMAILS_URL, { headers });
      if (emailsRes.ok) {
        const emails = (await emailsRes.json()) as GithubEmailEntry[];
        email = emails.find((e) => e.primary && e.verified)?.email ?? emails.find((e) => e.verified)?.email ?? null;
      }
    } catch {
      // best-effort only - fall through to the noreply placeholder below rather than failing the whole login
    }
  }
  if (!email) email = `${user.id}+${user.login}@users.noreply.github.com`;

  return { providerUserId: String(user.id), providerLogin: user.login, email, name: user.name ?? undefined };
}
